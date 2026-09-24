import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hmacHex } from '../src/crypto.ts';
import { buildViberMessages, parseViberEvent, verifyViberSignature, viberMessageToken } from '../src/platforms/viber.ts';
import { fixture, raw } from './helpers.ts';

test('viber signature: HMAC-SHA256 of raw body with auth token', () => {
  const body = raw('viber_message.json');
  assert.equal(verifyViberSignature('tok', body, hmacHex('tok', body)), true);
  assert.equal(verifyViberSignature('tok', body, hmacHex('tok', body).toUpperCase()), true);
  assert.equal(verifyViberSignature('other', body, hmacHex('tok', body)), false);
  assert.equal(verifyViberSignature('tok', body + '\n', hmacHex('tok', body)), false);
  assert.equal(verifyViberSignature('tok', body, undefined), false);
});

test('viber message_token keeps full 64-bit precision', () => {
  const body = raw('viber_message.json');
  assert.equal(viberMessageToken(body), '5741311803571721087');
  assert.notEqual(String(JSON.parse(body).message_token), '5741311803571721087'); // why we parse raw
  const p = parseViberEvent(JSON.parse(body), body);
  assert.equal(p.kind === 'message' && p.message.eventId, '5741311803571721087');
});

test('viber text message -> 1:1 thread keyed by user id', () => {
  const p = parseViberEvent(fixture('viber_message.json'));
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.equal(p.message.userKey, '01234567890A=');
  assert.equal(p.message.threadKey, '01234567890A=');
  assert.equal(p.message.userName, 'Maria Santos');
  assert.deepEqual(p.message.replyRef, { receiver: '01234567890A=' });
  assert.equal(p.message.text, 'Good morning, my loan status is not updating');
});

test('viber picture carries caption and media attachment', () => {
  const p = parseViberEvent(fixture('viber_picture.json'));
  assert.equal(p.kind === 'message' && p.message.text, 'here is the error');
  assert.equal(p.kind === 'message' && p.message.attachments[0].name, 'pic.jpg');
});

test('viber non-message events are acked and ignored', () => {
  assert.deepEqual(parseViberEvent(fixture('viber_webhook_check.json')), { kind: 'ignore', reason: 'event:webhook' });
  assert.deepEqual(parseViberEvent({ event: 'conversation_started', user: { id: 'x' } }), { kind: 'ignore', reason: 'event:conversation_started' });
});

test('viber outbound transform: text, then native picture and file messages as the Kita bot', () => {
  const msgs = buildViberMessages({ receiver: 'U1' }, {
    messageId: 1, conversationId: 1, text: 'Done', attachments: [
      { url: 'https://b/media/t1/steps.png', sourceUrl: 'https://cw/steps.png', name: 'steps.png', fileType: 'image' },
      { url: 'https://b/media/t2/guide.pdf', sourceUrl: 'https://cw/guide.pdf', name: 'guide.pdf', fileType: 'file' },
    ],
  }, { name: 'Kita' }, { 'https://b/media/t2/guide.pdf': 1234 });
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0], { receiver: 'U1', min_api_version: 1, sender: { name: 'Kita' }, type: 'text', text: 'Done' });
  assert.deepEqual([msgs[1].type, msgs[1].media], ['picture', 'https://b/media/t1/steps.png']);
  assert.deepEqual([msgs[2].type, msgs[2].media, msgs[2].file_name, msgs[2].size], ['file', 'https://b/media/t2/guide.pdf', 'guide.pdf', 1234]);
  assert.equal(buildViberMessages({ receiver: 'U1' }, { messageId: 1, conversationId: 1, text: 'x', attachments: [] }, { name: 'A very long sender name over 28 chars' })[0].sender.name.length, 28);
});
