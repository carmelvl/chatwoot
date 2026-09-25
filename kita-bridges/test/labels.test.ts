import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackLabel, isPlaceholderLabel, labelOf } from '../src/bridge.ts';
import { namesLabel, teamsLabel } from '../src/platforms/teams/labels.ts';
import type { InboundMessage } from '../src/types.ts';

const graph = (routes: Record<string, unknown>) =>
  ({ request: async (_m: string, path: string) => {
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) throw new Error(`unexpected ${path}`);
    return hit[1];
  } }) as any;

test('teams labels: a channel is "Team › Channel"', async () => {
  const g = graph({ '/teams/T1/channels/': { displayName: 'Support' }, '/teams/T1?': { displayName: 'Acme' } });
  assert.equal(await teamsLabel(g, { kind: 'channel', teamId: 'T1', channelId: '19:abc@thread.tacv2' }, 'support@kita.ai'), 'Acme › Support');
});

test('teams labels: a group chat is its topic, else the members first names without the service account', async () => {
  assert.equal(await teamsLabel(graph({ '/chats/': { topic: 'Kredit x Kita' } }), { kind: 'chat', chatId: '19:c' }, 'x@kita.ai'), 'Kredit x Kita');
  const members = ['Jun Lim', 'Maria Reyes', 'Ana Cruz', 'Ben Tan'].map((displayName) => ({ displayName, email: `${displayName[0]}@c.com` }));
  const chat = { topic: null, members: [{ displayName: 'Kita Support', email: 'Support@Kita.ai' }, ...members] };
  assert.equal(await teamsLabel(graph({ '/chats/': chat }), { kind: 'chat', chatId: '19:c' }, 'support@kita.ai'), 'Jun, Maria & 2 others');
  assert.equal(namesLabel(['Jun Lim', 'Maria Reyes']), 'Jun & Maria');
  assert.equal(namesLabel(['Jun Lim', 'Maria Reyes', 'Ana Cruz']), 'Jun, Maria & Ana');
});

const msg = (over: Partial<InboundMessage>): InboundMessage =>
  ({ platform: 'teams', eventId: 'e', userKey: 'u', threadKey: 't', text: 'hi', attachments: [], author: 'customer', ...over }) as InboundMessage;

test('labels never show a raw platform:id key, and better labels replace placeholders', () => {
  assert.equal(labelOf(msg({}), 'teams:19:104cd490-413d'), 'Microsoft Teams chat');
  assert.equal(labelOf(msg({}), 'teams:19:104cd490-413d', 'teams:19:104cd490-413d', 'Acme › Support'), 'Acme › Support');
  assert.equal(labelOf(msg({}), 'teams:19:x', 'Acme › Support'), 'Acme › Support');
  assert.ok(isPlaceholderLabel('teams:19:x', 'teams') && isPlaceholderLabel(fallbackLabel('slack'), 'slack'));
  // WhatsApp: the profile name, else the number; a staff echo never renames it
  const wa = (userName: string, author: 'customer' | 'staff' = 'customer') => msg({ platform: 'whatsapp', userName, author });
  assert.equal(labelOf(wa('+639998887777'), 'whatsapp:+639998887777'), '+639998887777');
  assert.equal(labelOf(wa('Maria Santos'), 'whatsapp:+639998887777', '+639998887777'), 'Maria Santos');
  assert.equal(labelOf(wa('+639998887777', 'staff'), 'whatsapp:+639998887777', 'Maria Santos'), 'Maria Santos');
});

test('a Teams channel whose label Graph could not resolve yet is renamed once it can (contact + attributes)', async () => {
  const { makeBridge } = await import('./helpers.ts');
  let graphUp = false;
  const labeler = async (platform: string) => (platform === 'teams' && graphUp ? 'Acme › Support' : undefined);
  const { bridge, cw, store, appCalls } = makeBridge({ labeler });
  const teams = msg({
    eventId: '19:abc:1', threadKey: 'channel:T1:19:abc', replyRef: { kind: 'channel', teamId: 'T1', channelId: '19:abc' },
    conversationAttributes: { channel_key: 'teams:19:abc' }, userName: 'Jun Lim', channelConversation: true,
  });
  assert.equal(await bridge.inbound(teams), 'created');
  const contact = cw.calls.find((c) => c.path.endsWith('/contacts'))!;
  assert.equal(contact.body.name, 'Microsoft Teams chat', 'never the raw key');

  graphUp = true;
  await bridge.linkChannels();
  assert.equal(store.getChannel('teams:19:abc')?.label, 'Acme › Support');
  const rename = cw.calls.find((c) => c.method === 'PATCH')!;
  assert.deepEqual([rename.path.endsWith('/contacts/src-1'), rename.body], [true, { name: 'Acme › Support' }]);
  assert.equal(appCalls.at(-1)!.body.custom_attributes.channel_label, 'Acme › Support');
});

test('a desk conversation that no longer exists (404) is dropped, so attributes stop retrying', async () => {
  const { makeBridge } = await import('./helpers.ts');
  let gone = false;
  const { bridge, store, appCalls } = makeBridge({ appStatus: (path) => (gone && path.includes('/custom_attributes') ? 404 : 200) });
  const teams = msg({
    eventId: '19:gone:1', threadKey: 'channel:T1:19:gone', replyRef: { kind: 'channel', teamId: 'T1', channelId: '19:gone' },
    conversationAttributes: { channel_key: 'teams:19:gone' }, userName: 'Jun Lim', channelConversation: true,
  });
  assert.equal(await bridge.inbound(teams), 'created');
  const conversationId = store.getChannel('teams:19:gone')!.conversationId;
  store.deleteKv(`attrs:${conversationId}`);

  gone = true;
  await bridge.linkChannels();
  assert.equal(store.getChannel('teams:19:gone'), undefined);
  assert.equal(store.channelsFor(conversationId).length, 0);
  const calls = appCalls.length;
  await bridge.linkChannels();
  assert.equal(appCalls.length, calls, 'no retry once dropped');
});
