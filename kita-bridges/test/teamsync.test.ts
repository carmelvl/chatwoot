import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/platforms/teams/graph.ts';
import { ScopeCache } from '../src/scope.ts';
import { Store } from '../src/store.ts';
import { ALL_HISTORY, parseTeamSyncMode, rosterHash, rosterSource, SlackMembership, TeamSync, TeamsMembership, type TeamSyncMode } from '../src/teamsync.ts';

const ROSTER = ['carmel@kita.ai', 'rhea@kita.ai', 'ghost@kita.ai'];
const noSleep = { sleeps: [] as number[] };

/** Fake Slack Web API: users by email, channel members, invite results; records every call. */
function fakeSlack(o: { members?: Record<string, string[]>; inviteErrors?: Record<string, string>; rateLimitOnce?: boolean } = {}) {
  const users: Record<string, string> = { 'carmel@kita.ai': 'UCARMEL', 'rhea@kita.ai': 'URHEA' };
  const members: Record<string, string[]> = o.members ?? { CACME: ['UBOT', 'UCUSTOMER', 'UCARMEL'] };
  const calls: { method: string; params: Record<string, string>; auth: string | null }[] = [];
  let limited = !!o.rateLimitOnce;
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = url.pathname.replace('/api/', '');
    const params = init.body ? JSON.parse(init.body) : Object.fromEntries(url.searchParams);
    calls.push({ method, params, auth: new Headers(init.headers).get('authorization') });
    if (method === 'conversations.invite' && limited) {
      limited = false;
      return new Response('{"ok":false,"error":"ratelimited"}', { status: 429, headers: { 'retry-after': '7' } });
    }
    if (method === 'auth.test') return Response.json({ ok: true, user_id: 'UBOT' });
    if (method === 'users.lookupByEmail') return Response.json(users[params.email] ? { ok: true, user: { id: users[params.email] } } : { ok: false, error: 'users_not_found' });
    if (method === 'conversations.members') return Response.json(members[params.channel] ? { ok: true, members: members[params.channel] } : { ok: false, error: 'channel_not_found' });
    if (method === 'conversations.invite') {
      const err = o.inviteErrors?.[params.users];
      if (err) return Response.json({ ok: false, error: err });
      members[params.channel].push(params.users);
      return Response.json({ ok: true, channel: { id: params.channel } });
    }
    return Response.json({ ok: false, error: 'unknown_method' });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const slack = new SlackMembership({ botToken: 'xoxb-test', fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
  return { slack, calls, members, sleeps, writes: () => calls.filter((c) => c.method === 'conversations.invite') };
}

function sync(mode: TeamSyncMode, d: { store?: Store; slack?: any; teams?: any; roster?: string[] } = {}) {
  const store = d.store ?? new Store(':memory:');
  return { store, ts: new TeamSync({ mode, store, roster: async () => d.roster ?? ROSTER, slack: d.slack, teams: d.teams }) };
}

// ---------------------------------------------------------------- Slack

test('teamsync slack: missing members are invited with the bot token; already-in and not-found are skipped', async () => {
  const s = fakeSlack();
  const { ts } = sync('on', { slack: s.slack });
  await ts.run(['slack:CACME']);
  assert.deepEqual(s.writes().map((c) => c.params), [{ channel: 'CACME', users: 'URHEA' }], 'carmel is already in, ghost is not in Slack');
  assert.ok(s.writes().every((c) => c.auth === 'Bearer xoxb-test'));
  assert.deepEqual(s.calls.filter((c) => c.method === 'users.lookupByEmail').map((c) => c.params.email).sort(), ['carmel@kita.ai', 'ghost@kita.ai', 'rhea@kita.ai'], 'each roster email is resolved once');
  assert.ok(s.members.CACME.includes('URHEA'));
});

test('teamsync slack: already_in_channel is success; cant_invite / restricted_action are logged, not fatal (Slack Connect policy)', async () => {
  const s = fakeSlack({ members: { CACME: ['UBOT'] }, inviteErrors: { UCARMEL: 'already_in_channel', URHEA: 'restricted_action' } });
  const { ts, store } = sync('on', { slack: s.slack });
  await ts.run(['slack:CACME']);
  assert.equal(s.writes().length, 2);
  assert.equal(store.getKv('teamsync:slack:CACME'), rosterHash(ROSTER), 'final per-user refusals still count as a clean sync');
});

test('teamsync slack: ratelimited (429) waits Retry-After seconds and retries', async () => {
  const s = fakeSlack({ rateLimitOnce: true, members: { CACME: ['UBOT', 'UCARMEL'] } });
  const { ts } = sync('on', { slack: s.slack });
  await ts.run(['slack:CACME']);
  assert.equal(s.writes().length, 2, 'one 429 + one retry');
  assert.equal(s.sleeps[0], 7000);
  assert.ok(s.members.CACME.includes('URHEA'));
});

test('teamsync slack: bot not in the channel -> logged and skipped, no invites, retried next refresh', async () => {
  const s = fakeSlack({ members: { CPUBLIC: ['UCUSTOMER'] } });
  const { ts, store } = sync('on', { slack: s.slack });
  await ts.run(['slack:CPUBLIC', 'slack:CPRIVATE']); // public without the bot, and private (channel_not_found)
  assert.equal(s.writes().length, 0);
  assert.equal(store.getKv('teamsync:slack:CPUBLIC'), undefined);
  assert.equal(store.getKv('teamsync:slack:CPRIVATE'), undefined);
});

test('teamsync: dry-run reads but makes no write calls, and logs what it would add', async () => {
  const s = fakeSlack();
  const { ts, store } = sync('dry-run', { slack: s.slack });
  await ts.run(['slack:CACME']);
  assert.equal(s.writes().length, 0);
  assert.equal(store.getKv('teamsync:slack:CACME'), undefined, 'the real hash is untouched so switching to on still syncs');
  assert.deepEqual(s.members.CACME, ['UBOT', 'UCUSTOMER', 'UCARMEL']);
});

test('teamsync: off makes no calls at all; mode parsing defaults to dry-run', async () => {
  const s = fakeSlack();
  await sync('off', { slack: s.slack }).ts.run(['slack:CACME']);
  assert.equal(s.calls.length, 0);
  assert.deepEqual([parseTeamSyncMode(undefined), parseTeamSyncMode(''), parseTeamSyncMode('on'), parseTeamSyncMode('off'), parseTeamSyncMode('yes')], ['dry-run', 'dry-run', 'on', 'off', 'dry-run']);
});

test('teamsync: only in-scope keys are synced; out-of-scope channels and WhatsApp/Viber are skipped', async () => {
  const s = fakeSlack();
  const grip = (async () => Response.json({
    success: true,
    data: {
      in_scope: ['slack:CACME', 'whatsapp:+639171234567', 'viber:abc'],
      out_of_scope: ['slack:CPAUSED'],
      channels: [{ channel_key: 'slack:CPAUSED', in_scope: false }, { channel_key: 'slack:CACME', in_scope: true }],
      generated_at: 'x',
    },
  })) as typeof fetch;
  const { ts } = sync('on', { slack: s.slack });
  let seen: string[] = [];
  const scope = new ScopeCache({ baseUrl: 'https://grip.example', apiKey: 'k', fetchImpl: grip, onRefresh: (keys) => { seen = keys; return ts.run(keys); } });
  assert.equal(await scope.refresh(), true);
  assert.deepEqual(seen.sort(), ['slack:CACME', 'viber:abc', 'whatsapp:+639171234567']);
  assert.ok(s.calls.every((c) => c.params.channel === undefined || c.params.channel === 'CACME'), 'CPAUSED never touched');
  assert.equal(s.writes().length, 1);
});

test('teamsync: roster hash skips unchanged channels; a roster change re-syncs', async () => {
  const s = fakeSlack();
  const store = new Store(':memory:');
  await sync('on', { store, slack: s.slack }).ts.run(['slack:CACME']);
  const n = s.calls.length;
  await sync('on', { store, slack: s.slack }).ts.run(['slack:CACME']);
  assert.equal(s.calls.length, n, 'unchanged roster -> no API call at all');
  await sync('on', { store, slack: s.slack, roster: [...ROSTER, 'new@kita.ai'] }).ts.run(['slack:CACME']);
  assert.ok(s.calls.length > n);
  assert.equal(rosterHash(['b', 'a']), rosterHash(['a', 'b']));
});

test('teamsync roster: TEAM_ROSTER wins; otherwise active Chatwoot agents minus bots and bridge@kita.ai', async () => {
  assert.deepEqual(await rosterSource({ emails: ['a@kita.ai'], exclude: ['bridge@kita.ai'] })(), ['a@kita.ai']);
  const agents = async () => [
    { email: 'carmel@kita.ai', confirmed: true },
    { email: 'Bridge@kita.ai', confirmed: true },
    { email: 'pending@kita.ai', confirmed: false },
    { email: 'bot@kita.ai', type: 'agent_bot' },
    { email: undefined },
  ];
  assert.deepEqual(await rosterSource({ emails: [], exclude: ['bridge@kita.ai'], listAgents: agents })(), ['carmel@kita.ai']);
  assert.deepEqual(await rosterSource({ emails: [], exclude: [] })(), []);
});

// ---------------------------------------------------------------- Teams

function fakeGraph(o: { membershipType?: string; forbidden?: boolean; teamMembers?: any[]; chatMembers?: any[] } = {}) {
  const calls: { method: string; path: string; body: any }[] = [];
  const users: Record<string, string> = { 'carmel@kita.ai': 'u-carmel', 'rhea@kita.ai': 'u-rhea' };
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const um = path.match(/^\/users\/(.+)$/);
    if (um) return users[um[1]] ? Response.json({ id: users[um[1]] }) : Response.json({ error: { code: 'Request_ResourceNotFound', message: 'nope' } }, { status: 404 });
    if (o.forbidden && init.method === 'POST') return Response.json({ error: { code: 'Forbidden', message: 'not an owner' } }, { status: 403 });
    if (/\/channels\/[^/]+$/.test(path)) return Response.json({ id: 'x', membershipType: o.membershipType ?? 'standard' });
    if (init.method === 'GET' && path.endsWith('/members')) return Response.json({ value: path.startsWith('/chats') ? o.chatMembers ?? [] : o.teamMembers ?? [{ userId: 'u-carmel', email: 'Carmel@kita.ai' }] });
    if (init.method === 'POST' && path.endsWith('/members')) return Response.json({ id: 'm' }, { status: 201 });
    return Response.json({ error: { message: 'unexpected' } }, { status: 400 });
  }) as typeof fetch;
  const graph = new Graph({ accessToken: async () => 'tok' }, fetchImpl);
  return { graph, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

function teamsWorld(g: ReturnType<typeof fakeGraph>) {
  const store = new Store(':memory:');
  store.putSubscription({ id: 's1', resource: '/teams/T1/channels/19:std@thread.tacv2/messages', clientState: 'x', expiresAt: Date.now() + 1e9 });
  const teams = new TeamsMembership({ graph: g.graph, store, sleep: async () => {} });
  return { store, teams };
}

test('teamsync teams: standard channel -> missing members added to the TEAM (membership is inherited)', async () => {
  const g = fakeGraph();
  const { store, teams } = teamsWorld(g);
  await sync('on', { store, teams }).ts.run(['teams:19:std@thread.tacv2']);
  const posts = g.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/teams/T1/members');
  assert.deepEqual(posts[0].body, { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: [], 'user@odata.bind': "https://graph.microsoft.com/v1.0/users('u-rhea')" });
});

test('teamsync teams: shared/private channel -> added to the channel directly', async () => {
  const g = fakeGraph({ membershipType: 'shared' });
  const { store, teams } = teamsWorld(g);
  await sync('on', { store, teams }).ts.run(['teams:19:std@thread.tacv2']);
  assert.deepEqual(g.posts().map((p) => p.path), ['/teams/T1/channels/19:std@thread.tacv2/members']);
});

test('teamsync teams: group chat -> POST /chats/{id}/members with full visible history', async () => {
  const g = fakeGraph({ chatMembers: [{ userId: 'u-customer' }] });
  const { store, teams } = teamsWorld(g);
  await sync('on', { store, teams }).ts.run(['teams:19:chat123@thread.v2']);
  const posts = g.posts();
  assert.deepEqual(posts.map((p) => p.path), ['/chats/19:chat123@thread.v2/members', '/chats/19:chat123@thread.v2/members']);
  assert.ok(posts.every((p) => p.body.visibleHistoryStartDateTime === ALL_HISTORY));
});

test('teamsync teams: 403 (Kita user not an owner) is logged with guidance, stops that channel, and is retried next time', async () => {
  const g = fakeGraph({ membershipType: 'private', forbidden: true });
  const { store, teams } = teamsWorld(g);
  await sync('on', { store, teams }).ts.run(['teams:19:std@thread.tacv2']);
  assert.equal(g.posts().length, 1, 'stops after the first 403');
  assert.equal(store.getKv('teamsync:teams:19:std@thread.tacv2'), undefined);
});

test('teamsync teams: dry-run makes no POSTs', async () => {
  const g = fakeGraph();
  const { store, teams } = teamsWorld(g);
  await sync('dry-run', { store, teams }).ts.run(['teams:19:std@thread.tacv2', 'teams:19:chat123@thread.v2']);
  assert.equal(g.posts().length, 0);
});
