import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Graph, GraphAuth, GraphError, TEAMS_SCOPES } from '../src/platforms/teams/graph.ts';
import {
  buildCardMessage, buildHtmlMessage, filterNotifications, htmlToText, markdownToTeamsHtml, parseGraphMessage, parseResource,
  resolveNotification, SenderClassifier, sendPath, TeamsSender,
} from '../src/platforms/teams/messages.ts';
import { discoverResources, planSubscriptions, RENEW_BEFORE_MS, SUBSCRIPTION_LIFETIME_MS, SubscriptionManager } from '../src/platforms/teams/subscriptions.ts';
import { fixture } from './helpers.ts';

const NOW = Date.parse('2026-09-24T10:00:00Z');
const HOUR = 3600_000;
const staticAuth = { accessToken: async () => 'AT' };

/** Fake Graph: route table keyed by "METHOD path" (query stripped); records calls. */
function fakeGraph(routes: Record<string, (body: any, url: URL) => any>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const f = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const h = routes[`${method} ${path}`];
    if (!h) return Response.json({ error: { code: 'NotFound', message: path } }, { status: 404 });
    const out = h(body, url);
    if (out instanceof Response) return out;
    return out === undefined ? new Response(null, { status: 204 }) : Response.json(out, { status: method === 'POST' ? 201 : 200 });
  }) as typeof fetch;
  return { calls, graph: new Graph(staticAuth, f), fetchImpl: f };
}
const graphErr = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

// ---------- subscriptions ----------

test('renewal scheduling: create missing, renew inside the 12h window, drop undesired and expired', () => {
  const desired = ['/users/k/chats/getAllMessages', '/teams/t/channels/c1/messages', '/teams/t/channels/c2/messages'];
  const existing = [
    { id: 'fresh', resource: desired[0], clientState: 'x', expiresAt: NOW + 48 * HOUR },
    { id: 'soon', resource: desired[1], clientState: 'x', expiresAt: NOW + RENEW_BEFORE_MS - 1 },
    { id: 'gone', resource: '/teams/t/channels/old/messages', clientState: 'x', expiresAt: NOW + 48 * HOUR },
    { id: 'dead', resource: desired[2], clientState: 'x', expiresAt: NOW - 1 },
  ];
  const plan = planSubscriptions(desired, existing, NOW);
  assert.deepEqual(plan.create, [desired[2]]);
  assert.deepEqual(plan.renew.map((s) => s.id), ['soon']);
  assert.deepEqual(plan.remove.map((s) => s.id).sort(), ['dead', 'gone']);
  assert.deepEqual(planSubscriptions(desired.slice(0, 1), existing.slice(0, 1), NOW), { create: [], renew: [], remove: [] });
  assert.ok(SUBSCRIPTION_LIFETIME_MS <= 4320 * 60_000, 'must stay under the 3-day chatMessage cap');
});

test('sync creates subscriptions with lifecycle URL + random clientState, and renews via PATCH', async () => {
  const store = new Store(':memory:');
  let n = 0;
  const { calls, graph } = fakeGraph({
    'POST /subscriptions': (b) => ({ id: `sub-${++n}`, resource: b.resource, expirationDateTime: b.expirationDateTime }),
    'PATCH /subscriptions/sub-1': (b) => ({ id: 'sub-1', expirationDateTime: b.expirationDateTime }),
  });
  const urls = { notificationUrl: 'https://b/teams/notifications', lifecycleNotificationUrl: 'https://b/teams/lifecycle' };
  const mgr = new SubscriptionManager(graph, store, urls, async () => ['/users/k/chats/getAllMessages']);
  await mgr.sync(NOW);
  const post = calls.find((c) => c.method === 'POST')!.body;
  assert.equal(post.changeType, 'created');
  assert.equal(post.lifecycleNotificationUrl, urls.lifecycleNotificationUrl);
  assert.equal(post.includeResourceData, false);
  assert.ok(Date.parse(post.expirationDateTime) - NOW > HOUR && Date.parse(post.expirationDateTime) - NOW <= 4320 * 60_000);
  assert.ok(post.clientState.length >= 40);
  assert.equal(store.getSubscription('sub-1')?.clientState, post.clientState);
  assert.equal(mgr.verifyClientState('sub-1', post.clientState), true);

  await mgr.sync(NOW + 60 * HOUR); // inside the renewal window
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('409 on create replaces the orphaned Graph subscription (its clientState is unknown to us)', async () => {
  const store = new Store(':memory:');
  let first = true;
  const { calls, graph } = fakeGraph({
    'POST /subscriptions': (b) => (first ? ((first = false), graphErr(409, 'ExtensionError')) : { id: 'sub-new', resource: b.resource, expirationDateTime: b.expirationDateTime }),
    'GET /subscriptions': () => ({ value: [{ id: 'sub-orphan', resource: 'users/k/chats/getAllMessages' }] }),
    'DELETE /subscriptions/sub-orphan': () => undefined,
  });
  await new SubscriptionManager(graph, store, { notificationUrl: 'n', lifecycleNotificationUrl: 'l' }, async () => ['/users/k/chats/getAllMessages']).sync(NOW);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/subscriptions/sub-orphan'));
  assert.equal(store.listSubscriptions()[0].id, 'sub-new');
});

test('lifecycle events: reauthorizationRequired renews, subscriptionRemoved recreates, unknown ids ignored', async () => {
  const store = new Store(':memory:');
  store.putSubscription({ id: 'sub-channel-1', resource: '/teams/t/channels/c/messages', clientState: 'CLIENT_STATE_CHANNEL', expiresAt: NOW + HOUR });
  const { calls, graph } = fakeGraph({
    'PATCH /subscriptions/sub-channel-1': (b) => ({ id: 'sub-channel-1', expirationDateTime: b.expirationDateTime }),
    'POST /subscriptions': (b) => ({ id: 'sub-2', resource: b.resource, expirationDateTime: b.expirationDateTime }),
  });
  const mgr = new SubscriptionManager(graph, store, { notificationUrl: 'n', lifecycleNotificationUrl: 'l' }, async () => []);
  const ev = fixture('graph_lifecycle_reauth.json').value[0];
  assert.equal(await mgr.lifecycle(ev, NOW), 'renewed');
  assert.ok(store.getSubscription('sub-channel-1')!.expiresAt > NOW + 48 * HOUR);
  assert.equal(await mgr.lifecycle({ ...ev, lifecycleEvent: 'subscriptionRemoved' }, NOW), 'recreated');
  assert.equal(store.getSubscription('sub-2')?.resource, '/teams/t/channels/c/messages');
  assert.equal(await mgr.lifecycle({ subscriptionId: 'nope', lifecycleEvent: 'subscriptionRemoved' }, NOW), 'unknown_subscription');
  assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'POST']);
});

test('clientState rejection: wrong secret and unknown subscription ids are dropped', () => {
  const store = new Store(':memory:');
  store.putSubscription({ id: 'sub-channel-1', resource: 'r', clientState: 'CLIENT_STATE_CHANNEL', expiresAt: NOW + HOUR });
  const mgr = new SubscriptionManager(new Graph(staticAuth), store, { notificationUrl: 'n', lifecycleNotificationUrl: 'l' }, async () => []);
  const verify = (id?: string, cs?: string) => mgr.verifyClientState(id ?? '', cs ?? '');
  assert.deepEqual(filterNotifications(fixture('graph_notification_forged.json'), verify), { accepted: [], rejected: 2 });
  const good = filterNotifications(fixture('graph_notification_channel.json'), verify);
  assert.equal(good.accepted.length, 1);
  assert.equal(good.rejected, 0);
});

test('discovery: all chats via one user-level subscription + every Kita-hosted channel; foreign tenants skipped', async () => {
  const { graph } = fakeGraph({
    'GET /users/kita-user-id/teamwork/associatedTeams': () => ({ value: [
      { id: 'team-acme', tenantId: 'kita-tenant' }, { id: 'team-foreign', tenantId: 'other-tenant' }, { id: 'team-locked', tenantId: 'kita-tenant' },
    ] }),
    'GET /teams/team-acme/channels': () => ({ value: [{ id: '19:general@thread.tacv2' }, { id: '19:acme-shared@thread.tacv2', membershipType: 'shared' }] }),
    'GET /teams/team-locked/channels': () => graphErr(403, 'Forbidden'),
  });
  const r = await discoverResources(graph, { kitaUserId: 'kita-user-id', tenantId: 'kita-tenant', teamIds: [], extraChannels: ['team-x/19:extra@thread.tacv2'] });
  assert.deepEqual(r, [
    '/users/kita-user-id/chats/getAllMessages',
    '/teams/team-acme/channels/19:general@thread.tacv2/messages',
    '/teams/team-acme/channels/19:acme-shared@thread.tacv2/messages',
    '/teams/team-x/channels/19:extra@thread.tacv2/messages',
  ]);
});

// ---------- inbound ----------

test('parseResource handles channel roots, channel replies and chats', () => {
  assert.deepEqual(parseResource("teams('T')/channels('19:c@thread.tacv2')/messages('1')/replies('2')"), { kind: 'channel', teamId: 'T', channelId: '19:c@thread.tacv2', messageId: '2', replyToId: '1' });
  assert.deepEqual(parseResource("teams('T')/channels('19:c@thread.tacv2')/messages('1')"), { kind: 'channel', teamId: 'T', channelId: '19:c@thread.tacv2', messageId: '1' });
  assert.deepEqual(parseResource("chats('19:x@thread.v2')/messages('9')"), { kind: 'chat', chatId: '19:x@thread.v2', messageId: '9' });
  assert.equal(parseResource('users/abc'), undefined);
});

test('classification: Kita user and apps ignored; Kita staff -> staff messages; guests and other tenants are customers', async () => {
  const lookups: string[] = [];
  const { graph } = fakeGraph({
    'GET /users/guest-lee': () => (lookups.push('guest-lee'), { id: 'guest-lee', userType: 'Guest' }),
    'GET /users/staff-sam': () => (lookups.push('staff-sam'), { id: 'staff-sam', userType: 'Member', mail: null, userPrincipalName: 'Sam@kita.ai' }),
  });
  const c = new SenderClassifier(graph, { kitaUserId: () => 'kita-user-id', internalTenantIds: ['kita-tenant'] });
  assert.equal(await c.classify({ user: { id: 'kita-user-id', tenantId: 'kita-tenant' } }), 'self');
  assert.equal(await c.classify({ user: { id: 'acme-user-dana', tenantId: 'acme-tenant' } }), 'customer');
  assert.equal(await c.classify({ user: { id: 'guest-lee', tenantId: 'kita-tenant' } }), 'customer');
  assert.equal(await c.classify({ user: { id: 'staff-sam', tenantId: 'kita-tenant' } }), 'internal');
  assert.equal(await c.classify({ user: { id: 'staff-sam', tenantId: 'kita-tenant' } }), 'internal');
  assert.equal(await c.classify({ user: { id: 'ext-no-tenant' } }), 'customer'); // 404 in Kita's directory
  assert.equal(await c.classify({ application: { id: 'some-bot' } }), 'not_a_user');
  assert.deepEqual(lookups, ['guest-lee', 'staff-sam']); // cached
  assert.equal(c.email('staff-sam'), 'sam@kita.ai'); // UPN when there's no mail: matched to the desk agent
  assert.equal(c.email('guest-lee'), undefined);
  for (const kind of ['self', 'not_a_user'] as const)
    assert.deepEqual(parseGraphMessage(fixture('graph_chat_message_from_kita.json'), { kind: 'chat', chatId: 'c', messageId: '1' }, kind), { kind: 'ignore', reason: kind });
  const staff = parseGraphMessage(fixture('graph_chat_message_from_kita.json'), { kind: 'chat', chatId: 'c', messageId: '1' }, 'internal');
  assert.equal(staff.kind === 'message' && staff.message.author, 'staff');
  assert.deepEqual(parseGraphMessage(fixture('graph_system_event.json'), { kind: 'chat', chatId: 'c', messageId: '1' }, 'customer'), { kind: 'ignore', reason: 'type:systemEventMessage' });
});

test('channel reply -> the channel\'s conversation, thread root recorded; mention stripped; inline image + file captured', () => {
  const loc = parseResource(fixture('graph_notification_channel.json').value[0].resource)!;
  const p = parseGraphMessage(fixture('graph_channel_reply_external.json'), loc, 'customer');
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  const m = p.message;
  assert.equal(m.threadKey, 'channel:team-acme:19:acme-shared@thread.tacv2');
  assert.deepEqual(m.replyRef, { kind: 'channel', teamId: 'team-acme', channelId: '19:acme-shared@thread.tacv2' });
  assert.deepEqual(m.thread, { root: '19:acme-shared@thread.tacv2:1790000000000', reply: true });
  assert.equal(m.channelConversation, true);
  assert.equal(m.eventId, '19:acme-shared@thread.tacv2:1790000050000');
  assert.equal(m.text, 'payouts are delayed & stuck\nsee screenshot');
  assert.equal(m.userKey, 'acme-user-dana');
  assert.equal(m.userName, 'Dana Reyes');
  assert.match(m.attachments[0].url, /hostedContents\/aWQ9eF8x\/\$value$/);
  assert.equal(m.attachments[1].url, 'https://acme.sharepoint.com/sites/x/Shared%20Documents/log.txt');
});

test('group chat -> one conversation per chat (reopened, not replaced, after resolution)', () => {
  const p = parseGraphMessage(fixture('graph_chat_message_guest.json'), { kind: 'chat', chatId: '19:acme-group@thread.v2', messageId: '1790000100000' }, 'customer');
  assert.equal(p.kind === 'message' && p.message.threadKey, 'chat:19:acme-group@thread.v2');
  assert.equal(p.kind === 'message' && p.message.channelConversation, true);
  assert.equal(p.kind === 'message' && p.message.thread, undefined);
  assert.deepEqual(p.kind === 'message' && p.message.replyRef, { kind: 'chat', chatId: '19:acme-group@thread.v2' });
});

test('resolveNotification fetches the message by id (no encrypted payloads) and authorises hostedContent downloads', async () => {
  const { calls, graph } = fakeGraph({
    'GET /teams/team-acme/channels/19:acme-shared@thread.tacv2/messages/1790000000000/replies/1790000050000': () => fixture('graph_channel_reply_external.json'),
  });
  const classifier = new SenderClassifier(graph, { kitaUserId: () => 'kita-user-id', internalTenantIds: ['kita-tenant'] });
  const p = await resolveNotification(graph, classifier, fixture('graph_notification_channel.json').value[0]);
  assert.equal(calls.length, 1);
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.deepEqual(p.message.attachments[0].headers, { authorization: 'Bearer AT' });
  assert.equal(p.message.attachments[1].headers, undefined); // SharePoint link: no Graph token leaked
  assert.deepEqual(await resolveNotification(graph, classifier, { subscriptionId: 's', changeType: 'updated', resource: 'x' }), { kind: 'ignore', reason: 'change:updated' });
});

test('htmlToText', () => {
  assert.equal(htmlToText('<p>a&nbsp;<b>b</b></p><p>c</p>'), 'a b\nc');
});

// ---------- outbound ----------

const reply = {
  messageId: 1, conversationId: 7, text: 'We **fixed** it, see [guide](https://kita.ai/g) <script>',
  attachments: [
    { url: 'https://b/media/t1/steps.png', sourceUrl: 'https://cw/steps.png', name: 'steps.png', fileType: 'image' },
    { url: 'https://b/media/t2/guide.pdf', sourceUrl: 'https://cw/guide.pdf', name: 'guide.pdf', fileType: 'file' },
  ],
};

test('message transforms: escaped HTML with inline hostedContents; card fallback has no agent names', () => {
  assert.equal(markdownToTeamsHtml('a **b** *c*\n<x>'), 'a <strong>b</strong> <em>c</em><br>&lt;x&gt;');
  const html = buildHtmlMessage(reply, [{ contentType: 'image/png', base64: 'AAAA' }, undefined]);
  assert.equal(html.body.contentType, 'html');
  assert.equal(html.body.content, 'We <strong>fixed</strong> it, see <a href="https://kita.ai/g">guide</a> &lt;script&gt;<br><img src="../hostedContents/1/$value" alt="steps.png"><br><a href="https://b/media/t2/guide.pdf">guide.pdf</a>');
  assert.deepEqual(html.hostedContents, [{ '@microsoft.graph.temporaryId': '1', contentBytes: 'AAAA', contentType: 'image/png' }]);
  const card = buildCardMessage(reply);
  const content = JSON.parse(card.attachments[0].content);
  assert.equal(card.body.content, '<attachment id="kita-reply"></attachment>');
  assert.equal(content.type, 'AdaptiveCard');
  assert.deepEqual(content.actions, [{ type: 'Action.OpenUrl', title: 'guide.pdf', url: 'https://b/media/t2/guide.pdf' }]);
  assert.doesNotMatch(JSON.stringify(card), /chatwoot|active_storage|Carmel/i);
  assert.equal(sendPath({ kind: 'chat', chatId: '19:a@thread.v2' }), '/chats/19%3Aa%40thread.v2/messages');
  assert.equal(sendPath({ kind: 'channel', teamId: 'T', channelId: '19:c@thread.tacv2', rootId: '1' }), '/teams/T/channels/19%3Ac%40thread.tacv2/messages/1/replies');
  assert.equal(sendPath({ kind: 'channel', teamId: 'T', channelId: '19:c@thread.tacv2' }), '/teams/T/channels/19%3Ac%40thread.tacv2/messages'); // new top-level post
});

const imageFetch = (async (url: any) => (String(url).startsWith('https://cw/') ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) : new Response('x', { status: 404 }))) as typeof fetch;

test('sender: plain HTML reply into the channel thread as the Kita user; returns echo id for loop prevention', async () => {
  const { calls, graph } = fakeGraph({
    'POST /teams/T/channels/19:c@thread.tacv2/messages/1/replies': () => ({ id: '555' }),
  });
  const r = await new TeamsSender(graph, 'auto', imageFetch).send({ kind: 'channel', teamId: 'T', channelId: '19:c@thread.tacv2', rootId: '1' }, reply);
  assert.deepEqual(r, { echoes: ['19:c@thread.tacv2:555'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.hostedContents[0].contentBytes, Buffer.from([1, 2, 3]).toString('base64'));
});

test('sender: Adaptive Card fallback only when a channel rejects the HTML post; never for chats or auth errors', async () => {
  let attempt = 0;
  const ch = fakeGraph({ 'POST /teams/T/channels/C/messages/1/replies': (b) => (++attempt === 1 ? graphErr(403, 'Forbidden') : (assert.ok(b.attachments), { id: '9' })) });
  assert.deepEqual(await new TeamsSender(ch.graph, 'auto', imageFetch).send({ kind: 'channel', teamId: 'T', channelId: 'C', rootId: '1' }, reply), { echoes: ['C:9'] });
  assert.equal(ch.calls[1].body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');

  const chat = fakeGraph({ 'POST /chats/X/messages': () => graphErr(403, 'Forbidden') });
  await assert.rejects(new TeamsSender(chat.graph, 'auto', imageFetch).send({ kind: 'chat', chatId: 'X' }, reply), GraphError);
  assert.equal(chat.calls.length, 1);

  const auth = fakeGraph({ 'POST /teams/T/channels/C/messages/1/replies': () => graphErr(401, 'InvalidAuthenticationToken') });
  await assert.rejects(new TeamsSender(auth.graph, 'auto', imageFetch).send({ kind: 'channel', teamId: 'T', channelId: 'C', rootId: '1' }, reply));
  assert.equal(auth.calls.length, 1);

  const forced = fakeGraph({ 'POST /teams/T/channels/C/messages/1/replies': () => ({ id: '1' }) });
  await new TeamsSender(forced.graph, 'card', imageFetch).send({ kind: 'channel', teamId: 'T', channelId: 'C', rootId: '1' }, reply);
  assert.ok(forced.calls[0].body.attachments);
});

// ---------- one-time connect / tokens ----------

test('connect flow: only the Kita user is accepted; refresh token is stored encrypted and rotated', async () => {
  const store = new Store(':memory:');
  let who = 'someone@kita.ai';
  let rt = 0;
  const f = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.includes('/oauth2/v2.0/token')) {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get('scope'), TEAMS_SCOPES.join(' '));
      return Response.json({ access_token: `AT${rt}`, refresh_token: `RT-${++rt}`, expires_in: 1 });
    }
    if (u.endsWith('/me?$select=id,userPrincipalName,mail')) return Response.json({ id: 'kita-user-id', userPrincipalName: who });
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const auth = new GraphAuth({ tenantId: 'kita-tenant', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://b/teams/connect/callback', kitaUserUpn: 'Kita@kita.ai', encryptionKey: 'k'.repeat(32) }, store, f);
  const url = new URL(auth.authorizeUrl('st'));
  assert.equal(url.searchParams.get('login_hint'), 'Kita@kita.ai');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://b/teams/connect/callback');
  for (const s of ['offline_access', 'ChannelMessage.Send', 'ChatMessage.Send', 'ChannelMessage.Read.All', 'Chat.Read']) assert.ok(url.searchParams.get('scope')!.split(' ').includes(s));

  await assert.rejects(auth.completeConnect('code'), /expected Kita@kita.ai/);
  assert.equal(auth.isConnected(), false);
  who = 'kita@kita.ai';
  await auth.completeConnect('code');
  assert.equal(auth.isConnected(), true);
  assert.equal(auth.kitaUserId(), 'kita-user-id');
  const sealed = store.getKv('teams.refresh_token')!;
  assert.doesNotMatch(sealed, /RT-/);
  await auth.accessToken(); // expired (expires_in: 1) -> refresh grant -> rotated token stored
  assert.notEqual(store.getKv('teams.refresh_token'), sealed);
});
