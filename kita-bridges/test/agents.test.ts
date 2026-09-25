import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.ts';
import { ChatwootAppClient, toOutbound } from '../src/chatwoot.ts';
import { AgentConnect } from '../src/connect.ts';
import { seal, unseal } from '../src/crypto.ts';
import { signConnectLink, verifyConnectParams } from '../src/links.ts';
import { buildViberMessages, ViberSender } from '../src/platforms/viber.ts';
import { SlackSender, SlackUserOAuth } from '../src/platforms/slack.ts';
import { parseSlackEvent } from '../src/platforms/slack.ts';
import { Graph, GraphAuth } from '../src/platforms/teams/graph.ts';
import { TeamsSender } from '../src/platforms/teams/messages.ts';
import { Store } from '../src/store.ts';
import { withNamePrefix, type OutboundMessage, type Platform } from '../src/types.ts';
import { fakeChatwoot, fixture, PUBLIC_URL, RecordingSender } from './helpers.ts';

const carmel = { id: 3, name: 'Carmel Limcaoco', firstName: 'Carmel', email: 'carmel@kita.ai' };
const reply = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({ messageId: 1, conversationId: 100, text: 'We fixed it', attachments: [], agent: carmel, ...over });

/** Records Authorization header per call so we can see *whose* token posted. */
function recorder(respond: (url: string, auth: string, body: any) => Response) {
  const calls: { url: string; auth: string; body: any }[] = [];
  const f = (async (u: any, init: any = {}) => {
    const url = String(u);
    const auth = init.headers?.authorization ?? '';
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined;
    calls.push({ url, auth, body });
    return respond(url, auth, body);
  }) as typeof fetch;
  return { calls, f };
}
const err = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

// ---------- sender selection ----------

test('agent identity comes from the Chatwoot webhook sender', () => {
  const d = toOutbound(fixture('chatwoot_outgoing.json'));
  assert.ok(d.send);
  if (!d.send) return;
  assert.deepEqual(d.message.agent, { id: 3, name: 'Carmel Limcaoco', firstName: 'Carmel', email: undefined });
  const auto = toOutbound({ ...fixture('chatwoot_outgoing.json'), sender: null });
  assert.equal(auto.send && auto.message.agent, undefined); // automation -> plain Kita, no prefix
});

test('name prefix', () => {
  assert.equal(withNamePrefix(reply()).text, 'Carmel: We fixed it');
  assert.equal(withNamePrefix(reply({ text: '' })).text, 'Carmel:');
  assert.equal(withNamePrefix(reply({ agent: undefined })).text, 'We fixed it');
});

test('teams: connected agent posts with their own token (natively as them), no prefix, no fallback', async () => {
  const { calls, f } = recorder(() => Response.json({ id: '42' }, { status: 201 }));
  const kita = new Graph({ accessToken: async () => 'KITA' }, f);
  const agentGraph = new Graph({ accessToken: async () => 'CARMEL' }, f);
  const r = await new TeamsSender(kita, 'auto', f, (id) => (id === 3 ? agentGraph : undefined)).send({ kind: 'chat', chatId: 'X' }, reply());
  assert.deepEqual(r, { echoes: ['X:42'] });
  assert.equal(calls[0].auth, 'Bearer CARMEL');
  assert.equal(calls[0].body.body.content, 'We fixed it');
});

test('teams: agent not connected -> Kita user posts "Carmel: …", fallback not_connected', async () => {
  const { calls, f } = recorder(() => Response.json({ id: '43' }, { status: 201 }));
  const r = await new TeamsSender(new Graph({ accessToken: async () => 'KITA' }, f), 'auto', f).send({ kind: 'chat', chatId: 'X' }, reply());
  assert.deepEqual(r, { echoes: ['X:43'], fallback: 'not_connected' });
  assert.equal(calls[0].auth, 'Bearer KITA');
  assert.equal(calls[0].body.body.content, 'Carmel: We fixed it');
});

test('teams: agent not a member (403/404) -> Kita user with prefix, fallback not_member; 5xx is not swallowed', async () => {
  const { calls, f } = recorder((_u, auth) => (auth === 'Bearer CARMEL' ? err(403, 'Forbidden') : Response.json({ id: '44' }, { status: 201 })));
  const agentGraph = new Graph({ accessToken: async () => 'CARMEL' }, f);
  const r = await new TeamsSender(new Graph({ accessToken: async () => 'KITA' }, f), 'auto', f, () => agentGraph).send({ kind: 'chat', chatId: 'X' }, reply());
  assert.deepEqual(r, { echoes: ['X:44'], fallback: 'not_member' });
  assert.equal(calls.at(-1)!.body.body.content, 'Carmel: We fixed it');

  const boom = recorder(() => err(503, 'ServiceUnavailable'));
  await assert.rejects(new TeamsSender(new Graph({ accessToken: async () => 'KITA' }, boom.f), 'auto', boom.f, () => new Graph({ accessToken: async () => 'C' }, boom.f)).send({ kind: 'chat', chatId: 'X' }, reply()));
});

test('slack: connected agent posts with their user token (no username override)', async () => {
  const { calls, f } = recorder(() => Response.json({ ok: true, ts: '1.5' }));
  const r = await new SlackSender('xoxb-bot', { name: 'Kita' }, f, (id) => (id === 3 ? 'xoxp-carmel' : undefined)).send({ channel: 'C1', threadTs: '1.0' }, reply());
  assert.deepEqual(r, { echoes: ['C1:1.5'] });
  assert.equal(calls[0].auth, 'Bearer xoxp-carmel');
  assert.equal(calls[0].body.username, undefined);
  assert.equal(calls[0].body.text, 'We fixed it');
});

test('slack: not connected -> bot with chat:write.customize as the agent (full name + avatar)', async () => {
  const { calls, f } = recorder(() => Response.json({ ok: true, ts: '1.6' }));
  const r = await new SlackSender('xoxb-bot', { name: 'Kita', iconUrl: 'https://b/kita.png' }, f).send({ channel: 'C1', threadTs: '1.0' }, reply({ agent: { ...carmel, avatarUrl: `${PUBLIC_URL}/media/tok/avatar.png` } }));
  assert.deepEqual(r, { echoes: ['C1:1.6'], fallback: 'not_connected' });
  assert.equal(calls[0].auth, 'Bearer xoxb-bot');
  assert.equal(calls[0].body.username, 'Carmel Limcaoco');
  assert.equal(calls[0].body.icon_url, `${PUBLIC_URL}/media/tok/avatar.png`);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /chatwoot|active_storage/i);
});

test('slack: agent not in the channel -> bot fallback not_member; other errors surface', async () => {
  const { calls, f } = recorder((_u, auth) => Response.json(auth === 'Bearer xoxp-carmel' ? { ok: false, error: 'not_in_channel' } : { ok: true, ts: '1.7' }));
  const r = await new SlackSender('xoxb-bot', { name: 'Kita' }, f, () => 'xoxp-carmel').send({ channel: 'C1', threadTs: '1.0' }, reply());
  assert.deepEqual(r, { echoes: ['C1:1.7'], fallback: 'not_member' });
  assert.equal(calls[1].body.username, 'Carmel Limcaoco');
  const bad = recorder(() => Response.json({ ok: false, error: 'msg_too_long' }));
  await assert.rejects(new SlackSender('xoxb-bot', { name: 'Kita' }, bad.f, () => 'xoxp-carmel').send({ channel: 'C1', threadTs: '1.0' }, reply()), /msg_too_long/);
});

test('viber: one business identity -> "Carmel: …" by default, configurable off', async () => {
  const sent: any[] = [];
  const f = (async (_u: any, init: any) => (sent.push(JSON.parse(init.body)), Response.json({ status: 0 }))) as typeof fetch;
  await new ViberSender('tok', { name: 'Kita' }, f).send({ receiver: 'U1' }, reply());
  await new ViberSender('tok', { name: 'Kita' }, f, false).send({ receiver: 'U1' }, reply());
  assert.deepEqual(sent.map((b) => b.text), ['Carmel: We fixed it', 'We fixed it']);
  assert.equal(sent[0].sender.name, 'Kita');
  assert.equal(buildViberMessages({ receiver: 'U' }, reply(), { name: 'Kita' })[0].text, 'We fixed it'); // prefix is the sender's job
});

// ---------- bridge: fallback notes, staff sync, loop safety ----------

function appFake() {
  const posts: { path: string; body: any }[] = [];
  let id = 5000;
  const f = (async (u: any, init: any = {}) => {
    const url = String(u);
    if (url.endsWith('/agents')) return Response.json([{ id: 3, thumbnail: 'https://support.internal.kita.ai/rails/active_storage/avatar3.png' }]);
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name])) : JSON.parse(init.body);
    assert.equal(init.headers['api-access-token'], 'APP_TOKEN');
    posts.push({ path: new URL(url).pathname, body });
    return Response.json({ id: ++id });
  }) as typeof fetch;
  return { posts, app: new ChatwootAppClient('http://rails:3000', 'APP_TOKEN', '1', f) };
}

function bridgeWith(senderResult: any) {
  const cw = fakeChatwoot();
  const store = new Store(':memory:');
  const { posts, app } = appFake();
  const sender = new RecordingSender();
  (sender as any).send = async (ref: any, msg: any) => (sender.sent.push({ ref, msg }), senderResult);
  const inboxes = { slack: { inboxIdentifier: 'IN_SLACK' }, teams: { inboxIdentifier: 'IN_TEAMS' }, viber: { inboxIdentifier: 'IN_VIBER' } } as Record<Platform, { inboxIdentifier: string }>;
  const bridge = new Bridge({
    store, chatwoot: cw.client, inboxes, senders: { slack: sender, teams: sender }, publicUrl: PUBLIC_URL, app, fetchImpl: cw.fetchImpl,
    connectLink: (a) => signConnectLink('link-secret', PUBLIC_URL, { id: a.id, email: a.email ?? 'x@kita.ai' }),
  });
  return { bridge, store, posts, sender, cw };
}

const slackOpts = { botToken: 'xoxb', internalTeamIds: ['TKITA0001'], allowedChannels: [] as string[] };
const slackMsg = (name: string) => {
  const p = parseSlackEvent(fixture(name), slackOpts);
  if (p.kind !== 'message') throw new Error(name);
  return { ...p.message, userName: 'Sam Staff' };
};
const agentReply = (convId = 100) => ({ ...fixture('chatwoot_outgoing.json'), attachments: [], sender: { id: 3, name: 'Carmel Limcaoco', email: 'carmel@kita.ai', type: 'user' }, conversation: { id: convId } });

test('fallback not_connected -> private note to the agent with their signed connect link', async () => {
  const { bridge, posts } = bridgeWith({ echoes: ['C0SHARED1:9.9'], fallback: 'not_connected' });
  await bridge.inbound(slackMsg('slack_top_level.json'));
  assert.equal(await bridge.outbound('slack', agentReply()), 'sent:fallback:not_connected');
  const note = posts.find((p) => p.body.private === true)!;
  assert.equal(note.path, '/api/v1/accounts/1/conversations/100/messages');
  assert.match(note.body.content, /Carmel, this reply was sent from the shared Kita account .* isn't connected\. Connect it once so replies come from you: https:\/\/support\.internal\.kita\.ai\/bridges\/connect\?a=3&e=carmel%40kita\.ai/);
  assert.deepEqual(note.body.content_attributes, { kita_bridge_origin: true });
  // the note's own webhook can never go out
  assert.equal(toOutbound({ ...agentReply(), private: true, content_attributes: { kita_bridge_origin: true } }).send, false);
});

test('fallback not_member -> note asks to be added; normal sends post no note; agent avatar is proxied for Slack', async () => {
  const a = bridgeWith({ echoes: [], fallback: 'not_member' });
  await a.bridge.inbound(slackMsg('slack_top_level.json'));
  await a.bridge.outbound('slack', agentReply());
  assert.match(a.posts.find((p) => p.body.private)!.body.content, /isn't a member of this channel\. Ask to be added/);
  assert.match(a.sender.sent[0].msg.agent!.avatarUrl!, new RegExp(`^${PUBLIC_URL}/media/`));

  const b = bridgeWith({ echoes: ['C0SHARED1:9.8'] });
  await b.bridge.inbound(slackMsg('slack_top_level.json'));
  assert.equal(await b.bridge.outbound('slack', agentReply()), 'sent');
  assert.equal(b.posts.filter((p) => p.body.private).length, 0);
});

test('staff typing directly in a mapped thread is mirrored as an outgoing agent message (never a customer message)', async () => {
  const { bridge, posts, cw } = bridgeWith({ echoes: [] });
  await bridge.inbound(slackMsg('slack_top_level.json')); // customer opens conv 100
  const contactsBefore = cw.calls.filter((c) => c.path.endsWith('/contacts')).length;
  assert.equal(await bridge.inbound(slackMsg('slack_internal_staff.json')), 'staff_synced');
  const synced = posts.at(-1)!;
  assert.deepEqual(synced.body, { content: '**Sam Staff (in Slack):** internal chatter', message_type: 'outgoing', private: false, content_attributes: { kita_bridge_origin: true } });
  assert.equal(cw.calls.filter((c) => c.path.endsWith('/contacts')).length, contactsBefore); // no contact created
  // never echoed back: marker + its id pre-marked
  assert.equal(await bridge.outbound('slack', { ...agentReply(), id: 5001, content_attributes: { kita_bridge_origin: true } }), 'skip:external_echo');
  assert.equal(await bridge.outbound('slack', { ...agentReply(), id: 5001 }), 'skip:duplicate');
  // a thread Kita starts is still a customer conversation: the channel becomes its contact
  const before = cw.calls.filter((c) => c.path.endsWith('/contacts')).length;
  const staffMsg = slackMsg('slack_internal_staff.json');
  const attrs = { ...staffMsg.conversationAttributes, channel_label: '#kita-tala' };
  assert.equal(await bridge.inbound({ ...staffMsg, eventId: 'x:1', threadKey: 'C9:1.0', conversationAttributes: attrs }), 'staff_synced');
  const newContact = cw.calls.filter((c) => c.path.endsWith('/contacts'));
  assert.equal(newContact.length, before + 1);
  assert.equal(newContact.at(-1)!.body.name, '#kita-tala');
  assert.equal(posts.at(-1)!.body.message_type, 'outgoing');
});

test('loop safety: our own post from the agent account (echo id, fingerprint race, file ids) is never re-ingested', async () => {
  const { bridge, posts, store } = bridgeWith({ echoes: ['C0SHARED1:1790000300.000500', 'file:F77'] });
  await bridge.inbound(slackMsg('slack_top_level.json'));
  await bridge.outbound('slack', agentReply());
  const synced = () => posts.filter((p) => !p.body.private).length;
  const base = { ...slackMsg('slack_internal_staff.json') };
  // 1) platform delivers the echo with the ts we recorded
  assert.equal(await bridge.inbound({ ...base, eventId: 'C0SHARED1:1790000300.000500' }), 'duplicate');
  // 2) race: echo arrives with an id we haven't recorded yet, but the text matches what we just sent
  assert.equal(await bridge.inbound({ ...base, eventId: 'C0SHARED1:new', text: 'Hi Maria, we\'ve *reset* it. See <https://kita.ai/help|guide>' }), 'duplicate');
  // 3) file-only echo
  assert.equal(await bridge.inbound({ ...base, eventId: 'C0SHARED1:f', text: '', echoKeys: ['file:F77'] }), 'duplicate');
  assert.equal(synced(), 0);
  assert.equal(store.isSeen('in:slack:file:F77'), true);
});

// ---------- connect links, tokens ----------

test('signed connect links: valid, tampered, expired, email case-insensitive', () => {
  const link = new URL(signConnectLink('s3cret', PUBLIC_URL, { id: 3, email: 'Carmel@Kita.ai' }, 7, 1_000_000));
  assert.deepEqual(verifyConnectParams('s3cret', link.searchParams, 1_000_001), { agentId: 3, email: 'carmel@kita.ai' });
  const tampered = new URLSearchParams(link.searchParams);
  tampered.set('a', '4');
  assert.equal(verifyConnectParams('s3cret', tampered, 1_000_001), undefined);
  assert.equal(verifyConnectParams('other', link.searchParams, 1_000_001), undefined);
  assert.equal(verifyConnectParams('s3cret', link.searchParams, 1_000_000 + 8 * 86400), undefined);
});

test('token encryption: AES-GCM round trip, tamper detection, wrong key fails', () => {
  const sealed = seal('k'.repeat(32), 'xoxp-secret-token');
  assert.doesNotMatch(sealed, /xoxp/);
  assert.equal(unseal('k'.repeat(32), sealed), 'xoxp-secret-token');
  assert.throws(() => unseal('j'.repeat(32), sealed));
  const [iv, tag, ct] = sealed.split('.');
  assert.throws(() => unseal('k'.repeat(32), [iv, tag, ct.slice(0, -2) + (ct.endsWith('A') ? 'BB' : 'AA')].join('.')));
});

test('slack user OAuth: requires the Slack account email to match the agent; stores the user token encrypted', async () => {
  const store = new Store(':memory:');
  let email = 'someone@else.com';
  const f = (async (u: any) => {
    const url = String(u);
    if (url.includes('oauth.v2.access')) return Response.json({ ok: true, authed_user: { id: 'U_CARMEL', access_token: 'xoxp-carmel' } });
    if (url.includes('users.info')) return Response.json({ ok: true, user: { profile: { email } } });
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const o = new SlackUserOAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: `${PUBLIC_URL}/connect/slack/callback`, botToken: 'xoxb', encryptionKey: 'k'.repeat(32) }, store, f);
  const url = new URL(o.authorizeUrl('st'));
  assert.equal(url.searchParams.get('user_scope'), 'chat:write,files:write');
  assert.equal(url.searchParams.get('redirect_uri'), `${PUBLIC_URL}/connect/slack/callback`);
  await assert.rejects(o.complete('code', 3, 'carmel@kita.ai'), /expected carmel@kita.ai/);
  assert.equal(o.userToken(3), undefined);
  email = 'Carmel@kita.ai';
  await o.complete('code', 3, 'carmel@kita.ai');
  assert.equal(o.userToken(3), 'xoxp-carmel');
  assert.doesNotMatch(store.getKv('slack.agent.3.token')!, /xoxp/);
});

test('teams agent connect: signed-in account must match the agent email (UPN or mail); stored per agent', async () => {
  const store = new Store(':memory:');
  let me = { id: 'aad-carmel', userPrincipalName: 'carmel@kitatech.onmicrosoft.com', mail: 'carmel@kita.ai' };
  const f = (async (u: any) => {
    const url = String(u);
    if (url.includes('/oauth2/v2.0/token')) return Response.json({ access_token: 'AT', refresh_token: 'RT-carmel', expires_in: 3600 });
    if (url.includes('/me?')) return Response.json(me);
    return new Response('?', { status: 500 });
  }) as typeof fetch;
  const cfg = { tenantId: 't', clientId: 'c', clientSecret: 's', redirectUri: 'r', kitaUserUpn: 'kita@kita.ai', encryptionKey: 'k'.repeat(32) };
  const agent = new GraphAuth(cfg, store, f, '3');
  const url = new URL(agent.authorizeUrl('st', 'carmel@kita.ai'));
  assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), ['ChannelMessage.Send', 'ChatMessage.Send', 'User.Read', 'offline_access', 'openid', 'profile']);
  await agent.completeConnect('code', 'carmel@kita.ai'); // matched on mail
  assert.equal(agent.isConnected(), true);
  assert.equal(new GraphAuth(cfg, store, f).isConnected(), false); // the shared Kita user is separate
  me = { id: 'aad-x', userPrincipalName: 'intruder@kita.ai', mail: 'intruder@kita.ai' };
  const other = new GraphAuth(cfg, store, f, '4');
  await assert.rejects(other.completeConnect('code', 'sam@kita.ai'), /expected sam@kita.ai/);
  assert.equal(other.isConnected(), false);
});

test('connect page: signed link required; shows Slack/Teams buttons; start endpoints re-verify', () => {
  const store = new Store(':memory:');
  const slack = new SlackUserOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://b/connect/slack/callback', botToken: 'x', encryptionKey: 'k'.repeat(32) }, store);
  const c = new AgentConnect({ linkSecret: 'link-secret', slack });
  assert.equal(c.page(new URLSearchParams('a=3&e=carmel%40kita.ai&x=9999999999&s=bad')).status, 403);
  const good = new URL(signConnectLink('link-secret', PUBLIC_URL, { id: 3, email: 'carmel@kita.ai' })).searchParams;
  const page = c.page(good);
  assert.equal(page.status, 200);
  assert.match(page.html, /Connect your Slack account/);
  assert.doesNotMatch(page.html, /chatwoot/i);
  assert.match(c.start('slack', good)!, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
  assert.equal(c.start('slack', new URLSearchParams('a=3')), undefined);
  assert.equal(c.start('teams', good), undefined); // teams not configured
});

test('echo fingerprint normalisation ignores link rendering differences across platforms', async () => {
  const { normalizeForEcho } = await import('../src/bridge.ts');
  const sent = normalizeForEcho("Hi Maria, we've **reset** it. See [guide](https://kita.ai/help)");
  assert.equal(normalizeForEcho("Hi Maria, we've *reset* it. See <https://kita.ai/help|guide>"), sent); // Slack mrkdwn
  assert.equal(normalizeForEcho("Hi Maria, we've reset it. See guide"), sent); // Teams HTML -> text keeps only the label
});
