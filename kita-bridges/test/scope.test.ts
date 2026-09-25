import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { Bridge } from '../src/bridge.ts';
import { ChatwootAppClient, KitaDeskClient } from '../src/chatwoot.ts';
import { enabledPlatforms, loadConfig } from '../src/config.ts';
import { hmacHex } from '../src/crypto.ts';
import { ScopeCache, type ScopeCheck } from '../src/scope.ts';
import { parseSlackEvent } from '../src/platforms/slack.ts';
import { parseGraphMessage, parseResource } from '../src/platforms/teams/messages.ts';
import { parseViberEvent } from '../src/platforms/viber.ts';
import { parseWhatsAppWebhook, type WhatsAppNumber } from '../src/platforms/whatsapp.ts';
import { Store } from '../src/store.ts';
import type { InboundMessage, Platform } from '../src/types.ts';
import { fakeChatwoot, fixture, PUBLIC_URL, raw } from './helpers.ts';

const GRIP = 'https://grip.example';

/** Fake Grip /support/scope: `next` is served on each call (a function may throw / return a Response). */
function fakeGrip(initial: any) {
  let next: any = initial;
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (u: any, init: any = {}) => {
    calls.push({ url: String(u), auth: new Headers(init.headers).get('authorization') });
    const v = typeof next === 'function' ? next() : next;
    return v instanceof Response ? v : Response.json(v);
  }) as typeof fetch;
  return { calls, fetchImpl, set: (v: any) => { next = v; } };
}
/** Grip's real shape: { success, data: { in_scope, out_of_scope, generated_at } }. */
const scopeBody = (out: string[], inn: string[] = []) => ({ success: true, data: { in_scope: inn, out_of_scope: out, generated_at: '2026-09-24T10:00:00Z' } });

async function loadedScope(out: string[], inn: string[] = []) {
  const g = fakeGrip(scopeBody(out, inn));
  const s = new ScopeCache({ baseUrl: GRIP, apiKey: 'grip_test', fetchImpl: g.fetchImpl });
  assert.equal(await s.refresh(), true);
  return s;
}

// ---------- the cache ----------

test('scope cache: GET {GRIP_BASE_URL}/api/v1/support/scope with the Bearer key; out_of_scope dropped, in_scope and unknown pass', async () => {
  const g = fakeGrip(scopeBody(['slack:CZED'], ['slack:CTALA']));
  const s = new ScopeCache({ baseUrl: `${GRIP}/`, apiKey: 'grip_test', fetchImpl: g.fetchImpl });
  assert.equal(s.allows('slack:CZED'), true, 'no list yet -> allow everything');
  assert.equal(await s.refresh(), true);
  assert.deepEqual(g.calls, [{ url: `${GRIP}/api/v1/support/scope`, auth: 'Bearer grip_test' }]);
  assert.equal(s.allows('slack:CZED'), false);
  assert.equal(s.allows('slack:CTALA'), true);
  assert.equal(s.allows('slack:CNEW'), true, 'unknown channels pass so auto-link keeps working');
  assert.equal(s.allows(undefined), true);
  assert.equal(s.generatedAt, '2026-09-24T10:00:00Z');
  g.set({ in_scope: [], out_of_scope: ['slack:CFLAT'] }); // an unwrapped body is accepted too
  assert.equal(await s.refresh(), true);
  assert.equal(s.allows('slack:CFLAT'), false);
  assert.equal(s.allows('slack:CZED'), true);
});

test('scope cache: fails open, keeps the last good list on HTTP errors, network errors and malformed bodies', async () => {
  const g = fakeGrip(() => { throw new Error('ECONNREFUSED'); });
  const s = new ScopeCache({ baseUrl: GRIP, apiKey: 'k', fetchImpl: g.fetchImpl });
  assert.equal(await s.refresh(), false);
  assert.equal(s.loaded, false);
  assert.equal(s.allows('slack:CZED'), true, 'never loaded -> allow all');
  g.set(scopeBody(['slack:CZED']));
  assert.equal(await s.refresh(), true);
  for (const bad of [() => { throw new Error('down'); }, new Response('nope', { status: 503 }), { out_of_scope: 'not-a-list' }, { success: true, data: { out_of_scope: null } }, new Response('<html>', { status: 200 })]) {
    g.set(bad);
    assert.equal(await s.refresh(), false);
    assert.equal(s.allows('slack:CZED'), false, 'last good list still applies');
  }
});

test('scope cache: disabled when GRIP_* is not configured (allows all, never calls out)', async () => {
  const g = fakeGrip(scopeBody(['slack:CZED']));
  for (const o of [{}, { baseUrl: GRIP }, { apiKey: 'k' }]) {
    const s = new ScopeCache({ ...o, fetchImpl: g.fetchImpl });
    assert.equal(s.enabled, false);
    assert.equal(await s.start(), false);
    assert.equal(await s.refresh(), false);
    assert.equal(s.allows('slack:CZED'), true);
  }
  assert.equal(g.calls.length, 0);
});

test('scope cache: start() loads now and refreshes on the interval; a channel can flip out and back in', async () => {
  const g = fakeGrip(scopeBody([]));
  const s = new ScopeCache({ baseUrl: GRIP, apiKey: 'k', refreshMs: 20, fetchImpl: g.fetchImpl });
  assert.equal(s.refreshMs, 20);
  assert.equal(await s.start(), true);
  assert.equal(s.allows('slack:CZED'), true);
  g.set(scopeBody(['slack:CZED']));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.allows('slack:CZED'), false, 'paused account picked up on the next refresh');
  g.set(scopeBody([], ['slack:CZED']));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.allows('slack:CZED'), true, 'reactivated account comes back');
  s.stop();
  const n = g.calls.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.calls.length, n, 'stop() halts refreshes');
  assert.ok(n >= 3);
  assert.equal(new ScopeCache({ baseUrl: GRIP, apiKey: 'k' }).refreshMs, 300_000, 'default 5 minutes');
});

test('config: GRIP_BASE_URL, GRIP_API_KEY, SCOPE_REFRESH_SECONDS', () => {
  const saved = { ...process.env };
  process.env.GRIP_BASE_URL = 'https://grip.example/';
  process.env.GRIP_API_KEY = 'grip_x';
  process.env.SCOPE_REFRESH_SECONDS = '60';
  try {
    assert.deepEqual(loadConfig().grip, { baseUrl: 'https://grip.example', apiKey: 'grip_x', scopeRefreshMs: 60_000 });
  } finally {
    for (const k of ['GRIP_BASE_URL', 'GRIP_API_KEY', 'SCOPE_REFRESH_SECONDS']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

// ---------- every inbound path, at the bridge ----------

const numbers: WhatsAppNumber[] = [{ phoneNumberId: '111111111111111', inboxIdentifier: 'IN_CUSTOMERS', webhookSecret: 'cw-wa-carmel', ownerName: 'Carmel Limcaoco' }];

function world(scope?: ScopeCheck) {
  const cw = fakeChatwoot();
  const appPosts: any[] = [];
  const appFetch = (async (_u: any, init: any) => (appPosts.push(init.body), Response.json({ id: 7000 + appPosts.length }))) as typeof fetch;
  const app = new ChatwootAppClient('http://rails:3000', 'BRIDGE_TOKEN', '1', appFetch);
  const desk = new KitaDeskClient('https://support.internal.kita.ai', 's', appFetch);
  const bridge = new Bridge({ store: new Store(':memory:'), chatwoot: cw.client, inbox: 'IN_CUSTOMERS', senders: {}, publicUrl: PUBLIC_URL, app, desk, fetchImpl: cw.fetchImpl, scope });
  const chatwootCalls = () => cw.calls.filter((c) => c.path.startsWith('/public')).length + appPosts.length;
  return { bridge, cw, appPosts, chatwootCalls };
}

const only = <T extends { kind: string }>(p: T) => {
  if (p.kind !== 'message') throw new Error(`not a message: ${p.kind}`);
  return (p as any).message as InboundMessage;
};
const wa = (name: string) => {
  const it = parseWhatsAppWebhook(fixture(name), numbers).items[0];
  return { ...it.message, attachments: [] };
};
const PATHS: { name: string; key: string; msg: () => InboundMessage; echo?: boolean }[] = [
  { name: 'slack event', key: 'slack:C0SHARED1', msg: () => ({ ...only(parseSlackEvent(fixture('slack_top_level.json'), { botToken: 'x', internalTeamIds: ['TKITA0001'], allowedChannels: [] })), attachments: [] }) },
  { name: 'teams channel (Graph)', key: 'teams:19:acme-shared@thread.tacv2', msg: () => ({ ...only(parseGraphMessage(fixture('graph_channel_reply_external.json'), parseResource(fixture('graph_notification_channel.json').value[0].resource)!, 'customer')), attachments: [] }) },
  { name: 'teams chat (Graph)', key: 'teams:19:acme-group@thread.v2', msg: () => ({ ...only(parseGraphMessage({ ...fixture('graph_chat_message_guest.json'), id: '1' }, { kind: 'chat', chatId: '19:acme-group@thread.v2', messageId: '1' }, 'customer')), attachments: [] }) },
  { name: 'viber', key: 'viber:01234567890A=', msg: () => ({ ...only(parseViberEvent(fixture('viber_message.json'))), attachments: [] }) },
  { name: 'whatsapp message', key: 'whatsapp:+639998887777', msg: () => wa('wa_messages_text.json') },
  { name: 'whatsapp smb_message_echo', key: 'whatsapp:+639998887777', msg: () => wa('wa_echo_text.json'), echo: true },
];
const deliver = (bridge: Bridge, p: (typeof PATHS)[number]) =>
  p.echo ? bridge.businessEcho(p.msg(), { ownerName: 'Carmel Limcaoco', ownerKey: 'whatsapp:111' }) : bridge.inbound(p.msg());

for (const p of PATHS) {
  test(`scope/${p.name}: out-of-scope key dropped before any Chatwoot contact or conversation`, async () => {
    assert.equal(p.msg().conversationAttributes!.channel_key, p.key);
    const w = world(await loadedScope([p.key]));
    assert.equal(await deliver(w.bridge, p), 'out_of_scope');
    assert.equal(w.chatwootCalls(), 0);
  });

  test(`scope/${p.name}: in-scope and unknown keys pass`, async () => {
    for (const s of [await loadedScope([], [p.key]), await loadedScope(['slack:COTHER'])]) {
      const w = world(s);
      assert.equal(await deliver(w.bridge, p), p.echo ? 'staff_synced' : 'created');
      assert.ok(w.cw.calls.some((c) => c.path.endsWith('/conversations')));
    }
  });

  test(`scope/${p.name}: fail-open (Grip never reachable) and disabled (no GRIP_*) both pass`, async () => {
    const down = new ScopeCache({ baseUrl: GRIP, apiKey: 'k', fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
    await down.refresh();
    for (const s of [down, new ScopeCache({}), undefined]) {
      const w = world(s);
      assert.equal(await deliver(w.bridge, p), p.echo ? 'staff_synced' : 'created');
    }
  });
}

test('scope: an open conversation stops ingesting once its channel turns out_of_scope (and resumes if it comes back)', async () => {
  const g = fakeGrip(scopeBody([]));
  const s = new ScopeCache({ baseUrl: GRIP, apiKey: 'k', fetchImpl: g.fetchImpl });
  await s.refresh();
  const w = world(s);
  const slack = PATHS[0];
  assert.equal(await w.bridge.inbound(slack.msg()), 'created');
  g.set(scopeBody(['slack:C0SHARED1']));
  await s.refresh();
  const reply = { ...slack.msg(), eventId: 'C0SHARED1:1790000001.000000' };
  const before = w.cw.calls.length;
  assert.equal(await w.bridge.inbound(reply), 'out_of_scope');
  assert.equal(w.cw.calls.length, before);
  g.set(scopeBody([]));
  await s.refresh();
  assert.equal(await w.bridge.inbound(reply), 'appended', 'a dropped message was never marked seen');
});

// ---------- HTTP: the platform still gets its 2xx ----------

const cfg = loadConfig();
cfg.slack.signingSecret = 'slack-secret';
cfg.slack.botToken = 'xoxb';
cfg.slack.internalTeamIds = ['TKITA0001'];
cfg.viber.authToken = 'viber-tok';
cfg.whatsapp = { appSecret: 'app-secret', verifyToken: 'vt', accessToken: 'WA_TOKEN', numbers };
const hw = world(await loadedScope(['slack:C0SHARED1', 'viber:01234567890A=', 'whatsapp:+639998887777']));
const platformCalls: string[] = [];
const outside = (async (u: any) => (platformCalls.push(String(u)), Response.json({ ok: true, user: { real_name: 'x' } }))) as typeof fetch;
const server = createServer(createHandler({ cfg, store: new Store(':memory:'), bridge: hw.bridge, enabled: ['slack', 'viber', 'whatsapp'], fetchImpl: outside }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const post = (path: string, body: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const settle = () => new Promise((r) => setTimeout(r, 30));

test('http: dropped Slack, Viber and WhatsApp (message + echo) events are still answered 200, and nothing reaches Chatwoot', async () => {
  const slack = raw('slack_top_level.json');
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal((await post('/slack/events', slack, { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hmacHex('slack-secret', `v0:${ts}:${slack}`)}` })).status, 200);
  const viber = raw('viber_message.json');
  assert.equal((await post('/viber/webhook', viber, { 'x-viber-content-signature': hmacHex('viber-tok', viber) })).status, 200);
  for (const f of ['wa_messages_text.json', 'wa_echo_text.json', 'wa_messages_image.json']) {
    const b = raw(f);
    assert.equal((await post('/whatsapp/webhook', b, { 'x-hub-signature-256': `sha256=${hmacHex('app-secret', b)}` })).status, 200);
  }
  await settle();
  assert.equal(hw.chatwootCalls(), 0);
  assert.deepEqual(platformCalls, [], 'no Slack user lookup and no WhatsApp media download for dropped messages');
});

test('scope cache: data.channels[] is exposed per channel_key (account, DRI, phase/health when sent)', async () => {
  const g = fakeGrip({ success: true, data: { in_scope: [], out_of_scope: [], channels: [
    { channel_key: 'slack:CTALA', account_id: 42, account_name: 'Tala', in_scope: true, dri_email: 'carmel@kita.ai', dri_name: 'Carmel Limcaoco', sales_owner_email: 'rhea@kita.ai', phase: 'pilot' },
    { channel_key: 'whatsapp:+639998887777', account_id: null, in_scope: false },
  ] } });
  const s = new ScopeCache({ baseUrl: GRIP, apiKey: 'k', fetchImpl: g.fetchImpl });
  await s.refresh();
  assert.deepEqual(s.channel('slack:CTALA'), {
    channel_key: 'slack:CTALA', account_id: '42', account_name: 'Tala', in_scope: true, dri_email: 'carmel@kita.ai', dri_name: 'Carmel Limcaoco',
    sales_owner_email: 'rhea@kita.ai', phase: 'pilot', health: undefined,
  });
  assert.equal(s.channel('whatsapp:+639998887777')?.account_id, undefined);
  assert.equal(s.channel('slack:CNONE'), undefined);
  assert.deepEqual(s.inScope, ['slack:CTALA']);
});

test('config: CHATWOOT_CUSTOMERS_* is the one inbox; nothing is enabled without it; legacy WHATSAPP_NUMBERS fields tolerated', () => {
  const keys = ['CHATWOOT_CUSTOMERS_INBOX_IDENTIFIER', 'CHATWOOT_CUSTOMERS_WEBHOOK_SECRET', 'VIBER_AUTH_TOKEN', 'WHATSAPP_NUMBERS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.VIBER_AUTH_TOKEN = 'v';
    process.env.WHATSAPP_NUMBERS = JSON.stringify([{ phoneNumberId: '1', ownerName: 'A' }, { phoneNumberId: '2', inboxIdentifier: 'old', webhookSecret: 'old', ownerName: 'B' }]);
    delete process.env.CHATWOOT_CUSTOMERS_INBOX_IDENTIFIER;
    assert.deepEqual(enabledPlatforms(loadConfig()), []);
    process.env.CHATWOOT_CUSTOMERS_INBOX_IDENTIFIER = 'IN_CUSTOMERS';
    process.env.CHATWOOT_CUSTOMERS_WEBHOOK_SECRET = 'sec';
    const c = loadConfig();
    assert.deepEqual(c.customers, { inboxIdentifier: 'IN_CUSTOMERS', webhookSecret: 'sec' });
    assert.deepEqual(enabledPlatforms(c), ['viber']);
    assert.equal(c.whatsapp.numbers.length, 2);
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});
