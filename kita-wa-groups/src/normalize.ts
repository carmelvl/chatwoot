import { digits } from './config.ts';

/** The payload kita-bridges' POST /internal/inbound takes (normalised like every other platform). */
export interface InboundPayload {
  platform: 'whatsapp';
  channel_key: string;
  channel_label: string;
  event_id: string;
  user_key: string;
  user_name: string;
  /** whatsapp:+E164: the same desk contact as that person's 1:1 WhatsApp chats. */
  contact_identifier?: string;
  author: 'customer' | 'staff';
  user_email?: string;
  text: string;
  attachments: { url: string; name: string; content_type?: string; headers?: Record<string, string> }[];
  /** Quote / reaction target: bridge turns it into content_attributes.in_reply_to. */
  thread?: { root: string; reply: true };
  /** Unix seconds, when WhatsApp says it was sent. */
  created_at?: number;
  /** From WhatsApp history sync, not live. */
  backfill?: boolean;
}

export interface MediaRef {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string;
  fileName: string;
}

export interface NormalizeContext {
  /** The dedicated Kita number (digits), once paired. */
  selfNumber?: string;
  /** Kita staff numbers (digits) -> desk email (optional). */
  kitaNumbers: Map<string, string | undefined>;
  /** Group subject, the conversation label. */
  subject: (groupJid: string) => string | undefined;
}

export type Normalized = { payload: Omit<InboundPayload, 'attachments'>; media?: MediaRef };

export const channelKeyOf = (groupJid: string) => `whatsapp-group:${groupJid}`;
export const eventIdOf = (groupJid: string, messageId: string) => `wag:${groupJid}:${messageId}`;
export const isGroupJid = (jid?: string | null) => !!jid && jid.endsWith('@g.us');

/** "6391712345:12@s.whatsapp.net" -> "6391712345"; lid jids have no phone number. */
const phoneOf = (jid?: string | null) => (jid && /@(s\.whatsapp\.net|c\.us)$/.test(jid) ? digits(jid.split('@')[0].split(':')[0]) : undefined);

/** Unwraps ephemeral / view-once / edited / document-with-caption containers. */
export function unwrap(m: any): any {
  for (let i = 0; m && i < 5; i++) {
    const inner =
      m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) return m;
    m = inner;
  }
  return m;
}

const tsOf = (t: any): number | undefined => {
  if (t === undefined || t === null) return undefined;
  const n = typeof t === 'object' ? (typeof t.toNumber === 'function' ? t.toNumber() : Number(t.low ?? t)) : Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf' };
const nameFor = (kind: string, id: string, mimetype: string) => `${kind}-${id}.${EXT[mimetype.split(';')[0].trim()] ?? 'bin'}`;

/**
 * One Baileys WAMessage -> the bridge payload (+ the media to download), or null when it is not a group
 * message worth mirroring (status broadcasts, 1:1 chats, protocol / system stubs, empty reactions).
 */
export function normalize(msg: any, ctx: NormalizeContext): Normalized | null {
  const key = msg?.key;
  const group = key?.remoteJid;
  if (!isGroupJid(group) || !key.id || !msg.message) return null;
  const m = unwrap(msg.message);
  if (!m || m.protocolMessage) return null;

  let text = '';
  let media: MediaRef | undefined;
  let quoted: string | undefined;
  const ctxInfo = (x: any) => x?.contextInfo?.stanzaId as string | undefined;

  if (typeof m.conversation === 'string') text = m.conversation;
  else if (m.extendedTextMessage) {
    text = m.extendedTextMessage.text ?? '';
    quoted = ctxInfo(m.extendedTextMessage);
  } else if (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage) {
    const kind = (['image', 'video', 'audio', 'document', 'sticker'] as const).find((k) => m[`${k}Message`])!;
    const x = m[`${kind}Message`];
    const mimetype = x.mimetype || (kind === 'sticker' ? 'image/webp' : 'application/octet-stream');
    text = x.caption ?? '';
    quoted = ctxInfo(x);
    media = { kind, mimetype, fileName: x.fileName || nameFor(kind, key.id, mimetype) };
  } else if (m.reactionMessage) {
    const r = m.reactionMessage;
    if (!r.text || !r.key?.id) return null; // removed reaction
    text = `Reacted ${r.text}`;
    quoted = r.key.id;
  } else if (m.locationMessage) {
    const l = m.locationMessage;
    const where = [l.name, l.address].filter(Boolean).join(', ');
    text = `Location: ${where ? `${where} ` : ''}https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}`;
  } else if (m.contactMessage) text = `Contact: ${m.contactMessage.displayName ?? ''}`.trim();
  else if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const p = m.pollCreationMessage ?? m.pollCreationMessageV3;
    text = `Poll: ${p.name}\n${(p.options ?? []).map((o: any) => `- ${o.optionName}`).join('\n')}`;
  } else return null;
  if (!text && !media) return null;

  // Sender: the phone number when WhatsApp gives it (LID-addressed groups carry it in participantAlt).
  const participant = key.participant ?? msg.participant;
  const phone = key.fromMe ? ctx.selfNumber : phoneOf(key.participantAlt) ?? phoneOf(participant);
  const staff = !!phone && (phone === ctx.selfNumber || ctx.kitaNumbers.has(phone));
  const userKey = phone ? `+${phone}` : String(participant ?? 'unknown');
  const email = phone ? ctx.kitaNumbers.get(phone) : undefined;

  const payload: Normalized['payload'] = {
    platform: 'whatsapp',
    channel_key: channelKeyOf(group),
    channel_label: ctx.subject(group) || 'WhatsApp group',
    event_id: eventIdOf(group, key.id),
    user_key: userKey,
    user_name: (!key.fromMe && msg.pushName) || (phone ? `+${phone}` : 'WhatsApp user'),
    ...(phone ? { contact_identifier: `whatsapp:+${phone}` } : {}),
    author: staff ? 'staff' : 'customer',
    ...(staff && email ? { user_email: email } : {}),
    text,
    ...(quoted ? { thread: { root: eventIdOf(group, quoted), reply: true as const } } : {}),
    ...(tsOf(msg.messageTimestamp) ? { created_at: tsOf(msg.messageTimestamp) } : {}),
  };
  return media ? { payload, media } : { payload };
}

/**
 * Invite link -> invite code. Only https://chat.whatsapp.com/<code> links (optionally /invite/<code>,
 * trailing slash or query) are accepted; anything else is a 422.
 */
export function inviteCode(link: unknown): string | undefined {
  if (typeof link !== 'string') return undefined;
  const m = link.trim().match(/^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{16,32})\/?(?:\?[^\s]*)?$/);
  return m?.[1];
}
