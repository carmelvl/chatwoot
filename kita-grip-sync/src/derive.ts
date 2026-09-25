import type { ConversationState, Speaker } from './store.ts';

export const NOT_A_TICKET = 'not-a-ticket';
export const TICKET_LABEL = 'ticket';
export const OUT_OF_SCOPE_LABEL = 'out-of-scope';
const PLATFORMS = ['slack', 'teams', 'whatsapp', 'viber'] as const;

/** E.164: "+" then 8-15 digits. Accepts common formatting ("+63 917-123 4567") and "whatsapp:" prefixes. */
export function toE164(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const s = phone.trim().replace(/^whatsapp:/i, '');
  if (!s.startsWith('+')) return null; // Chatwoot stores contact phones in E.164; refuse to guess a country code
  const digits = s.slice(1).replace(/[\s().-]/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/**
 * channel_key per the contract:
 *  1. conversation custom attribute `channel_key` (set by kita-bridges for Slack/Teams/Viber);
 *  2. native WhatsApp inboxes (Channel::Whatsapp, or Twilio's WhatsApp medium): `whatsapp:<E.164 contact phone>`.
 * Anything else has no key and is not synced (logged instead).
 */
export function deriveChannelKey(conv: any): string | null {
  const attr = conv?.custom_attributes?.channel_key;
  if (typeof attr === 'string' && /^(slack|teams|whatsapp|viber):.+/.test(attr.trim())) return attr.trim();
  const channel = conv?.channel;
  const sourceId = String(conv?.contact_inbox?.source_id ?? '');
  const isWhatsapp = channel === 'Channel::Whatsapp' || (channel === 'Channel::TwilioSms' && sourceId.startsWith('whatsapp:'));
  if (!isWhatsapp) return null;
  const phone = toE164(conv?.meta?.sender?.phone_number) ?? toE164(sourceId.startsWith('whatsapp:') ? sourceId : `+${sourceId}`);
  return phone ? `whatsapp:${phone}` : null;
}

export function platformOf(channelKey: string | null): string | null {
  const p = channelKey?.split(':')[0];
  return p && (PLATFORMS as readonly string[]).includes(p) ? p : null;
}

/** Who has to act next. Resolved conversations wait on nobody; otherwise whoever did not speak last. */
export function waitingOn(status: string, lastSpeaker: Speaker | null): 'kita' | 'customer' | 'none' {
  if (status === 'resolved' || !lastSpeaker) return 'none';
  return lastSpeaker === 'customer' ? 'kita' : 'customer';
}

/**
 * Classifies a message_created payload for conversation bookkeeping.
 * Only public customer (incoming) and public Kita (outgoing/template) messages count. Private notes,
 * including this service's own ticket notes, and activity messages are ignored: they are invisible
 * to the customer, so they neither change who we wait on nor feed the classifier (loop safety).
 */
export function speakerOf(msg: any): Speaker | null {
  if (msg?.private) return null;
  const t = msg?.message_type;
  if (t === 'incoming' || t === 0) return 'customer';
  if (t === 'outgoing' || t === 'template' || t === 1 || t === 3) return 'kita';
  return null; // activity
}

/** Sender display name of a message_created payload (the person, even when the conversation contact is a channel). */
export function senderName(msg: any): string | null {
  const n = msg?.sender?.name;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : null;
}

/** True for a reply inside a Slack/Teams thread, as marked by kita-bridges. */
export function isThreadReply(msg: any): boolean {
  const ca = msg?.content_attributes ?? {};
  return ca.in_reply_to != null || ca.external_thread?.root != null;
}

/**
 * Desk id of the message's thread root: content_attributes.in_reply_to for a thread reply, else the message's own id.
 * String(root) is the Grip ticket issue_key: one ticket per thread.
 */
export function threadRootId(msg: any): number {
  const r = Number(msg?.content_attributes?.in_reply_to);
  return Number.isInteger(r) && r > 0 ? r : Number(msg?.id);
}

export function preview(content: unknown, attachments: unknown[] = [], max = 200): string {
  const text = typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';
  const out = text || (attachments.length ? `[${attachments.length} attachment${attachments.length > 1 ? 's' : ''}]` : '');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export function toIso(v: unknown): string {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export function chatwootUrl(publicUrl: string, accountId: number, conversationId: number): string {
  return `${publicUrl}/app/accounts/${accountId}/conversations/${conversationId}`;
}

/** Body for POST /api/v1/support/conversations. */
export function conversationBody(c: ConversationState, publicUrl: string) {
  return {
    chatwoot_conversation_id: c.id,
    channel_key: c.channelKey,
    platform: c.platform,
    channel_label: c.channelLabel,
    status: c.status,
    waiting_on: waitingOn(c.status, c.lastSpeaker),
    last_message_at: c.lastMessageAt,
    last_customer_message_at: c.lastCustomerMessageAt,
    last_message_preview: c.preview,
    message_count: c.messageCount,
    chatwoot_url: chatwootUrl(publicUrl, c.accountId, c.id),
  };
}
