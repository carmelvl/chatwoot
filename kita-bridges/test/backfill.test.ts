import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { Backfiller } from '../src/backfill.ts';
import { Bridge } from '../src/bridge.ts';
import { ChatwootAppClient, ChatwootClient, KitaDeskClient } from '../src/chatwoot.ts';
import { loadConfig } from '../src/config.ts';
import { hmacHex } from '../src/crypto.ts';
import { parseSlackEvent, SlackSender } from '../src/platforms/slack.ts';
import { SlackHistory } from '../src/platforms/slack-history.ts';
import { Graph } from '../src/platforms/teams/graph.ts';
import { TeamsHistory, teamsChannelKey } from '../src/platforms/teams/history.ts';
import { SenderClassifier } from '../src/platforms/teams/messages.ts';
import type { WhatsAppNumber } from '../src/platforms/whatsapp.ts';
import { ScopeCache, type ScopeCheck } from '../src/scope.ts';
import { CUSTOMERS, Store } from '../src/store.ts';
import { PUBLIC_URL } from './helpers.ts';

const PARSE = { botToken: 'xoxb', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };

/**
 * The desk, as the bridge sees it: the public inbox API (customer messages) and the Kita staff endpoint
 * (staff messages), in one ordered log. `failOn(n)` makes the n-th message create fail (500).
 */
function fakeDesk() {
  const messages: { via: 'public' | 'staff'; content: string; attrs: any; conversation: number; sender?: string }[] = [];
  const contacts = new Map<string, string>();
  let nextConv = 100;
  let nextMsg = 1;
  let failAt = 0;
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const p = url.pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (p === '/api/v1/kita/staff_messages') {
      if (failAt && messages.length + 1 === failAt) return new Response('boom', { status: 500 });
      messages.push({ via: 'staff', content: body.content, attrs: body.content_attributes, conversation: body.conversation_id, sender: body.email });
      return Response.json({ id: nextMsg++ });
    }
    if (/\/custom_attributes$/.test(p)) return Response.json({});
    if (/\/contacts$/.test(p)) {
      if (!contacts.has(body.identifier)) contacts.set(body.identifier, `src-${contacts.size + 1}`);
      return Response.json({ source_id: contacts.get(body.identifier) });
    }
    if (init.method === 'PATCH') return Response.json({});
    if (/\/conversations$/.test(p)) return Response.json({ id: nextConv++ });
    const m = p.match(/\/conversations\/(\d+)\/messages$/);
    if (m) {
      if (failAt && messages.length + 1 === failAt) return new Response('boom', { status: 500 });
      messages.push({ via: 'public', content: body.content, attrs: body.content_attributes, conversation: Number(m[1]), sender: body.sender_identifier });
      return Response.json({ id: nextMsg++ });
    }
    return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  return { messages, fetchImpl, failOn: (n: number) => { failAt = n; } };
}

function bridgeWorld(scope?: ScopeCheck) {
  const desk = fakeDesk();
  const store = new Store(':memory:');
  const bridge = new Bridge({
    store, chatwoot: new ChatwootClient('http://rails:3000', desk.fetchImpl), inbox: 'IN_CUSTOMERS', senders: {}, publicUrl: PUBLIC_URL,
    fetchImpl: desk.fetchImpl, app: new ChatwootAppClient('http://rails:3000', 'T', '1', desk.fetchImpl),
    desk: new KitaDeskClient('http://rails:3000', 'link-secret', desk.fetchImpl), scope,
  });
  return { desk, store, bridge };
}

// ---------- Slack ----------

const CH = 'C0GAJI';
const ROOT = '1700000002.000100';
/** conversations.history newest first, two pages; one thread with two replies; a bot post and a join notice. */
const HISTORY = [
  [
    { type: 'message', ts: '1700000006.000100', subtype: 'channel_join', user: 'UBOTKITA', text: 'joined' },
    { type: 'message', ts: '1700000005.000100', bot_id: 'B1', text: 'bot post' },
    { type: 'message', ts: ROOT, thread_ts: ROOT, reply_count: 2, user: 'UCUST', team: 'TCUST', text: 'thread root' },
  ],
  [{ type: 'message', ts: '1700000001.000100', user: 'UCUST', team: 'TCUST', text: 'hello *team*' }],
];
const REPLIES = [
  { type: 'message', ts: ROOT, thread_ts: ROOT, reply_count: 2, user: 'UCUST', team: 'TCUST', text: 'thread root' },
  // No team on this one: the user's workspace (users.info team_id) says it's Kita staff.
  { type: 'message', ts: '1700000003.000100', thread_ts: ROOT, user: 'UKITA', text: 'staff reply' },
  { type: 'message', ts: '1700000004.000100', thread_ts: ROOT, user: 'UCUST', team: 'TCUST', text: 'customer reply' },
];

function fakeSlack(o: { rateLimitOnce?: boolean; channels?: string[] } = {}) {
  const calls: string[] = [];
  let limited = !o.rateLimitOnce;
  const fetchImpl = (async (input: any) => {
    const url = new URL(String(input));
    const method = url.pathname.replace('/api/', '');
    calls.push(`${method}${url.searchParams.get('cursor') ? `#${url.searchParams.get('cursor')}` : ''}`);
    if (method === 'conversations.history') {
      if (!limited) {
        limited = true;
        return Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '3' } });
      }
      const page = url.searchParams.get('cursor') === 'p2' ? 1 : 0;
      return Response.json({ ok: true, messages: HISTORY[page], response_metadata: { next_cursor: page === 0 ? 'p2' : '' } });
    }
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: REPLIES, response_metadata: { next_cursor: '' } });
    if (method === 'users.info') {
      const u = url.searchParams.get('user');
      return Response.json({ ok: true, user: { name: u, team_id: u === 'UKITA' ? 'TKITA0001' : 'TCUST', profile: { real_name: u === 'UKITA' ? 'Rhea' : 'Dewi', email: u === 'UKITA' ? 'rhea@kita.ai' : undefined } } });
    }
    if (method === 'conversations.info') return Response.json({ ok: true, channel: { name: 'kita-gajigesa2' } });
    if (method === 'auth.test') return Response.json({ ok: true, user_id: 'UBOTKITA' });
    if (method === 'users.conversations') return Response.json({ ok: true, channels: (o.channels ?? [CH]).map((id) => ({ id })), response_metadata: { next_cursor: '' } });
    return Response.json({ ok: false, error: 'unknown_method' });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sender = new SlackSender('xoxb', () => undefined, fetchImpl);
  const history = new SlackHistory({
    botToken: 'xoxb', parse: PARSE, fetchImpl, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms),
    profile: (id) => sender.userProfile(id), channelName: (id) => sender.channelName(id),
  });
  return { calls, history, sleeps };
}

function slackWorld(o: { scope?: ScopeCheck; rateLimitOnce?: boolean } = {}) {
  const w = bridgeWorld(o.scope);
  const slack = fakeSlack(o);
  const backfiller = new Backfiller({ store: w.store, scope: o.scope, deliver: (m) => w.bridge.inbound(m), runners: { slack: slack.history.runner } });
  return { ...w, slack, backfiller, run: (force = false) => backfiller.request('slack', `slack:${CH}`, { channel: CH }, { force }) };
}

test('slack: member_joined_channel for our bot is parsed as a join (self), anyone else is not', () => {
  const ev = (user: string, auth = true) => ({ type: 'event_callback', ...(auth ? { authorizations: [{ user_id: 'UBOTKITA', is_bot: true }] } : {}), event: { type: 'member_joined_channel', user, channel: CH, channel_type: 'C' } });
  assert.deepEqual(parseSlackEvent(ev('UBOTKITA'), PARSE), { kind: 'joined', channel: CH, user: 'UBOTKITA', self: true });
  assert.deepEqual(parseSlackEvent(ev('UCUST'), PARSE), { kind: 'joined', channel: CH, user: 'UCUST', self: false });
  assert.equal((parseSlackEvent(ev('UBOTKITA', false), PARSE) as any).self, undefined, 'no authorizations: resolved later with auth.test');
});

test('slack: the join event reaches onSlackJoin over HTTP (acked 200 first)', async () => {
  const cfg = loadConfig();
  cfg.slack.signingSecret = 'slack-secret';
  cfg.slack.botToken = 'xoxb';
  const joins: any[] = [];
  const server = createServer(createHandler({ cfg, store: new Store(':memory:'), bridge: bridgeWorld().bridge, enabled: ['slack'], onSlackJoin: async (...a) => void joins.push(a) }));
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  const body = JSON.stringify({ type: 'event_callback', authorizations: [{ user_id: 'UBOTKITA', is_bot: true }], event: { type: 'member_joined_channel', user: 'UBOTKITA', channel: CH } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/events`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hmacHex('slack-secret', `v0:${ts}:${body}`)}` },
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(joins, [[CH, 'UBOTKITA', true]]);
});

test('slack backfill: whole history (paginated) + threads, oldest first, through the live path, with original timestamps', async () => {
  const w = slackWorld({ rateLimitOnce: true });
  assert.equal(await w.run(), 'completed');
  assert.deepEqual(w.desk.messages.map((m) => [m.via, m.content]), [
    ['public', 'hello **team**'],
    ['public', 'thread root'],
    ['staff', 'staff reply'],
    ['public', 'customer reply'],
  ]);
  const [hello, root, staff, reply] = w.desk.messages;
  assert.equal(hello.attrs.kita_backfill, true);
  assert.equal(hello.attrs.external_created_at, 1700000001.0001);
  assert.equal(hello.sender, 'slack:UCUST');
  assert.equal(root.attrs.external_thread.root, `${CH}:${ROOT}`);
  assert.equal(staff.sender, 'rhea@kita.ai', 'staff attribution from the Kita workspace, via the desk staff endpoint');
  assert.equal(staff.attrs.kita_backfill, true);
  assert.ok(staff.attrs.in_reply_to, 'thread reply points at the root desk message');
  assert.equal(reply.attrs.in_reply_to, staff.attrs.in_reply_to);
  assert.equal(hello.attrs.external_channel, '#kita-gajigesa2');
  // Rate limit: the 429 was retried after Retry-After (3s), and the second history page was fetched.
  assert.ok(w.slack.sleeps.includes(3000));
  assert.deepEqual(w.slack.calls.filter((c) => /^conversations\.(history|replies)/.test(c)), ['conversations.history', 'conversations.history', 'conversations.history#p2', 'conversations.replies']);
  const row = w.store.getBackfill(`slack:${CH}`)!;
  assert.equal(row.state, 'completed');
  assert.equal(row.imported, 4);
  assert.equal(row.cursor, '1700000004.000100');
  assert.ok(row.startedAt && row.completedAt);
  // Unlinked channel: its own channel: conversation (Unlinked in the desk).
  assert.ok(w.store.getByThread(CUSTOMERS, `channel:slack:${CH}`));
});

test('slack backfill: dedupes with live messages both ways, and a completed channel is not re-imported', async () => {
  const w = slackWorld();
  // A live message that is also in the history arrives first.
  const live = parseSlackEvent({ type: 'event_callback', event: { type: 'message', channel: CH, user: 'UCUST', team: 'TCUST', text: 'hello *team*', ts: '1700000001.000100' } }, PARSE);
  assert.equal(await w.bridge.inbound((live as any).message), 'created');
  w.store.pruneSeen(-1); // seen keys expire after a week; the message map still dedupes
  await w.run();
  assert.equal(w.desk.messages.filter((m) => m.content === 'hello **team**').length, 1);
  assert.equal(w.desk.messages.length, 4);
  // The live copy of a backfilled message (Slack retry) is a duplicate too.
  const retry = parseSlackEvent({ type: 'event_callback', event: { type: 'message', channel: CH, user: 'UCUST', team: 'TCUST', text: 'customer reply', ts: '1700000004.000100', thread_ts: ROOT } }, PARSE);
  assert.equal(await w.bridge.inbound((retry as any).message), 'duplicate');
  assert.equal(await w.run(), 'completed');
  assert.equal(w.desk.messages.length, 4, 'completed: nothing fetched or imported again');
  await w.run(true);
  assert.equal(w.desk.messages.length, 4, 'forced re-run: everything deduped');
});

test('slack backfill: an interrupted run resumes from its cursor without duplicates', async () => {
  const w = slackWorld();
  w.desk.failOn(3); // the desk fails on the third message
  assert.equal(await w.run(), 'failed');
  const failed = w.store.getBackfill(`slack:${CH}`)!;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.cursor, ROOT);
  assert.equal(failed.imported, 2);
  w.desk.failOn(0);
  assert.deepEqual(await w.backfiller.resumeUnfinished(), ['completed']);
  assert.deepEqual(w.desk.messages.map((m) => m.content), ['hello **team**', 'thread root', 'staff reply', 'customer reply']);
  assert.equal(w.store.getBackfill(`slack:${CH}`)!.imported, 4);
});

test('slack backfill: SCOPE_FILTER=on skips an out-of-scope channel and re-runs it once in scope', async () => {
  let out = [`slack:${CH}`];
  const scope = new ScopeCache({ filter: true, baseUrl: 'https://grip.example', apiKey: 'k', fetchImpl: (async () => Response.json({ in_scope: [], out_of_scope: out })) as typeof fetch });
  await scope.refresh();
  const w = slackWorld({ scope });
  assert.equal(await w.run(), 'skipped_out_of_scope');
  assert.equal(w.store.getBackfill(`slack:${CH}`)!.state, 'skipped_out_of_scope');
  assert.equal(w.desk.messages.length, 0);
  assert.equal(w.slack.calls.length, 0, 'nothing fetched from Slack');
  assert.deepEqual(await w.backfiller.rerunSkipped(), [], 'still out of scope: nothing re-run');
  out = [];
  await scope.refresh();
  assert.deepEqual(await w.backfiller.rerunSkipped(), ['completed']);
  assert.equal(w.desk.messages.length, 4);
});

test('slack backfill: SCOPE_FILTER off (default) imports an out-of-scope channel', async () => {
  const scope = new ScopeCache({ baseUrl: 'https://grip.example', apiKey: 'k', fetchImpl: (async () => Response.json({ in_scope: [], out_of_scope: [`slack:${CH}`] })) as typeof fetch });
  await scope.refresh();
  const w = slackWorld({ scope });
  assert.equal(await w.run(), 'completed');
  assert.equal(w.desk.messages.length, 4);
});

test('slack reconciliation: users.conversations lists every channel the bot is in; unknown ones are backfilled', async () => {
  const w = slackWorld();
  const channels = await w.slack.history.memberChannels();
  assert.deepEqual(channels, [CH]);
  assert.equal(w.backfiller.known(`slack:${CH}`), false);
  await w.run();
  assert.equal(w.backfiller.known(`slack:${CH}`), true);
  assert.equal(await w.slack.history.botUserId(), 'UBOTKITA');
});

test('backfill: BACKFILL_MAX_DAYS passes `oldest` to Slack', async () => {
  const w = bridgeWorld();
  const slack = fakeSlack();
  let oldest: string | null = null;
  const history = new SlackHistory({
    botToken: 'xoxb', parse: PARSE, minIntervalMs: 0, profile: async () => ({}), channelName: async () => undefined,
    fetchImpl: (async (u: any, i: any) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith('conversations.history')) oldest = url.searchParams.get('oldest');
      return (slack.history as any).fetchImpl(u, i);
    }) as typeof fetch,
  });
  const now = Date.parse('2026-09-25T00:00:00Z');
  const b = new Backfiller({ store: w.store, deliver: (m) => w.bridge.inbound(m), runners: { slack: history.runner }, maxDays: 30, now: () => now });
  await b.request('slack', `slack:${CH}`, { channel: CH });
  assert.equal(oldest, String((now - 30 * 86400_000) / 1000));
});

// ---------- Teams ----------

function fakeGraph(routes: Record<string, any>) {
  const calls: string[] = [];
  let throttled = false;
  const f = (async (input: any) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));
    calls.push(path + (url.searchParams.get('$skiptoken') ? `#${url.searchParams.get('$skiptoken')}` : ''));
    if (path.endsWith('/replies') && !throttled) {
      throttled = true;
      return Response.json({ error: { code: 'TooManyRequests', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '2' } });
    }
    const key = path + (url.searchParams.get('$skiptoken') ? `#${url.searchParams.get('$skiptoken')}` : '');
    const r = routes[key];
    if (r === undefined) return Response.json({ error: { code: 'NotFound', message: path } }, { status: 404 });
    return Response.json(r);
  }) as typeof fetch;
  return { calls, graph: new Graph({ accessToken: async () => 'AT' }, f) };
}

const guest = (id: string, text: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, messageType: 'message', createdDateTime: at, deletedDateTime: null, from: { user: { id: 'guest-lee', displayName: 'Lee Park', tenantId: 'acme-tenant' } },
  body: { contentType: 'text', content: text }, attachments: [], ...extra,
});

test('teams backfill: channel messages + replies (paginated, throttled), and a chat, oldest first through the live path', async () => {
  const w = bridgeWorld();
  const T = 'team-1';
  const C = '19:acme@thread.tacv2';
  const CHAT = '19:acme-group@thread.v2';
  const base = `/teams/${T}/channels/${C}/messages`;
  const g = fakeGraph({
    [base]: { value: [guest('m3', 'second root', '2026-09-20T10:00:00Z')], '@odata.nextLink': `https://graph.microsoft.com/v1.0${base}?$skiptoken=p2` },
    [`${base}#p2`]: { value: [guest('m1', 'first root', '2026-09-01T10:00:00Z')] },
    [`${base}/m1/replies`]: { value: [guest('m2', 'reply to first', '2026-09-02T10:00:00Z', { replyToId: 'm1' })] },
    [`${base}/m3/replies`]: { value: [] },
    [`/chats/${CHAT}/messages`]: { value: [guest('c2', 'chat later', '2026-09-10T00:00:00Z'), guest('c1', 'chat first', '2026-09-09T00:00:00Z'), { id: 's1', messageType: 'systemEventMessage', createdDateTime: '2026-09-08T00:00:00Z' }] },
    '/users/kita-user/chats': { value: [{ id: CHAT }] },
  });
  const sleeps: number[] = [];
  const classifier = new SenderClassifier(g.graph, { kitaUserId: () => 'kita-user', internalTenantIds: ['kita-tenant'] });
  const history = new TeamsHistory(g.graph, classifier, { minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
  const targets = await history.targets([`/users/kita-user/chats/getAllMessages`, `/teams/${T}/channels/${C}/messages`], 'kita-user');
  assert.deepEqual(targets, [{ kind: 'channel', teamId: T, channelId: C }, { kind: 'chat', chatId: CHAT }]);
  const b = new Backfiller({ store: w.store, deliver: (m) => w.bridge.inbound(m), runners: { teams: history.runner } });
  for (const t of targets) assert.equal(await b.request('teams', teamsChannelKey(t), t), 'completed');
  assert.deepEqual(w.desk.messages.map((m) => m.content), ['first root', 'reply to first', 'second root', 'chat first', 'chat later']);
  const [first, reply] = w.desk.messages;
  assert.equal(first.attrs.kita_backfill, true);
  assert.equal(first.attrs.external_created_at, Date.parse('2026-09-01T10:00:00Z') / 1000);
  assert.ok(reply.attrs.in_reply_to);
  assert.equal(reply.attrs.external_thread.root, `${C}:m1`);
  assert.ok(sleeps.includes(2000), '429 retried after Retry-After');
  assert.equal(w.store.getBackfill(`teams:${C}`)!.state, 'completed');
  assert.equal(w.store.getBackfill(`teams:${CHAT}`)!.imported, 2);
  // Re-discovery never re-imports.
  assert.equal(await b.request('teams', `teams:${CHAT}`, { kind: 'chat', chatId: CHAT }), 'completed');
  assert.equal(w.desk.messages.length, 5);
});

// ---------- WhatsApp: Meta's one-time history sync ----------

test('whatsapp: the coexistence `history` webhook is imported through the same path, oldest first, with original timestamps', async () => {
  const w = bridgeWorld();
  const numbers: WhatsAppNumber[] = [{ phoneNumberId: '111111111111111', ownerName: 'Carmel Limcaoco', agentEmail: 'carmel@kita.ai' }];
  const cfg = loadConfig();
  cfg.whatsapp = { appSecret: 'app-secret', verifyToken: 'vt', accessToken: 'WA', numbers };
  const server = createServer(createHandler({ cfg, store: w.store, bridge: w.bridge, enabled: ['whatsapp'], fetchImpl: w.desk.fetchImpl }));
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'history', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '639171234567', phone_number_id: '111111111111111' },
    history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: '639998887777', messages: [
      { from: '639171234567', to: '639998887777', id: 'wamid.H2', timestamp: '1780000100', type: 'text', text: { body: 'Approved!' }, history_context: { status: 'READ' } },
      { from: '639998887777', id: 'wamid.H1', timestamp: '1780000000', type: 'text', text: { body: 'Is my loan approved?' }, history_context: { status: 'READ' } },
    ] }] }],
  } }] }] });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/whatsapp/webhook`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex('app-secret', body)}` },
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(w.desk.messages.map((m) => [m.via, m.content, m.attrs.kita_backfill, m.attrs.external_created_at]), [
    ['public', 'Is my loan approved?', true, 1780000000],
    ['staff', 'Approved!', true, 1780000100],
  ]);
  assert.equal(w.desk.messages[1].sender, 'carmel@kita.ai', 'the business side is the number owner');
  // Replayed history (Meta retries) is deduped.
  await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/whatsapp/webhook`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex('app-secret', body)}` },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.desk.messages.length, 2);
});

// ---------- live messages are never marked as history ----------

test('live messages carry no kita_backfill / external_created_at (so the desk notifies and classifies as usual)', async () => {
  const w = bridgeWorld();
  const live = parseSlackEvent({ type: 'event_callback', event: { type: 'message', channel: CH, user: 'UCUST', team: 'TCUST', text: 'new', ts: '1790000000.000100' } }, PARSE);
  await w.bridge.inbound((live as any).message);
  assert.equal(w.desk.messages[0].attrs.kita_backfill, undefined);
  assert.equal(w.desk.messages[0].attrs.external_created_at, undefined);
});
