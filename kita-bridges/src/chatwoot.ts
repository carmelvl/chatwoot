import { hmacHex, safeEqual } from './crypto.ts';
import type { InboundAttachment, OutboundMessage } from './types.ts';

const MAX_SKEW_S = 300;

/**
 * Verifies Chatwoot's API-channel webhook signature (lib/webhooks/trigger.rb):
 *   X-Chatwoot-Signature: sha256=HEX(HMAC_SHA256(inbox secret, "<X-Chatwoot-Timestamp>.<raw body>"))
 */
export function verifyChatwootSignature(
  secret: string,
  rawBody: string,
  headers: { signature?: string; timestamp?: string },
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const { signature, timestamp } = headers;
  if (!secret || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  return safeEqual(signature, `sha256=${hmacHex(secret, `${timestamp}.${rawBody}`)}`);
}

export type OutboundDecision = { send: true; message: OutboundMessage } | { send: false; reason: string };

/**
 * Decides whether a Chatwoot webhook payload is an agent reply that must go out to the customer.
 * Loop prevention: only `message_created` + `outgoing` + non-private messages pass. Everything the
 * bridge itself writes is `incoming` (public API), so it can never bounce back out.
 */
export function toOutbound(payload: any): OutboundDecision {
  if (payload?.event !== 'message_created') return { send: false, reason: `event:${payload?.event}` };
  if (payload.message_type !== 'outgoing') return { send: false, reason: `type:${payload.message_type}` };
  if (payload.private) return { send: false, reason: 'private_note' };
  // CSAT surveys (outgoing input_csat) carry a Chatwoot survey link; interactive types render as Chatwoot UI.
  if (payload.content_type && payload.content_type !== 'text') return { send: false, reason: `content_type:${payload.content_type}` };
  if (payload.content_attributes?.external_created_at || payload.content_attributes?.kita_bridge_origin)
    return { send: false, reason: 'external_echo' };
  const conversationId = Number(payload.conversation?.id ?? payload.conversation?.display_id);
  if (!conversationId) return { send: false, reason: 'no_conversation' };
  const attachments = (payload.attachments ?? [])
    .filter((a: any) => a?.data_url)
    .map((a: any) => ({ url: a.data_url, sourceUrl: a.data_url, name: a.file_name ?? a.data_url.split('/').pop()?.split('?')[0] ?? 'file', fileType: a.file_type }));
  const text = typeof payload.content === 'string' ? payload.content : '';
  if (/\/survey\/responses\//.test(text)) return { send: false, reason: 'survey_link' };
  if (!text.trim() && attachments.length === 0) return { send: false, reason: 'empty' };
  const s = payload.sender;
  const agent =
    s?.type === 'user' && s.id
      ? { id: Number(s.id), name: String(s.name ?? s.available_name ?? '').trim(), firstName: String(s.available_name ?? s.name ?? '').trim().split(/\s+/)[0], email: s.email }
      : undefined;
  const inReplyTo = Number(payload.content_attributes?.in_reply_to) || undefined;
  const channelKey = typeof payload.content_attributes?.kita_channel_key === 'string' && payload.content_attributes.kita_channel_key ? String(payload.content_attributes.kita_channel_key) : undefined;
  return {
    send: true,
    message: { messageId: Number(payload.id), conversationId, text, attachments, ...(agent?.name ? { agent } : {}), ...(inReplyTo ? { inReplyTo } : {}), ...(channelKey ? { channelKey } : {}) },
  };
}

/** Thin client for Chatwoot's public (inbox-identifier) client API. No agent token required. */
export class ChatwootClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async call(path: string, init: RequestInit): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}/public/api/v1/inboxes/${path}`, init);
    if (!res.ok) throw new Error(`chatwoot ${init.method} ${path.replace(/\/[^/]+$/, '/…')} -> ${res.status}`);
    return res.json();
  }

  private json(body: unknown): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  /**
   * Creates (or re-attaches, matched on identifier) a contact; returns the contact_inbox source_id.
   * Deliberately never sends email/phone: a contact without an email can never receive Chatwoot
   * email notifications or conversation-continuity emails (SendEmailNotificationService).
   */
  async createContact(inbox: string, contact: { identifier: string; name?: string; custom_attributes?: Record<string, string> }): Promise<string> {
    const { identifier, name, custom_attributes } = contact;
    const r = await this.call(`${inbox}/contacts`, this.json({ identifier, name, custom_attributes }));
    return r.source_id;
  }

  async createConversation(inbox: string, sourceId: string, customAttributes: Record<string, string> = {}): Promise<number> {
    const r = await this.call(`${inbox}/contacts/${sourceId}/conversations`, this.json({ custom_attributes: customAttributes }));
    return Number(r.id);
  }

  /** Incoming message; `senderIdentifier` attributes it to another contact of the inbox (Kita fork). Returns the desk id. */
  async createMessage(
    inbox: string,
    sourceId: string,
    conversationId: number,
    content: string,
    files: { blob: Blob; name: string }[] = [],
    echoId?: string,
    extra: { senderIdentifier?: string; contentAttributes?: MessageAttributes } = {},
  ): Promise<number> {
    const path = `${inbox}/contacts/${sourceId}/conversations/${conversationId}/messages`;
    const fields = { content, echo_id: echoId, sender_identifier: extra.senderIdentifier, content_attributes: extra.contentAttributes };
    const r = await this.call(path, files.length === 0 ? this.json(fields) : { method: 'POST', body: toForm(fields, files) });
    return Number(r.id);
  }
}

/** What the bridge records on every message it creates (see Kita::Bridge.message_attributes in the desk). */
export interface MessageAttributes {
  external_source?: string;
  /** Human label of the channel: "#kita-tala", "+63 917…", Teams channel/chat name. */
  external_channel?: string;
  external_channel_key?: string;
  external_thread?: { root: string };
  in_reply_to?: number;
  kita_bridge_origin?: boolean;
}

/** Multipart body with Rails-style nested keys (content_attributes[external_thread][root]). */
function toForm(fields: Record<string, unknown>, files: { blob: Blob; name: string }[]): FormData {
  const form = new FormData();
  const put = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) put(`${key}[${k}]`, x);
    else form.set(key, String(v));
  };
  for (const [k, v] of Object.entries(fields)) put(k, v);
  for (const f of files) form.append('attachments[]', f.blob, f.name);
  return form;
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** Downloads platform attachments; failures degrade to a link in the text rather than dropping the message. */
export async function downloadAttachments(atts: InboundAttachment[], fetchImpl: typeof fetch = fetch) {
  const files: { blob: Blob; name: string }[] = [];
  const failed: InboundAttachment[] = [];
  for (const a of atts) {
    try {
      const res = await fetchImpl(a.url, { headers: a.headers, redirect: 'follow' });
      if (!res.ok) throw new Error(String(res.status));
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('too_large');
      files.push({ blob: new Blob([buf], { type: a.contentType ?? res.headers.get('content-type') ?? 'application/octet-stream' }), name: a.name });
    } catch {
      failed.push(a);
    }
  }
  return { files, failed };
}

/**
 * Chatwoot Application API (agent-level token) for what the public inbox API can't do:
 * private notes to agents, outgoing messages for staff who typed directly in Slack/Teams,
 * Everything it writes carries content_attributes.kita_bridge_origin, which
 * toOutbound() refuses to send, so nothing it creates can bounce back out.
 */
export class ChatwootAppClient {
  private base: string;
  private token: string;
  private accountId: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: string, accountId: string, fetchImpl: typeof fetch = fetch) {
    this.base = `${baseUrl}/api/v1/accounts/${accountId}`;
    this.token = token;
    this.accountId = accountId;
    this.fetchImpl = fetchImpl;
  }

  async createMessage(
    conversationId: number,
    m: { content: string; private: boolean; files?: { blob: Blob; name: string }[]; contentAttributes?: MessageAttributes },
  ): Promise<{ id: number }> {
    const fields = { content: m.content, message_type: 'outgoing', private: m.private, content_attributes: { ...m.contentAttributes, kita_bridge_origin: true } };
    const init: RequestInit = m.files?.length
      ? { method: 'POST', body: toForm(fields, m.files), headers: { 'api-access-token': this.token } }
      : { method: 'POST', body: JSON.stringify(fields), headers: { 'content-type': 'application/json', 'api-access-token': this.token } };
    const res = await this.fetchImpl(`${this.base}/conversations/${conversationId}/messages`, init);
    if (!res.ok) throw new Error(`chatwoot app api messages -> ${res.status}`);
    const j: any = await res.json();
    return { id: Number(j.id) };
  }

  /** Every agent in the account (agents#index): id, email, name, confirmed, role. Throws on HTTP errors. */
  async listAgents(): Promise<{ id: number; email?: string; name?: string; confirmed?: boolean; role?: string; type?: string }[]> {
    const res = await this.fetchImpl(`${this.base}/agents`, { headers: { 'api-access-token': this.token } });
    if (!res.ok) throw new Error(`chatwoot app api agents -> ${res.status}`);
    const list: any = await res.json();
    return Array.isArray(list) ? list : [];
  }

  /** conversations#custom_attributes with merge=true: only the keys sent change (grip-sync's keys are kept). */
  async updateCustomAttributes(conversationId: number, attrs: Record<string, string>): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/conversations/${conversationId}/custom_attributes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-access-token': this.token },
      body: JSON.stringify({ custom_attributes: attrs, merge: true }),
    });
    if (!res.ok) throw new Error(`chatwoot app api custom_attributes -> ${res.status}`);
  }
}

/** Who a staff message is from: matched to a desk agent by email, else shown as themselves (Kita staff contact). */
export interface StaffIdentity {
  email?: string;
  /** Stable platform id, e.g. "slack:U123" (the staff contact's identity when there's no desk agent). */
  staffKey: string;
  name: string;
  avatarUrl?: string;
}

/**
 * Kita desk endpoint for Kita teammates writing directly in Slack/Teams (or from their WhatsApp phone):
 * the desk posts the message authored by the matching agent (email, with EMAIL_DOMAIN_ALIASES), or, with
 * no desk account, by a Kita-staff contact with their own name and avatar. Never the shared bridge user,
 * and the bridge never holds agent tokens.
 */
export class KitaDeskClient {
  private url: string;
  private secret: string;
  private fetchImpl: typeof fetch;

  private base: string;

  constructor(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch) {
    this.base = `${baseUrl}/api/v1/kita`;
    this.url = `${this.base}/staff_messages`;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async staffMessage(
    conversationId: number,
    who: StaffIdentity,
    m: { content: string; files?: { blob: Blob; name: string }[]; contentAttributes?: MessageAttributes },
  ): Promise<{ id: number }> {
    const fields = {
      conversation_id: conversationId, email: who.email, staff_key: who.staffKey, name: who.name, avatar_url: who.avatarUrl,
      content: m.content, content_attributes: m.contentAttributes,
    };
    const init: RequestInit = m.files?.length
      ? { method: 'POST', body: toForm(fields, m.files), headers: { 'x-kita-bridge-secret': this.secret } }
      : { method: 'POST', body: JSON.stringify(fields), headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': this.secret } };
    const res = await this.fetchImpl(this.url, init);
    if (!res.ok) throw new Error(`kita desk staff_messages -> ${res.status}`);
    const j: any = await res.json();
    return { id: Number(j.id) };
  }

  /**
   * Moves every message of `from` into `to` (display ids, same inbox), marks `from` merged_into and
   * resolves it. Idempotent on the desk side.
   */
  async mergeConversations(fromConversationId: number, toConversationId: number): Promise<{ moved: number }> {
    const res = await this.fetchImpl(`${this.base}/conversation_merges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': this.secret },
      body: JSON.stringify({ from_conversation_id: fromConversationId, to_conversation_id: toConversationId }),
    });
    if (!res.ok) throw new Error(`kita desk conversation_merges -> ${res.status}`);
    const j: any = await res.json().catch(() => ({}));
    return { moved: Number(j.moved ?? 0) };
  }
}
