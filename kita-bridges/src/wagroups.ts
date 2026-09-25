import type { InboundMessage, OutboundMessage, Sender, SendResult } from './types.ts';

/**
 * kita-wa-groups (WhatsApp groups via a dedicated linked-device number) delivers into the desk through
 * POST /internal/inbound, so threading, per-person senders, Kita vs External, dedupe, the Customers inbox
 * and Grip linking behave exactly like every other platform.
 */
export const WA_GROUP_KEY = /^whatsapp-group:[\w.-]+@g\.us$/;

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * The normalised payload -> InboundMessage, or undefined if it is not a valid WhatsApp-group message.
 * `created_at` (unix seconds) / `backfill` ride along as createdAt / backfill for the history-import work;
 * until that lands the desk stamps messages with the time they arrive.
 */
export function parseInternalInbound(b: any): (InboundMessage & { createdAt?: number; backfill?: boolean }) | undefined {
  if (!b || typeof b !== 'object' || b.platform !== 'whatsapp') return undefined;
  const channelKey = str(b.channel_key);
  const eventId = str(b.event_id);
  const userKey = str(b.user_key);
  if (!channelKey || !WA_GROUP_KEY.test(channelKey) || !eventId || !userKey) return undefined;
  if (b.author !== 'customer' && b.author !== 'staff') return undefined;
  if (typeof b.text !== 'string' || !Array.isArray(b.attachments)) return undefined;
  const attachments = b.attachments.filter((a: any) => str(a?.url) && str(a?.name));
  if (attachments.length !== b.attachments.length) return undefined;
  const groupJid = channelKey.slice('whatsapp-group:'.length);
  const root = str(b.thread?.root);
  return {
    platform: 'whatsapp',
    eventId,
    userKey,
    userName: str(b.user_name) ?? userKey,
    threadKey: channelKey,
    replyRef: { groupJid },
    text: b.text,
    attachments: attachments.map((a: any) => ({ url: a.url, name: a.name, contentType: str(a.content_type), headers: a.headers && typeof a.headers === 'object' ? a.headers : undefined })),
    conversationAttributes: { channel_key: channelKey, ...(str(b.channel_label) ? { channel_label: b.channel_label } : {}) },
    channelConversation: true,
    author: b.author,
    ...(str(b.user_email) ? { userEmail: b.user_email.toLowerCase() } : {}),
    ...(str(b.contact_identifier) ? { contactIdentifier: b.contact_identifier } : {}),
    ...(root ? { thread: { root, reply: true } } : {}),
    ...(Number.isFinite(b.created_at) && b.created_at > 0 ? { createdAt: Math.floor(b.created_at) } : {}),
    ...(b.backfill === true ? { backfill: true } : {}),
  };
}

/**
 * WA_GROUPS_SEND=on only: desk replies in a WhatsApp group go out as the dedicated Kita number via
 * kita-wa-groups. Off (default), WhatsApp groups stay mirror-only like every WhatsApp channel.
 */
export class WaGroupSender implements Sender {
  private url: string;
  private secret: string;
  private fetchImpl: typeof fetch;

  constructor(url: string, secret: string, fetchImpl: typeof fetch = fetch) {
    this.url = url.replace(/\/$/, '');
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<SendResult> {
    const text = [msg.text, ...msg.attachments.map((a) => a.url)].filter(Boolean).join('\n');
    const res = await this.fetchImpl(`${this.url}/wa-groups/internal/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': this.secret },
      body: JSON.stringify({ group_jid: replyRef.groupJid, text }),
    });
    if (!res.ok) throw new Error(`wa-groups send -> ${res.status}`);
    const { event_id: eventId } = (await res.json()) as { event_id: string };
    return { echoes: [eventId] };
  }
}

/** WA_GROUPS_SEND=on + WA_GROUPS_INTERNAL_URL + BRIDGE_LINK_SECRET -> the sender; otherwise none (mirror-only). */
export function waGroupSenderFromEnv(secret: string, env = process.env): WaGroupSender | undefined {
  if ((env.WA_GROUPS_SEND ?? 'off').trim() !== 'on' || !secret) return undefined;
  return new WaGroupSender((env.WA_GROUPS_INTERNAL_URL ?? 'http://wa-groups:8090').trim(), secret);
}
