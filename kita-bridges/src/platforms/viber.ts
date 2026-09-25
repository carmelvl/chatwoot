import { hmacHex, safeEqual } from '../crypto.ts';
import type { InboundMessage } from '../types.ts';

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
