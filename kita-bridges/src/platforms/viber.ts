import { hmacHex, safeEqual } from '../crypto.ts';
import type { InboundMessage, OutboundMessage, Sender } from '../types.ts';

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
      conversationAttributes: { viber_country: String(s.country ?? '') },
    },
  };
}

const IMAGE_RE = /\.(jpe?g|png|gif)(\?|$)/i;

export function buildViberMessages(replyRef: Record<string, unknown>, msg: OutboundMessage, sender: { name: string; avatar?: string }) {
  const base = { receiver: replyRef.receiver as string, min_api_version: 1, sender: { name: sender.name.slice(0, 28), ...(sender.avatar ? { avatar: sender.avatar } : {}) } };
  const out: Record<string, unknown>[] = [];
  const pictures = msg.attachments.filter((a) => a.fileType === 'image' || IMAGE_RE.test(a.name));
  const others = msg.attachments.filter((a) => !pictures.includes(a));
  const text = [msg.text, ...others.map((a) => `${a.name}: ${a.url}`)].filter((s) => s && s.trim()).join('\n');
  if (text) out.push({ ...base, type: 'text', text });
  for (const p of pictures) out.push({ ...base, type: 'picture', text: '', media: p.url });
  return out;
}

export class ViberSender implements Sender {
  private token: string;
  private who: { name: string; avatar?: string };
  private fetchImpl: typeof fetch;
  constructor(token: string, who: { name: string; avatar?: string }, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.who = who;
    this.fetchImpl = fetchImpl;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<void> {
    for (const body of buildViberMessages(replyRef, msg, this.who)) {
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
