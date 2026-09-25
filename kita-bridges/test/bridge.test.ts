import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeInboundText, contactIdentifier } from '../src/bridge.ts';
import { parseSlackEvent } from '../src/platforms/slack.ts';
import { parseGraphMessage, parseResource } from '../src/platforms/teams/messages.ts';
import { parseViberEvent } from '../src/platforms/viber.ts';
import { Store } from '../src/store.ts';
import { fixture, makeBridge, PUBLIC_URL } from './helpers.ts';

const slackOpts = { botToken: 'xoxb', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };
const slackMsg = (name: string) => {
  const p = parseSlackEvent(fixture(name), slackOpts);
  if (p.kind !== 'message') throw new Error('not a message');
  return { ...p.message, userName: p.message.userKey === 'UCUST001' ? 'Ana (Customer Co)' : 'Ben (Customer Co)' };
};

test('mapping: one conversation per slack channel; the channel is the contact, each message is authored by its writer', async () => {
  const { bridge, cw, store } = makeBridge();
  assert.equal(await bridge.inbound(slackMsg('slack_top_level.json')), 'created');
  assert.equal(await bridge.inbound(slackMsg('slack_thread_reply.json')), 'appended');
  const paths = cw.calls.filter((c) => c.path.startsWith('/public')).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, [
    'POST /public/api/v1/inboxes/IN_SLACK/contacts', // the channel
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations',
    'POST /public/api/v1/inboxes/IN_SLACK/contacts', // Ana
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations/100/messages',
    'POST /public/api/v1/inboxes/IN_SLACK/contacts', // Ben
    'POST /public/api/v1/inboxes/IN_SLACK/contacts/src-1/conversations/100/messages',
  ]);
  assert.equal(cw.calls[0].body.identifier, 'slack-channel:slack:C0SHARED1');
  const [root, reply] = cw.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body);
  assert.equal(root.sender_identifier, 'slack:UCUST001');
  assert.deepEqual(root.content_attributes, { external_source: 'slack', external_thread: { root: 'C0SHARED1:1790000000.000100' } });
  // the thread reply is Ben's own message (no name prefix), natively replying to the root's desk message
  assert.equal(reply.content, 'screenshot attached');
  assert.equal(reply.sender_identifier, 'slack:UCUST002');
  assert.equal(reply['content_attributes[in_reply_to]'], '1');
  assert.equal(reply['content_attributes[external_thread][root]'], 'C0SHARED1:1790000000.000100');
  assert.equal(reply['content_attributes[external_source]'], 'slack');
  assert.deepEqual(reply.files, ['error.png']);
  assert.equal(reply.echo_id, 'slack:C0SHARED1:1790000050.000200');
  // the file download used the Slack bot token
  const dl = cw.calls.find((c) => c.path.includes('/files-pri/'));
  assert.ok(dl);
  assert.equal(store.getByConversation('slack', 100)?.threadKey, 'C0SHARED1');
  assert.deepEqual(store.getMessageByExt('slack', 'C0SHARED1:1790000050.000200'), { extId: 'C0SHARED1:1790000050.000200', deskId: 2, root: 'C0SHARED1:1790000000.000100' });
});

test('mapping: a resolved channel conversation is reopened by the next message, never replaced', async () => {
  const { bridge, cw } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json'));
  assert.equal(await bridge.outbound('slack', { event: 'conversation_status_changed', id: 100, status: 'resolved' }), 'status:resolved');
  const later = { ...slackMsg('slack_top_level.json'), eventId: 'C0SHARED1:1790009999.000100', thread: { root: 'C0SHARED1:1790009999.000100', reply: false } };
  assert.equal(await bridge.inbound(later), 'appended');
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/conversations')).length, 1);
  assert.match(cw.calls.at(-1)!.path, /conversations\/100\/messages$/);
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

const teamsChannelMsg = () => {
  const t = parseGraphMessage(fixture('graph_channel_reply_external.json'), parseResource(fixture('graph_notification_channel.json').value[0].resource)!, 'customer');
  if (t.kind !== 'message') throw new Error();
  return t;
};
const teamsChatMsg = (id: string) => {
  const t = parseGraphMessage({ ...fixture('graph_chat_message_guest.json'), id }, { kind: 'chat', chatId: '19:acme-group@thread.v2', messageId: id }, 'customer');
  if (t.kind !== 'message') throw new Error();
  return t.message;
};

test('outbound: "Reply to" posts into that message\'s thread; a plain reply is a new top-level channel message', async () => {
  const { bridge, senders } = makeBridge();
  const t = teamsChannelMsg();
  await bridge.inbound({ ...t.message, attachments: [] }); // conv 100, desk message 1
  await bridge.inbound(slackMsg('slack_top_level.json')); // conv 101, desk message 2
  await bridge.inbound(slackMsg('slack_thread_reply.json')); // desk message 3, in the same Slack thread
  const reply = (id: number, conversation: number, inReplyTo?: number) => ({
    ...fixture('chatwoot_outgoing.json'), id, conversation: { id: conversation }, ...(inReplyTo ? { content_attributes: { in_reply_to: inReplyTo } } : {}),
  });
  await bridge.outbound('teams', reply(9001, 100));
  await bridge.outbound('teams', reply(9002, 100, 1));
  await bridge.outbound('slack', reply(9101, 101));
  await bridge.outbound('slack', reply(9102, 101, 3)); // replying to a thread reply targets the thread root
  assert.deepEqual(senders.teams.sent.map((x) => x.ref), [
    { kind: 'channel', teamId: 'team-acme', channelId: '19:acme-shared@thread.tacv2' },
    { kind: 'channel', teamId: 'team-acme', channelId: '19:acme-shared@thread.tacv2', rootId: '1790000000000' },
  ]);
  assert.deepEqual(senders.slack.sent.map((x) => x.ref), [{ channel: 'C0SHARED1' }, { channel: 'C0SHARED1', threadTs: '1790000000.000100' }]);
  // platform isolation: a Slack inbox webhook can't send into a Teams conversation
  assert.equal(await bridge.outbound('slack', reply(9200, 100)), 'skip:unmapped_conversation');
});

test('outbound: the posted platform id maps back to the desk message, so replies to it thread natively', async () => {
  const { bridge, store, cw, senders } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json')); // conv 100
  senders.slack.send = async (ref, msg) => (senders.slack.sent.push({ ref, msg }), { echoes: ['C0SHARED1:1790000100.000100'] });
  await bridge.outbound('slack', { ...fixture('chatwoot_outgoing.json'), id: 9300, conversation: { id: 100 } });
  assert.deepEqual(store.getMessageByExt('slack', 'C0SHARED1:1790000100.000100'), { extId: 'C0SHARED1:1790000100.000100', deskId: 9300, root: 'C0SHARED1:1790000100.000100' });
  // a customer answers in the thread under the agent's top-level message
  await bridge.inbound({ ...slackMsg('slack_top_level.json'), eventId: 'C0SHARED1:1790000200.000100', thread: { root: 'C0SHARED1:1790000100.000100', reply: true } });
  assert.equal(cw.calls.at(-1)!.body.content_attributes.in_reply_to, 9300);
  // and a desk "Reply to" on that customer message goes into the agent's thread
  await bridge.outbound('slack', { ...fixture('chatwoot_outgoing.json'), id: 9301, conversation: { id: 100 }, content_attributes: { in_reply_to: 2 } });
  assert.deepEqual(senders.slack.sent.at(-1)!.ref, { channel: 'C0SHARED1', threadTs: '1790000100.000100' });
});

test('teams group chat: one conversation per chat, reopened (not replaced) after resolution', async () => {
  const { bridge, store, cw } = makeBridge();
  assert.equal(await bridge.inbound(teamsChatMsg('1')), 'created'); // conv 100
  assert.equal(await bridge.inbound(teamsChatMsg('2')), 'appended');
  assert.equal(await bridge.outbound('teams', { event: 'conversation_status_changed', id: 100, status: 'resolved' }), 'status:resolved');
  assert.equal(await bridge.inbound(teamsChatMsg('3')), 'appended');
  assert.equal(store.getByThread('teams', 'chat:19:acme-group@thread.v2')?.conversationId, 100);
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/conversations')).length, 1);
  // Teams channels: every thread lands in the channel's one conversation
  await bridge.inbound(teamsChannelMsg().message);
  assert.equal(await bridge.inbound({ ...teamsChannelMsg().message, eventId: 'x:2' }), 'appended');
});

test('sender echo ids are pre-marked, so our own Teams post coming back via Graph is dropped', async () => {
  const { bridge, senders } = makeBridge();
  await bridge.inbound(teamsChatMsg('1'));
  (senders.teams as any).send = async () => ({ echoes: ['19:acme-group@thread.v2:777'] });
  assert.equal(await bridge.outbound('teams', { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } }), 'sent');
  assert.equal(await bridge.inbound({ ...teamsChatMsg('777') }), 'duplicate');
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

test('every platform stamps channel_key on the conversation (Grip sync contract)', () => {
  const s = parseSlackEvent(fixture('slack_top_level.json'), slackOpts);
  assert.equal(s.kind === 'message' && s.message.conversationAttributes!.channel_key, 'slack:C0SHARED1');
  const v = parseViberEvent(fixture('viber_message.json'));
  assert.equal(v.kind === 'message' && v.message.conversationAttributes!.channel_key, 'viber:01234567890A=');
  assert.equal(teamsChannelMsg().message.conversationAttributes!.channel_key, 'teams:19:acme-shared@thread.tacv2');
  assert.equal(teamsChatMsg('1').conversationAttributes!.channel_key, 'teams:19:acme-group@thread.v2');
});
