import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hmacHex } from '../src/crypto.ts';
import { buildSlackPost, markdownToSlack, parseSlackEvent, SlackSender, slackToMarkdown, verifySlackSignature } from '../src/platforms/slack.ts';
import { fixture, raw } from './helpers.ts';

const opts = { botToken: 'xoxb-test', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };

test('slack signature: valid v0 signature accepted', () => {
  const body = raw('slack_top_level.json');
  const ts = '1790000000';
  const sig = `v0=${hmacHex('signing', `v0:${ts}:${body}`)}`;
  assert.equal(verifySlackSignature('signing', body, { signature: sig, timestamp: ts }, 1790000100), true);
});

test('slack signature: replay (>5 min), wrong secret, tampering rejected', () => {
  const body = raw('slack_top_level.json');
  const ts = '1790000000';
  const sig = `v0=${hmacHex('signing', `v0:${ts}:${body}`)}`;
  assert.equal(verifySlackSignature('signing', body, { signature: sig, timestamp: ts }, 1790000000 + 301), false);
  assert.equal(verifySlackSignature('nope', body, { signature: sig, timestamp: ts }, 1790000000), false);
  assert.equal(verifySlackSignature('signing', body.replace('401', '402'), { signature: sig, timestamp: ts }, 1790000000), false);
  assert.equal(verifySlackSignature('signing', body, { signature: sig }, 1790000000), false);
});

test('slack url_verification returns the challenge', () => {
  assert.deepEqual(parseSlackEvent(fixture('slack_url_verification.json'), opts), { kind: 'challenge', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
});

test('slack top-level message opens a thread keyed by channel + ts', () => {
  const p = parseSlackEvent(fixture('slack_top_level.json'), opts);
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.equal(p.message.threadKey, 'C0SHARED1:1790000000.000100');
  assert.deepEqual(p.message.replyRef, { channel: 'C0SHARED1', threadTs: '1790000000.000100' });
  assert.equal(p.message.userKey, 'UCUST001');
  assert.equal(p.message.eventId, 'Ev01TOP');
  assert.equal(p.message.text, 'Hi, our webhook fails with **401** since today & see [status page](https://status.example.com)');
});

test('slack thread reply maps to the root thread and carries authenticated file downloads', () => {
  const p = parseSlackEvent(fixture('slack_thread_reply.json'), opts);
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.equal(p.message.threadKey, 'C0SHARED1:1790000000.000100');
  assert.equal(p.message.attachments.length, 1);
  assert.equal(p.message.attachments[0].url, 'https://files.slack.com/files-pri/T-F01/download/error.png');
  assert.deepEqual(p.message.attachments[0].headers, { authorization: 'Bearer xoxb-test' });
});

test('slack loop prevention: bot echoes and Kita staff are ignored', () => {
  assert.deepEqual(parseSlackEvent(fixture('slack_bot_echo.json'), opts), { kind: 'ignore', reason: 'bot' });
  const self = fixture('slack_bot_echo.json');
  delete self.event.bot_id;
  assert.deepEqual(parseSlackEvent(self, opts), { kind: 'ignore', reason: 'self' });
  assert.deepEqual(parseSlackEvent(fixture('slack_internal_staff.json'), opts), { kind: 'ignore', reason: 'internal_user' });
  const edited = fixture('slack_top_level.json');
  edited.event.subtype = 'message_changed';
  assert.deepEqual(parseSlackEvent(edited, opts), { kind: 'ignore', reason: 'subtype:message_changed' });
});

test('slack channel allow-list', () => {
  assert.deepEqual(parseSlackEvent(fixture('slack_top_level.json'), { ...opts, allowedChannels: ['COTHER'] }), { kind: 'ignore', reason: 'channel_not_allowed' });
});

test('slack outbound transform: thread reply as the Kita bot, mrkdwn, no attachment links in text', () => {
  const post = buildSlackPost({ channel: 'C0SHARED1', threadTs: '1790000000.000100' }, {
    messageId: 1, conversationId: 42, text: 'We **fixed** it, see [docs](https://kita.ai/d)',
    attachments: [{ url: 'https://support.internal.kita.ai/bridges/media/t/a.pdf', sourceUrl: 'https://cw/a.pdf', name: 'a.pdf' }],
  }, { name: 'Kita', iconUrl: 'https://kita.ai/icon.png' });
  assert.equal(post.channel, 'C0SHARED1');
  assert.equal(post.thread_ts, '1790000000.000100');
  assert.equal(post.username, 'Kita');
  assert.equal(post.icon_url, 'https://kita.ai/icon.png');
  assert.equal(post.text, 'We *fixed* it, see <https://kita.ai/d|docs>');
});

test('slack sender: text then native file upload into the same thread (files v2)', async () => {
  const calls: string[] = [];
  const bodies: Record<string, any> = {};
  const f = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push(`${init.method ?? 'GET'} ${u.split('?')[0]}`);
    if (u.startsWith('https://cw/')) return new Response(new Uint8Array(5));
    if (u.includes('getUploadURLExternal')) { assert.match(u, /filename=guide\.pdf&length=5/); return Response.json({ ok: true, upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F9' }); }
    if (u.startsWith('https://files.slack.com/upload')) return new Response('OK');
    bodies[u.split('/').pop()!] = JSON.parse(init.body);
    return Response.json({ ok: true });
  }) as typeof fetch;
  await new SlackSender('xoxb', { name: 'Kita' }, f).send({ channel: 'C1', threadTs: '1.2' }, {
    messageId: 1, conversationId: 1, text: 'Here you go',
    attachments: [{ url: 'https://support.internal.kita.ai/bridges/media/t/guide.pdf', sourceUrl: 'https://cw/guide.pdf', name: 'guide.pdf' }],
  });
  assert.deepEqual(calls, [
    'POST https://slack.com/api/chat.postMessage',
    'GET https://cw/guide.pdf',
    'GET https://slack.com/api/files.getUploadURLExternal',
    'POST https://files.slack.com/upload/v1/x',
    'POST https://slack.com/api/files.completeUploadExternal',
  ]);
  assert.deepEqual(bodies['files.completeUploadExternal'], { files: [{ id: 'F9', title: 'guide.pdf' }], channel_id: 'C1', thread_ts: '1.2' });
  assert.equal(bodies['chat.postMessage'].username, 'Kita');
});

test('slack mrkdwn round trip helpers', () => {
  assert.equal(slackToMarkdown('<https://a.b>'), 'https://a.b');
  assert.equal(markdownToSlack('**x**'), '*x*');
});
