import { hmacHex, safeEqual } from '../crypto.ts';
import { type InboundMessage, type OutboundMessage, type Sender } from '../types.ts';

/** Viber signs the raw body: X-Viber-Content-Signature = HEX(HMAC_SHA256(auth token, body)). */
export function verifyViberSignature(authToken: string, rawBody: string, signature?: string): boolean {
  if (!authToken || !signature) return false;
  return safeEqual(signature.toLowerCase(), hmacHex(authToken, rawBody));
}

export type ViberParsed = { kind: 'ignore'; reason: string } | { kind: 'message'; message: InboundMessage };

/** message_token is a 64-bit int; JSON.parse would round it, so read it from the raw body. */
export function viberMessageToken(rawBody: string): string | undefined {
  return rawBody.match(/"message_token"\s*:\s*"?(\d+)/)?.[1];
}

/** Viber is 1:1, so the user id is both the contact and the thread. */
export function parseViberEvent(payload: any, rawBody?: string): ViberParsed {
  if (payload?.event !== 'message') return { kind: 'ignore', reason: `event:${payload?.event}` };
  const s = payload.sender ?? {};
  const m = payload.message ?? {};
  if (!s.id) return { kind: 'ignore', reason: 'no_sender' };
  const attachments =
    m.media && ['picture', 'video', 'file'].includes(m.type)
      ? [{ url: m.media, name: m.file_name ?? `${m.type}-${payload.message_token}${m.type === 'picture' ? '.jpg' : m.type === 'video' ? '.mp4' : ''}` }]
      : [];
  let text: string = m.text ?? '';
  if (m.type === 'location' && m.location) text = `Location: https://maps.google.com/?q=${m.location.lat},${m.location.lon}`;
  if (m.type === 'contact' && m.contact) text = `Contact: ${m.contact.name ?? ''} ${m.contact.phone_number ?? ''}`.trim();
  if (m.type === 'url' && m.media) text = m.media;
  if (m.type === 'sticker') text = text || '[sticker]';
  return {
    kind: 'message',
    message: {
      platform: 'viber',
      eventId: (rawBody && viberMessageToken(rawBody)) || String(payload.message_token ?? `${s.id}:${payload.timestamp}`),
      userKey: s.id,
      userName: s.name,
      threadKey: s.id,
      replyRef: { receiver: s.id },
      text,
      attachments,
      conversationAttributes: { channel_key: `viber:${s.id}`, viber_country: String(s.country ?? '') },
    },
  };
}

const IMAGE_RE = /\.(jpe?g|png|gif)(\?|$)/i;

/** One Viber message per part: text first, then native picture/file messages (bridge media URLs, never Chatwoot's). */
export function buildViberMessages(replyRef: Record<string, unknown>, msg: OutboundMessage, sender: { name: string; avatar?: string }, sizes?: Record<string, number>) {
  const base = { receiver: replyRef.receiver as string, min_api_version: 1, sender: { name: sender.name.slice(0, 28), ...(sender.avatar ? { avatar: sender.avatar } : {}) } };
  const out: Record<string, unknown>[] = [];
  if (msg.text.trim()) out.push({ ...base, type: 'text', text: msg.text });
  for (const a of msg.attachments) {
    if (a.fileType === 'image' || IMAGE_RE.test(a.name)) out.push({ ...base, type: 'picture', text: '', media: a.url });
    else out.push({ ...base, type: 'file', media: a.url, file_name: a.name.slice(0, 256), size: sizes?.[a.url] ?? 0 });
  }
  return out;
}

export class ViberSender implements Sender {
  private token: string;
  private who: { name: string; avatar?: string };
  private fetchImpl: typeof fetch;
  /**
   * The one exception to "agents post only as themselves": a Viber bot is a single business identity
   * and Viber has no personal accounts for bots, so replies go out as the Kita bot, with no name prefix.
   */
  constructor(token: string, who: { name: string; avatar?: string }, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.who = who;
    this.fetchImpl = fetchImpl;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<void> {
    // Viber file messages require the byte size up front.
    const sizes: Record<string, number> = {};
    for (const a of msg.attachments) {
      if (a.fileType === 'image' || IMAGE_RE.test(a.name)) continue;
      const head = await this.fetchImpl(a.sourceUrl, { method: 'HEAD', redirect: 'follow' });
      sizes[a.url] = Number(head.headers.get('content-length') ?? 0);
    }
    for (const body of buildViberMessages(replyRef, msg, this.who, sizes)) {
      const res = await this.fetchImpl('https://chatapi.viber.com/pa/send_message', {
        method: 'POST',
        headers: { 'X-Viber-Auth-Token': this.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j: any = await res.json();
      if (j.status !== 0) throw new Error(`viber send_message: ${j.status} ${j.status_message}`);
    }
  }
}
