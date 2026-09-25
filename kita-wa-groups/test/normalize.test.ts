import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteCode, normalize, type NormalizeContext } from '../src/normalize.ts';

const G = '120363040000000001@g.us';
const ctx: NormalizeContext = {
  selfNumber: '14155550100',
  kitaNumbers: new Map([['639171234567', 'carmel@kita.ai'], ['639170000000', undefined]]),
  subject: (jid) => (jid === G ? 'Kita x Tala' : undefined),
};
const msg = (message: any, key: any = {}, extra: any = {}) => ({
  key: { remoteJid: G, id: 'ABC123', participant: '639181112222@s.whatsapp.net', ...key },
  message,
  pushName: 'Maria Santos',
  messageTimestamp: 1758000000,
  ...extra,
});

test('text from an external participant: customer, named by push name, labelled by the group subject', () => {
  const n = normalize(msg({ conversation: 'Hi Kita, the upload failed' }), ctx)!;
  assert.deepEqual(n.payload, {
    platform: 'whatsapp',
    channel_key: `whatsapp-group:${G}`,
    channel_label: 'Kita x Tala',
    event_id: `wag:${G}:ABC123`,
    user_key: '+639181112222',
    user_name: 'Maria Santos',
    contact_identifier: 'whatsapp:+639181112222',
    author: 'customer',
    text: 'Hi Kita, the upload failed',
    created_at: 1758000000,
  });
  assert.equal(n.media, undefined);
});

test('Kita staff numbers (with desk email), the dedicated number and fromMe show as Kita', () => {
  const staff = normalize(msg({ conversation: 'On it' }, { participant: '639171234567@s.whatsapp.net' }), ctx)!;
  assert.equal(staff.payload.author, 'staff');
  assert.equal(staff.payload.user_email, 'carmel@kita.ai');
  const noEmail = normalize(msg({ conversation: 'x' }, { participant: '639170000000:3@s.whatsapp.net' }), ctx)!;
  assert.equal(noEmail.payload.author, 'staff');
  assert.equal(noEmail.payload.user_email, undefined);
  const self = normalize(msg({ conversation: 'x' }, { fromMe: true, participant: undefined }), ctx)!;
  assert.equal(self.payload.author, 'staff');
  assert.equal(self.payload.user_key, '+14155550100');
});

test('LID-addressed groups use participantAlt for the phone number; without it the lid is the key', () => {
  const alt = normalize(msg({ conversation: 'x' }, { participant: '1234567890@lid', participantAlt: '639181112222@s.whatsapp.net' }), ctx)!;
  assert.equal(alt.payload.contact_identifier, 'whatsapp:+639181112222');
  const lid = normalize(msg({ conversation: 'x' }, { participant: '1234567890@lid' }), ctx)!;
  assert.equal(lid.payload.user_key, '1234567890@lid');
  assert.equal(lid.payload.contact_identifier, undefined);
  assert.equal(lid.payload.author, 'customer');
});

test('quoted reply -> thread root (in_reply_to on the bridge)', () => {
  const n = normalize(msg({ extendedTextMessage: { text: 'Same here', contextInfo: { stanzaId: 'ROOT1', participant: 'x@s.whatsapp.net' } } }), ctx)!;
  assert.deepEqual(n.payload.thread, { root: `wag:${G}:ROOT1`, reply: true });
});

test('media: image caption, document name, audio, video, sticker as image', () => {
  const img = normalize(msg({ imageMessage: { mimetype: 'image/jpeg', caption: 'screenshot', contextInfo: { stanzaId: 'Q' } } }), ctx)!;
  assert.equal(img.payload.text, 'screenshot');
  assert.deepEqual(img.media, { kind: 'image', mimetype: 'image/jpeg', fileName: 'image-ABC123.jpg' });
  assert.equal(img.payload.thread?.root, `wag:${G}:Q`);
  const doc = normalize(msg({ documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'statement.pdf', caption: 'May' } } } }), ctx)!;
  assert.deepEqual(doc.media, { kind: 'document', mimetype: 'application/pdf', fileName: 'statement.pdf' });
  assert.equal(doc.payload.text, 'May');
  assert.equal(normalize(msg({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }), ctx)!.media?.fileName, 'audio-ABC123.ogg');
  assert.equal(normalize(msg({ videoMessage: { mimetype: 'video/mp4' } }), ctx)!.media?.kind, 'video');
  assert.deepEqual(normalize(msg({ stickerMessage: {} }), ctx)!.media, { kind: 'sticker', mimetype: 'image/webp', fileName: 'sticker-ABC123.webp' });
});

test('reactions reply to the reacted message; removed reactions are skipped', () => {
  const r = normalize(msg({ reactionMessage: { text: '👍', key: { id: 'M9' } } }), ctx)!;
  assert.equal(r.payload.text, 'Reacted 👍');
  assert.equal(r.payload.thread?.root, `wag:${G}:M9`);
  assert.equal(normalize(msg({ reactionMessage: { text: '', key: { id: 'M9' } } }), ctx), null);
});

test('ephemeral wrappers unwrap; 1:1 chats, status, protocol and unknown messages are skipped', () => {
  assert.equal(normalize(msg({ ephemeralMessage: { message: { conversation: 'hidden' } } }), ctx)!.payload.text, 'hidden');
  assert.equal(normalize(msg({ conversation: 'dm' }, { remoteJid: '639181112222@s.whatsapp.net' }), ctx), null);
  assert.equal(normalize(msg({ conversation: 's' }, { remoteJid: 'status@broadcast' }), ctx), null);
  assert.equal(normalize(msg({ protocolMessage: { type: 0 } }), ctx), null);
  assert.equal(normalize(msg({ senderKeyDistributionMessage: {} }), ctx), null);
  assert.equal(normalize(msg(null), ctx), null);
});

test('unknown group subject falls back to a generic label; Long timestamps are read', () => {
  const n = normalize(msg({ conversation: 'x' }, { remoteJid: '999@g.us' }, { messageTimestamp: { low: 1758000001, high: 0, toNumber: () => 1758000001 } }), ctx)!;
  assert.equal(n.payload.channel_label, 'WhatsApp group');
  assert.equal(n.payload.created_at, 1758000001);
});

test('join validation: only chat.whatsapp.com invite links', () => {
  assert.equal(inviteCode('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'), 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(inviteCode('chat.whatsapp.com/invite/AbCdEfGhIjKlMnOpQrStUv/?utm=x'), 'AbCdEfGhIjKlMnOpQrStUv');
  for (const bad of ['', 'https://evil.com/AbCdEfGhIjKlMnOpQrStUv', 'https://chat.whatsapp.com/short', 'https://chat.whatsapp.com.evil.com/AbCdEfGhIjKlMnOpQrStUv', 42, undefined])
    assert.equal(inviteCode(bad), undefined, String(bad));
});
