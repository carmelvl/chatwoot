import { hmacHex, safeEqual } from '../crypto.ts';
import { withNamePrefix, type InboundAttachment, type InboundMessage, type OutboundMessage, type Sender } from '../types.ts';

/**
 * WhatsApp Business app coexistence (Cloud API on the same number the team keeps using in the
 * WhatsApp Business app). Customer messages arrive as `messages`; what a teammate sends from the
 * phone app arrives as `smb_message_echoes`. Default mode is a read-only mirror in the desk.
 */

export const GRAPH_FB = 'https://graph.facebook.com/v21.0';

export interface WhatsAppNumber {
  /** Cloud API phone number id (metadata.phone_number_id). */
  phoneNumberId: string;
  /** Chatwoot API inbox for this number (one inbox per teammate's number). */
  inboxIdentifier: string;
  webhookSecret: string;
  /** Kita team member who owns the phone, e.g. "Carmel Limcaoco". */
  ownerName: string;
  /** Optional: that agent's own Chatwoot access token, so echoes are attributed to them natively. */
  agentAccessToken?: string;
}

/** Cloud API webhook signature: X-Hub-Signature-256: sha256=HEX(HMAC_SHA256(app secret, raw body)). */
export function verifyWhatsAppSignature(appSecret: string, rawBody: string, header?: string): boolean {
  if (!appSecret || !header) return false;
  return safeEqual(header, `sha256=${hmacHex(appSecret, rawBody)}`);
}

/** GET handshake: hub.mode=subscribe & hub.verify_token match -> echo hub.challenge. */
export function verifyWhatsAppSubscription(verifyToken: string, q: URLSearchParams): string | undefined {
  if (q.get('hub.mode') !== 'subscribe' || !verifyToken) return undefined;
  const t = q.get('hub.verify_token') ?? '';
  return safeEqual(t, verifyToken) ? (q.get('hub.challenge') ?? '') : undefined;
}

/** Phone numbers become E.164; BSUIDs (Meta's business-scoped user ids, e.g. "IN.2081978709342942") pass through. */
export const e164 = (waId: string) => (/^\+?\d+$/.test(String(waId)) ? `+${String(waId).replace(/^\+/, '')}` : String(waId));
export const whatsappChannelKey = (waId: string) => `whatsapp:${e164(waId)}`;

/** A media part still to be resolved through GET /<media-id> (Cloud API media endpoint). */
export interface PendingMedia {
  mediaId: string;
  name: string;
  contentType?: string;
}

export interface ParsedWhatsApp {
  kind: 'customer' | 'echo';
  number: WhatsAppNumber;
  message: InboundMessage;
  media: PendingMedia[];
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
const EXT: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' };

/** Text + media of one Cloud API message object (shared by `messages` and `smb_message_echoes`). */
export function messageContent(m: any): { text: string; media: PendingMedia[] } | undefined {
  const t = m?.type;
  if (t === 'text') return { text: m.text?.body ?? '', media: [] };
  if ((MEDIA_TYPES as readonly string[]).includes(t) && m[t]?.id) {
    const part = m[t];
    return {
      text: part.caption ?? '',
      media: [{ mediaId: part.id, name: part.filename ?? `${t}-${m.id}.${String(part.mime_type ?? '').split('/')[1]?.split(';')[0] || EXT[t]}`, contentType: part.mime_type }],
    };
  }
  if (t === 'location') return { text: `Location: ${m.location?.name ? `${m.location.name} ` : ''}https://maps.google.com/?q=${m.location?.latitude},${m.location?.longitude}`, media: [] };
  if (t === 'contacts') return { text: `Contact: ${(m.contacts ?? []).map((c: any) => `${c.name?.formatted_name ?? ''} ${c.phones?.[0]?.phone ?? ''}`.trim()).join(', ')}`, media: [] };
  if (t === 'button') return { text: m.button?.text ?? '', media: [] };
  if (t === 'interactive') return { text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '', media: [] };
  if (t === 'reaction') return { text: m.reaction?.emoji ? `Reacted ${m.reaction.emoji}` : '', media: [] };
  return undefined; // unsupported / system / revoke / edit / unknown
}

/**
 * One webhook POST -> normalised customer messages and business echoes. Statuses, history and
 * smb_app_state_sync are acknowledged and counted but not mirrored (see README).
 */
export function parseWhatsAppWebhook(body: any, numbers: WhatsAppNumber[]) {
  const out: ParsedWhatsApp[] = [];
  const skipped: string[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      const number = numbers.find((n) => n.phoneNumberId === v.metadata?.phone_number_id);
      if (change.field === 'messages') {
        if (v.statuses?.length) skipped.push(`statuses:${v.statuses.length}`);
        if (!number) {
          if (v.messages?.length) skipped.push('unknown_number');
          continue;
        }
        const contact0 = v.contacts?.[0] ?? {};
        for (const m of v.messages ?? []) {
          const c = messageContent(m);
          // Phone when Meta sends it; BSUID only when the phone is withheld (usernames rollout).
          const who = m.from ?? contact0.wa_id ?? m.from_user_id ?? contact0.user_id;
          if (!c || !who) {
            skipped.push(`type:${m?.type}`);
            continue;
          }
          const name = (v.contacts ?? []).find((x: any) => x.wa_id === who || x.user_id === who)?.profile?.name;
          out.push({ kind: 'customer', number, media: c.media, message: base(number, who, m.id, c.text, name) });
        }
      } else if (change.field === 'smb_message_echoes') {
        if (!number) {
          skipped.push('unknown_number');
          continue;
        }
        for (const m of v.message_echoes ?? []) {
          const c = messageContent(m);
          const who = m.to ?? v.contacts?.[0]?.wa_id ?? m.to_user_id;
          if (!c || !who) {
            skipped.push(`echo_type:${m?.type}`); // revoke / edit are not mirrored
            continue;
          }
          out.push({ kind: 'echo', number, media: c.media, message: base(number, who, m.id, c.text) });
        }
      } else skipped.push(`field:${change.field}`); // history, smb_app_state_sync, ...
    }
  }
  return { items: out, skipped };
}

function base(number: WhatsAppNumber, customerWaId: string, id: string, text: string, name?: string): InboundMessage {
  return {
    platform: 'whatsapp',
    eventId: id, // wamid.* is globally unique
    userKey: `${number.phoneNumberId}:${customerWaId}`,
    userName: name || e164(customerWaId),
    contactIdentifier: whatsappChannelKey(customerWaId),
    inboxIdentifier: number.inboxIdentifier,
    threadKey: `${number.phoneNumberId}:${customerWaId}`,
    replyRef: { phoneNumberId: number.phoneNumberId, to: customerWaId },
    text,
    attachments: [],
    conversationAttributes: { channel_key: whatsappChannelKey(customerWaId), whatsapp_business_number: number.phoneNumberId },
    newConversationIfResolved: true,
  };
}

/** GET /<media-id> -> short-lived URL, downloaded with the same bearer token. */
export async function resolveMedia(media: PendingMedia[], token: string, fetchImpl: typeof fetch = fetch): Promise<InboundAttachment[]> {
  const out: InboundAttachment[] = [];
  for (const m of media) {
    const res = await fetchImpl(`${GRAPH_FB}/${m.mediaId}`, { headers: { authorization: `Bearer ${token}` } });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.url) continue; // falls through as a text-only message; logged by caller
    out.push({ url: j.url, name: m.name, contentType: j.mime_type ?? m.contentType, headers: { authorization: `Bearer ${token}` } });
  }
  return out;
}

/**
 * Only used with WHATSAPP_MODE=send: replies typed in the desk go out through Cloud API (text within
 * the 24h customer-service window; files as links). Default mode is mirror, where nothing is sent.
 */
export class WhatsAppSender implements Sender {
  private token: string;
  private prefix: boolean;
  private fetchImpl: typeof fetch;
  constructor(token: string, prefixAgentName = true, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.prefix = prefixAgentName;
    this.fetchImpl = fetchImpl;
  }

  async send(ref: Record<string, unknown>, original: OutboundMessage) {
    const msg = this.prefix ? withNamePrefix(original) : original;
    const body = [msg.text, ...msg.attachments.map((a) => `${a.name}: ${a.url}`)].filter((s) => s.trim()).join('\n');
    const res = await this.fetchImpl(`${GRAPH_FB}/${ref.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: ref.to, type: 'text', text: { body, preview_url: false } }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`whatsapp send: ${res.status} ${j.error?.message ?? ''}`);
    return { echoes: (j.messages ?? []).map((m: any) => m.id) };
  }
}
