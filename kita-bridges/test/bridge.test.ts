import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeInboundText, contactIdentifier } from '../src/bridge.ts';
import { parseSlackEvent } from '../src/platforms/slack.ts';
import { parseTeamsActivity } from '../src/platforms/teams.ts';
import { parseViberEvent } from '../src/platforms/viber.ts';
import { Store } from '../src/store.ts';
import { fixture, makeBridge, PUBLIC_URL } from './helpers.ts';

const slackOpts = { botToken: 'xoxb', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };
const slackMsg = (name: string) => {
  const p = parseSlackEvent(fixture(name), slackOpts);
  if (p.kind !== 'message') throw new Error('not a message');
  return { ...p.message, userName: p.message.userKey === 'UCUST001' ? 'Ana (Customer Co)' : 'Ben (Customer Co)' };
};

test('mapping: slack thread -> one conversation; first message creates contact + conversation', async () => {
  const { bridge, cw, store } = makeBridge();
  assert.equal(await bridge.inbound(slackMsg('slack_top_level.json')), 'created');
  assert.equal(await bridge.inbound(slackMsg('slack_thread_reply.json')), 'appended');
  const paths = cw.calls.filter((c) => c.path.startsWith('/public')).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, [
    'POST /public/api/v1/inboxes/IN_SLACK/contacts',
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations',
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations/100/messages',
    'POST /public/api/v1/inboxes/IN_SLACK/contacts', // second person in the thread gets their own contact...
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations/100/messages', // ...but posts into the thread's conversation
  ]);
  assert.equal(cw.calls[0].body.identifier, 'slack:UCUST001');
  const reply = cw.calls.at(-1)!.body;
  assert.equal(reply.content, '**Ben (Customer Co):** screenshot attached');
  assert.deepEqual(reply.files, ['error.png']);
  assert.equal(reply.echo_id, 'slack:Ev02REPLY');
  // the file download used the Slack bot token
  const dl = cw.calls.find((c) => c.path.includes('/files-pri/'));
  assert.ok(dl);
  assert.equal(store.getByConversation('slack', 100)?.threadKey, 'C0SHARED1:1790000000.000100');
});

test('idempotency: platform retries of the same event are not duplicated', async () => {
  const { bridge, cw } = makeBridge();
  const m = slackMsg('slack_top_level.json');
  assert.equal(await bridge.inbound(m), 'created');
  assert.equal(await bridge.inbound(m), 'duplicate');
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/messages')).length, 1);
});

test('failed inbound is retryable (seen key released)', async () => {
  const { bridge, cw } = makeBridge();
  const m = slackMsg('slack_top_level.json');
  const orig = cw.client.createConversation.bind(cw.client);
  cw.client.createConversation = async () => { throw new Error('chatwoot down'); };
  await assert.rejects(bridge.inbound(m));
  cw.client.createConversation = orig;
  assert.equal(await bridge.inbound(m), 'created');
});

test('attachment download failure degrades to a link instead of dropping the message', async () => {
  const { bridge, cw } = makeBridge();
  const m = { ...slackMsg('slack_top_level.json'), attachments: [{ url: 'https://fail.example/x.pdf', name: 'x.pdf' }] };
  await bridge.inbound(m);
  assert.match(cw.calls.at(-1)!.body.content, /Attachments \(not copied\):\n- https:\/\/fail\.example\/x\.pdf$/);
});

test('mapping: contacts are namespaced per platform', () => {
  assert.equal(contactIdentifier('viber', '01234567890A='), 'viber:01234567890A=');
  assert.equal(contactIdentifier('teams', 'aad-dana-0001'), 'teams:aad-dana-0001');
});

test('end to end: viber in, agent reply out to same user; private note and echo never go out', async () => {
  const { bridge, senders } = makeBridge();
  const p = parseViberEvent(fixture('viber_message.json'));
  if (p.kind !== 'message') throw new Error();
  await bridge.inbound(p.message); // conversation 100
  const reply = { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } };
  assert.equal(await bridge.outbound('viber', reply), 'sent');
  assert.deepEqual(senders.viber.sent[0].ref, { receiver: '01234567890A=' });
  // customer-facing attachment URLs are the bridge's media proxy, never Chatwoot's
  const out = senders.viber.sent[0].msg;
  for (const a of out.attachments) {
    assert.ok(a.url.startsWith(`${PUBLIC_URL}/media/`), a.url);
    assert.doesNotMatch(a.url, /rails|active_storage/);
  }
  assert.doesNotMatch(JSON.stringify({ text: out.text, urls: out.attachments.map((a) => a.url) }), /chatwoot|active_storage|survey/i);
  assert.equal(await bridge.outbound('viber', { ...fixture('chatwoot_csat.json'), conversation: { id: 100 } }), 'skip:content_type:input_csat');
  assert.equal(await bridge.outbound('viber', reply), 'skip:duplicate'); // Chatwoot webhook retry
  assert.equal(await bridge.outbound('viber', { ...fixture('chatwoot_private_note.json'), conversation: { id: 100 } }), 'skip:private_note');
  assert.equal(await bridge.outbound('viber', { ...fixture('chatwoot_incoming_echo.json'), conversation: { id: 100 } }), 'skip:type:incoming');
  assert.equal(await bridge.outbound('viber', { ...fixture('chatwoot_outgoing.json'), conversation: { id: 999 } }), 'skip:unmapped_conversation');
  assert.equal(senders.viber.sent.length, 1);
});

test('end to end: teams reply goes to the stored conversation reference; slack reply goes into the thread', async () => {
  const { bridge, senders } = makeBridge();
  const t = parseTeamsActivity(fixture('teams_channel_mention.json'));
  if (t.kind !== 'message') throw new Error();
  await bridge.inbound({ ...t.message, attachments: [] }); // conv 100
  await bridge.inbound(slackMsg('slack_top_level.json')); // conv 101
  await bridge.outbound('teams', { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } });
  await bridge.outbound('slack', { ...fixture('chatwoot_outgoing.json'), id: 9100, conversation: { id: 101 } });
  assert.equal(senders.teams.sent[0].ref.conversationId, '19:abc@thread.tacv2;messageid=1790000000000');
  assert.deepEqual(senders.slack.sent[0].ref, { channel: 'C0SHARED1', threadTs: '1790000000.000100' });
  // platform isolation: a Slack inbox webhook can't send into a Teams conversation
  assert.equal(await bridge.outbound('slack', { ...fixture('chatwoot_outgoing.json'), id: 9200, conversation: { id: 100 } }), 'skip:unmapped_conversation');
});

test('failed send is retryable and surfaces the error (Chatwoot marks the message failed)', async () => {
  const { bridge, senders } = makeBridge();
  const p = parseViberEvent(fixture('viber_message.json'));
  if (p.kind !== 'message') throw new Error();
  await bridge.inbound(p.message);
  const reply = { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } };
  senders.viber.fail = true;
  await assert.rejects(bridge.outbound('viber', reply));
  senders.viber.fail = false;
  assert.equal(await bridge.outbound('viber', reply), 'sent');
});

test('store survives restart (file-backed)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = `${mkdtempSync(`${tmpdir()}/kb-`)}/db.sqlite`;
  const a = new Store(path);
  a.putConversation({ platform: 'teams', threadKey: 't', conversationId: 5, sourceId: 's', replyRef: { serviceUrl: 'u' } });
  a.close();
  const b = new Store(path);
  assert.deepEqual(b.getByConversation('teams', 5)?.replyRef, { serviceUrl: 'u' });
  b.close();
});

test('composeInboundText', () => {
  assert.equal(composeInboundText('hi', undefined, []), 'hi');
  assert.equal(composeInboundText('', 'Ben', ['https://x']), '**Ben:** \n\nAttachments (not copied):\n- https://x');
});
