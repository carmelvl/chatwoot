import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeInboundText, contactIdentifier } from '../src/bridge.ts';
import { parseSlackEvent } from '../src/platforms/slack.ts';
import { parseGraphMessage, parseResource } from '../src/platforms/teams/messages.ts';
import { parseViberEvent } from '../src/platforms/viber.ts';
import { Store } from '../src/store.ts';
import { parseWhatsAppWebhook } from '../src/platforms/whatsapp.ts';
import { MIRROR_NOTE } from '../src/bridge.ts';
import { fixture, makeBridge, PUBLIC_URL, staticScope } from './helpers.ts';

const slackOpts = { botToken: 'xoxb', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };
const slackMsg = (name: string) => {
  const p = parseSlackEvent(fixture(name), slackOpts);
  if (p.kind !== 'message') throw new Error('not a message');
  return { ...p.message, userName: p.message.userKey === 'UCUST001' ? 'Ana (Customer Co)' : 'Ben (Customer Co)' };
};

test('mapping: an unlinked slack channel is one conversation; the channel is the contact, each message is authored by its writer', async () => {
  const { bridge, cw, store } = makeBridge();
  assert.equal(await bridge.inbound(slackMsg('slack_top_level.json')), 'created');
  assert.equal(await bridge.inbound(slackMsg('slack_thread_reply.json')), 'appended');
  const paths = cw.calls.filter((c) => c.path.startsWith('/public')).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, [
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts', // the channel
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts/src-1/conversations',
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts', // Ana
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts/src-1/conversations/100/messages',
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts', // Ben
    'POST /public/api/v1/inboxes/IN_CUSTOMERS/contacts/src-1/conversations/100/messages',
  ]);
  assert.equal(cw.calls[0].body.identifier, 'slack-channel:slack:C0SHARED1');
  const [root, reply] = cw.calls.filter((c) => c.path.endsWith('/messages')).map((c) => c.body);
  assert.equal(root.sender_identifier, 'slack:UCUST001');
  assert.deepEqual(root.content_attributes, {
    external_source: 'slack', external_channel: 'Slack channel', external_channel_key: 'slack:C0SHARED1', external_thread: { root: 'C0SHARED1:1790000000.000100' },
  });
  // the thread reply is Ben's own message (no name prefix), natively replying to the root's desk message
  assert.equal(reply.content, 'screenshot attached');
  assert.equal(reply.sender_identifier, 'slack:UCUST002');
  assert.equal(reply['content_attributes[in_reply_to]'], '1');
  assert.equal(reply['content_attributes[external_thread][root]'], 'C0SHARED1:1790000000.000100');
  assert.equal(reply['content_attributes[external_source]'], 'slack');
  assert.equal(reply['content_attributes[external_channel_key]'], 'slack:C0SHARED1');
  assert.deepEqual(reply.files, ['error.png']);
  assert.equal(reply.echo_id, 'slack:C0SHARED1:1790000050.000200');
  // the file download used the Slack bot token
  const dl = cw.calls.find((c) => c.path.includes('/files-pri/'));
  assert.ok(dl);
  assert.equal(store.getByConversation('customers', 100)?.threadKey, 'channel:slack:C0SHARED1');
  assert.deepEqual(store.getMessageByExt('slack', 'C0SHARED1:1790000050.000200'), {
    extId: 'C0SHARED1:1790000050.000200', deskId: 2, root: 'C0SHARED1:1790000000.000100', channelKey: 'slack:C0SHARED1', platform: 'slack',
  });
});

test('mapping: a resolved conversation is reopened by the next message, never replaced', async () => {
  const { bridge, cw } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json'));
  assert.equal(await bridge.outbound({ event: 'conversation_status_changed', id: 100, status: 'resolved' }), 'status:resolved');
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

// ---------- one conversation per customer per platform ----------

const WA_NUMBERS = [{ phoneNumberId: '111111111111111', ownerName: 'Carmel Limcaoco' }];
const waMsg = () => ({ ...parseWhatsAppWebhook(fixture('wa_messages_text.json'), WA_NUMBERS).items[0].message, attachments: [] });
const TALA = { account_id: '42', account_name: 'Tala', in_scope: true, dri_email: 'carmel@kita.ai', dri_name: 'Carmel Limcaoco', phase: 'pilot', health: 'green' };
test('customer: one conversation per customer per platform; Slack and WhatsApp of one account are two conversations with two company contacts', async () => {
  const scope = staticScope({ 'slack:C0SHARED1': TALA, 'whatsapp:+639998887777': TALA });
  const { bridge, cw, store, appCalls } = makeBridge({ scope });
  assert.equal(await bridge.inbound({ ...slackMsg('slack_top_level.json'), conversationAttributes: { channel_key: 'slack:C0SHARED1', channel_label: '#kita-tala' } }), 'created');
  assert.equal(await bridge.inbound(waMsg()), 'created');
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/conversations')).length, 2);
  const companies = cw.calls.filter((c) => c.path.endsWith('/contacts') && c.body.identifier.startsWith('grip-account:')).map((c) => [c.body.identifier, c.body.name]);
  assert.deepEqual(companies, [['grip-account:42:slack', 'Tala'], ['grip-account:42:whatsapp', 'Tala']]);
  const created = cw.calls.find((c) => c.path.endsWith('/conversations'))!.body.custom_attributes;
  assert.deepEqual({ ...created, kita_channels: JSON.parse(created.kita_channels) }, {
    grip_account: 'Tala', grip_account_id: '42', account_owner: 'Carmel Limcaoco', account_owner_email: 'carmel@kita.ai',
    customer_stage: 'pilot', customer_health: 'green', channel_key: 'slack:C0SHARED1', channel_label: '#kita-tala', channel: 'slack',
    kita_channels: [{ key: 'slack:C0SHARED1', platform: 'slack', label: '#kita-tala', sendable: true }],
  });
  assert.equal(store.getByThread('customers', 'account:42:slack')?.conversationId, 100);
  assert.equal(store.getByThread('customers', 'account:42:whatsapp')?.conversationId, 101);
  const wa = cw.calls.filter((c) => c.path.endsWith('/messages')).at(-1)!;
  assert.match(wa.path, /conversations\/101\/messages$/);
  assert.deepEqual(wa.body.content_attributes, { external_source: 'whatsapp', external_channel: 'Maria Santos', external_channel_key: 'whatsapp:+639998887777' });
  // each conversation lists only its own platform's channels
  const waConv = cw.calls.filter((c) => c.path.endsWith('/conversations'))[1].body.custom_attributes;
  assert.deepEqual(JSON.parse(waConv.kita_channels).map((c: any) => c.key), ['whatsapp:+639998887777']);
  assert.equal(waConv.channel, 'whatsapp');
  assert.equal(appCalls.filter((c) => c.path === '/api/v1/accounts/1/conversations/100/custom_attributes').length, 0); // Slack conversation untouched
});

test('customer: several Slack channels of one account share the one "Tala · Slack" conversation', async () => {
  const scope = staticScope({ 'slack:C0SHARED1': TALA, 'slack:C0SHARED2': TALA });
  const { bridge, cw, store } = makeBridge({ scope });
  await bridge.inbound(slackMsg('slack_top_level.json'));
  const other = slackMsg('slack_top_level.json');
  assert.equal(await bridge.inbound({
    ...other, eventId: 'C0SHARED2:1790000000.000100', threadKey: 'C0SHARED2', replyRef: { channel: 'C0SHARED2' },
    thread: { root: 'C0SHARED2:1790000000.000100', reply: false }, conversationAttributes: { ...other.conversationAttributes, channel_key: 'slack:C0SHARED2', slack_channel: 'C0SHARED2' },
  }), 'appended');
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/conversations')).length, 1);
  assert.equal(store.getChannel('slack:C0SHARED2')?.conversationId, store.getByThread('customers', 'account:42:slack')?.conversationId);
});

test('customer: an unlinked channel gets its own conversation; once Grip links it, the scope refresh merges it into that platform\'s account conversation', async () => {
  const scope = staticScope({ 'slack:C0OTHER': TALA });
  const { bridge, cw, store, deskCalls, senders } = makeBridge({ scope });
  const linked = slackMsg('slack_top_level.json');
  await bridge.inbound({ ...linked, eventId: 'C0OTHER:1.0', threadKey: 'C0OTHER', replyRef: { channel: 'C0OTHER' }, thread: { root: 'C0OTHER:1.0', reply: false }, conversationAttributes: { ...linked.conversationAttributes, channel_key: 'slack:C0OTHER', slack_channel: 'C0OTHER' } }); // account:42:slack -> conv 100
  assert.equal(await bridge.inbound(slackMsg('slack_top_level.json')), 'created'); // unlinked -> channel conv 101
  assert.equal(cw.calls.find((c) => c.path.endsWith('/contacts') && c.body.identifier === 'slack-channel:slack:C0SHARED1')?.body.name, 'Slack channel');
  assert.equal(await bridge.linkChannels(), 0);
  scope.link('slack:C0SHARED1', TALA);
  assert.equal(await bridge.linkChannels(), 1);
  assert.deepEqual(deskCalls.map((c) => [c.path, c.body]), [['/api/v1/kita/conversation_merges', { from_conversation_id: 101, to_conversation_id: 100 }]]);
  assert.equal(store.getByThread('customers', 'channel:slack:C0SHARED1'), undefined);
  assert.equal(store.getChannel('slack:C0SHARED1')?.conversationId, 100);
  assert.equal(await bridge.linkChannels(), 0); // idempotent
  await bridge.inbound(slackMsg('slack_thread_reply.json'));
  const last = cw.calls.filter((c) => c.path.endsWith('/messages')).at(-1)!;
  assert.match(last.path, /conversations\/100\/messages$/);
  assert.equal(last.body['content_attributes[in_reply_to]'], '2');
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), attachments: [], id: 9500, conversation: { id: 100 }, content_attributes: { kita_channel_key: 'slack:C0SHARED1' } }), 'sent');
  assert.deepEqual(senders.slack.sent[0].ref, { channel: 'C0SHARED1' });
});

test('customer: a WhatsApp channel linked later merges into the WhatsApp account conversation, never the Slack one', async () => {
  const scope = staticScope({ 'slack:C0SHARED1': TALA });
  const { bridge, store, deskCalls, cw } = makeBridge({ scope });
  await bridge.inbound(slackMsg('slack_top_level.json')); // account:42:slack -> 100
  await bridge.inbound(waMsg()); // unlinked -> channel conv 101
  scope.link('whatsapp:+639998887777', TALA);
  assert.equal(await bridge.inbound({ ...waMsg(), eventId: 'wamid.later' }), 'appended');
  assert.deepEqual(deskCalls[0].body, { from_conversation_id: 101, to_conversation_id: 102 });
  assert.equal(cw.calls.find((c) => c.path.endsWith('/contacts') && c.body.identifier === 'grip-account:42:whatsapp')?.body.name, 'Tala');
  assert.equal(store.getByThread('customers', 'account:42:whatsapp')?.conversationId, 102);
  assert.equal(store.getByThread('customers', 'account:42:slack')?.conversationId, 100);
});

// ---------- outbound targeting ----------

async function slackWorld() {
  const scope = staticScope({ 'slack:C0SHARED1': TALA, 'slack:C0SHARED2': TALA });
  const w = makeBridge({ scope });
  await w.bridge.inbound(slackMsg('slack_top_level.json')); // conv 100, desk 1 (thread root in C0SHARED1)
  await w.bridge.inbound(slackMsg('slack_thread_reply.json')); // desk 2 (reply)
  const other = slackMsg('slack_top_level.json');
  await w.bridge.inbound({
    ...other, eventId: 'C0SHARED2:1790000500.000100', threadKey: 'C0SHARED2', replyRef: { channel: 'C0SHARED2' },
    thread: { root: 'C0SHARED2:1790000500.000100', reply: false }, conversationAttributes: { ...other.conversationAttributes, channel_key: 'slack:C0SHARED2', slack_channel: 'C0SHARED2' },
  }); // desk 3: C0SHARED2 is the most recently active channel
  return w;
}
const agentReply = (id: number, ca: Record<string, unknown> = {}, conv = 100) => ({ ...fixture('chatwoot_outgoing.json'), attachments: [], id, conversation: { id: conv }, content_attributes: ca });

test('outbound: "Reply to" goes into that message\'s channel and thread', async () => {
  const { bridge, senders } = await slackWorld();
  assert.equal(await bridge.outbound(agentReply(9001, { in_reply_to: 2 })), 'sent'); // a reply to a thread reply -> the thread root
  assert.deepEqual(senders.slack.sent[0].ref, { channel: 'C0SHARED1', threadTs: '1790000000.000100' });
});

test('outbound: kita_channel_key picks one of this conversation\'s channels (top level); no hint -> most recently active', async () => {
  const { bridge, senders } = await slackWorld();
  assert.equal(await bridge.outbound(agentReply(9003, { kita_channel_key: 'slack:C0SHARED1' })), 'sent');
  assert.deepEqual(senders.slack.sent[0].ref, { channel: 'C0SHARED1' });
  assert.equal(await bridge.outbound(agentReply(9004)), 'sent');
  assert.deepEqual(senders.slack.sent[1].ref, { channel: 'C0SHARED2' });
  // a channel of another conversation is never a target
  assert.equal(await bridge.outbound(agentReply(9005, { kita_channel_key: 'slack:COTHER' })), 'skip:unknown_channel');
});

test('outbound: a WhatsApp conversation is a mirror: nothing is sent, a private note once', async () => {
  const scope = staticScope({ 'whatsapp:+639998887777': TALA });
  const { bridge, senders, appCalls } = makeBridge({ scope });
  await bridge.inbound(waMsg()); // conv 100, desk 1
  const notes = () => appCalls.filter((c) => c.path.endsWith('/messages') && c.body.private);
  assert.equal(await bridge.outbound(agentReply(9006)), 'skip:mirror');
  assert.equal(await bridge.outbound(agentReply(9006)), 'skip:duplicate');
  assert.equal(await bridge.outbound(agentReply(9007, { in_reply_to: 1 })), 'skip:mirror');
  assert.deepEqual(notes().map((n) => [n.path, n.body.content]), [
    ['/api/v1/accounts/1/conversations/100/messages', MIRROR_NOTE.whatsapp],
    ['/api/v1/accounts/1/conversations/100/messages', MIRROR_NOTE.whatsapp],
  ]);
  assert.equal(senders.slack.sent.length + senders.teams.sent.length, 0);
});

test('outbound: agent reply out with proxied media; private note, csat, echo and unmapped never go out', async () => {
  const { bridge, senders } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json')); // conversation 100
  const reply = { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } };
  assert.equal(await bridge.outbound(reply), 'sent');
  assert.deepEqual(senders.slack.sent[0].ref, { channel: 'C0SHARED1' });
  // customer-facing attachment URLs are the bridge's media proxy, never Chatwoot's
  const out = senders.slack.sent[0].msg;
  for (const a of out.attachments) {
    assert.ok(a.url.startsWith(`${PUBLIC_URL}/media/`), a.url);
    assert.doesNotMatch(a.url, /rails|active_storage/);
  }
  assert.doesNotMatch(JSON.stringify({ text: out.text, urls: out.attachments.map((a) => a.url) }), /chatwoot|active_storage|survey/i);
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_csat.json'), conversation: { id: 100 } }), 'skip:content_type:input_csat');
  assert.equal(await bridge.outbound(reply), 'skip:duplicate'); // Chatwoot webhook retry
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_private_note.json'), conversation: { id: 100 } }), 'skip:private_note');
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_incoming_echo.json'), conversation: { id: 100 } }), 'skip:type:incoming');
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), conversation: { id: 999 } }), 'skip:unmapped_conversation');
  assert.equal(senders.slack.sent.length, 1);
});

test('viber is a mirror: an unlinked Viber conversation never sends', async () => {
  const { bridge, senders } = makeBridge();
  const p = parseViberEvent(fixture('viber_message.json'));
  if (p.kind !== 'message') throw new Error();
  await bridge.inbound(p.message);
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } }), 'skip:mirror');
  assert.equal(senders.viber.sent.length, 0);
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

test('outbound: the posted platform id maps back to the desk message, so replies to it thread natively', async () => {
  const { bridge, store, cw, senders } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json')); // conv 100
  senders.slack.send = async (ref, msg) => (senders.slack.sent.push({ ref, msg }), { echoes: ['C0SHARED1:1790000100.000100'] });
  await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), id: 9300, conversation: { id: 100 } });
  assert.deepEqual(store.getMessageByExt('slack', 'C0SHARED1:1790000100.000100'), {
    extId: 'C0SHARED1:1790000100.000100', deskId: 9300, root: 'C0SHARED1:1790000100.000100', channelKey: 'slack:C0SHARED1', platform: 'slack',
  });
  // a customer answers in the thread under the agent's top-level message
  await bridge.inbound({ ...slackMsg('slack_top_level.json'), eventId: 'C0SHARED1:1790000200.000100', thread: { root: 'C0SHARED1:1790000100.000100', reply: true } });
  assert.equal(cw.calls.at(-1)!.body.content_attributes.in_reply_to, 9300);
  // and a desk "Reply to" on that customer message goes into the agent's thread
  await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), id: 9301, conversation: { id: 100 }, content_attributes: { in_reply_to: 2 } });
  assert.deepEqual(senders.slack.sent.at(-1)!.ref, { channel: 'C0SHARED1', threadTs: '1790000100.000100' });
});

test('teams group chat: one conversation per unlinked chat, reopened (not replaced) after resolution', async () => {
  const { bridge, store, cw } = makeBridge();
  assert.equal(await bridge.inbound(teamsChatMsg('1')), 'created'); // conv 100
  assert.equal(await bridge.inbound(teamsChatMsg('2')), 'appended');
  assert.equal(await bridge.outbound({ event: 'conversation_status_changed', id: 100, status: 'resolved' }), 'status:resolved');
  assert.equal(await bridge.inbound(teamsChatMsg('3')), 'appended');
  assert.equal(store.getByThread('customers', 'channel:teams:19:acme-group@thread.v2')?.conversationId, 100);
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/conversations')).length, 1);
  // Teams channels: every thread lands in the channel's one conversation
  await bridge.inbound(teamsChannelMsg().message);
  assert.equal(await bridge.inbound({ ...teamsChannelMsg().message, eventId: 'x:2' }), 'appended');
});

test('sender echo ids are pre-marked, so our own Teams post coming back via Graph is dropped', async () => {
  const { bridge, senders } = makeBridge();
  await bridge.inbound(teamsChatMsg('1'));
  (senders.teams as any).send = async () => ({ echoes: ['19:acme-group@thread.v2:777'] });
  assert.equal(await bridge.outbound({ ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } }), 'sent');
  assert.equal(await bridge.inbound({ ...teamsChatMsg('777') }), 'duplicate');
});

test('failed send is retryable and surfaces the error (Chatwoot marks the message failed)', async () => {
  const { bridge, senders } = makeBridge();
  await bridge.inbound(slackMsg('slack_top_level.json'));
  const reply = { ...fixture('chatwoot_outgoing.json'), conversation: { id: 100 } };
  senders.slack.fail = true;
  await assert.rejects(bridge.outbound(reply));
  senders.slack.fail = false;
  assert.equal(await bridge.outbound(reply), 'sent');
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
  assert.equal(composeInboundText('hi', []), 'hi');
  assert.equal(composeInboundText('', ['https://x']), 'Attachments (not copied):\n- https://x');
});

test('every platform stamps channel_key on the conversation (Grip sync contract)', () => {
  const s = parseSlackEvent(fixture('slack_top_level.json'), slackOpts);
  assert.equal(s.kind === 'message' && s.message.conversationAttributes!.channel_key, 'slack:C0SHARED1');
  const v = parseViberEvent(fixture('viber_message.json'));
  assert.equal(v.kind === 'message' && v.message.conversationAttributes!.channel_key, 'viber:01234567890A=');
  assert.equal(teamsChannelMsg().message.conversationAttributes!.channel_key, 'teams:19:acme-shared@thread.tacv2');
  assert.equal(teamsChatMsg('1').conversationAttributes!.channel_key, 'teams:19:acme-group@thread.v2');
});
