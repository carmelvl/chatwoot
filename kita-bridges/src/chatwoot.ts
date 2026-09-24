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
  return { send: true, message: { messageId: Number(payload.id), conversationId, text, attachments } };
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

  async createMessage(inbox: string, sourceId: string, conversationId: number, content: string, files: { blob: Blob; name: string }[] = [], echoId?: string): Promise<void> {
    const path = `${inbox}/contacts/${sourceId}/conversations/${conversationId}/messages`;
    if (files.length === 0) {
      await this.call(path, this.json({ content, echo_id: echoId }));
      return;
    }
    const form = new FormData();
    form.set('content', content);
    if (echoId) form.set('echo_id', echoId);
    for (const f of files) form.append('attachments[]', f.blob, f.name);
    await this.call(path, { method: 'POST', body: form });
  }
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
