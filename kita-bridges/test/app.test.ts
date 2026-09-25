import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { hmacHex } from '../src/crypto.ts';
import { TeamsIntegration } from '../src/platforms/teams/index.ts';
import { fixture, makeBridge, raw } from './helpers.ts';

const cfg = loadConfig();
cfg.slack.signingSecret = 'slack-secret';
cfg.slack.botToken = 'xoxb';
cfg.slack.internalTeamIds = ['TKITA0001'];
cfg.viber.authToken = 'viber-tok';
cfg.customers = { inboxIdentifier: 'IN_CUSTOMERS', webhookSecret: 'cw-customers' };
const { bridge, senders, store } = makeBridge();
const upstream = (async (url: any, init: any = {}) => {
  assert.equal(String(url), 'https://support.internal.kita.ai/rails/active_storage/blobs/redirect/abc/steps.png');
  return new Response(init.method === 'HEAD' ? null : new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png', 'content-length': '4', server: 'chatwoot-rails' } });
}) as typeof fetch;
const teams = new TeamsIntegration(
  { tenantId: 'kita-tenant', clientId: 'cid', clientSecret: 'sec', kitaUserUpn: 'kita@kita.ai', internalTenantIds: ['kita-tenant'], connectKey: 'connect-key-0123456789', teamIds: [], extraChannels: [], messageFormat: 'auto', encryptionKey: 'k'.repeat(32) },
  'https://support.internal.kita.ai/bridges', store, (async () => new Response('unexpected', { status: 500 })) as typeof fetch,
);
const server = createServer(createHandler({ cfg, store, fetchImpl: upstream, bridge, enabled: ['slack', 'teams', 'viber'], teams }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bridges`;
after(() => server.close());

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

test('http: slack url_verification with valid signature returns challenge; bad signature 401', async () => {
  const body = raw('slack_url_verification.json');
  const ts = String(Math.floor(Date.now() / 1000));
  const ok = await post('/slack/events', body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${hmacHex('slack-secret', `v0:${ts}:${body}`)}` });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).challenge, '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P');
  const bad = await post('/slack/events', body, { 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=deadbeef' });
  assert.equal(bad.status, 401);
});

test('http: viber unsigned request rejected, signed accepted', async () => {
  const body = raw('viber_webhook_check.json');
  assert.equal((await post('/viber/webhook', body)).status, 401);
  assert.equal((await post('/viber/webhook', body, { 'x-viber-content-signature': hmacHex('viber-tok', body) })).status, 200);
});

test('http: Graph subscription validation echoes the decoded token as text/plain on both endpoints', async () => {
  for (const ep of ['/teams/notifications', '/teams/lifecycle']) {
    const res = await fetch(`${base}${ep}?validationToken=${encodeURIComponent('Validation: Testing client application reachability <123>')}`, { method: 'POST', headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'Validation: Testing client application reachability <123>');
  }
});

test('http: notifications with a bad clientState are acked (202) but never fetched', async () => {
  const res = await post('/teams/notifications', raw('graph_notification_forged.json'));
  assert.equal(res.status, 202);
  const r = await teams.notifications(fixture('graph_notification_forged.json'), async () => assert.fail('must not deliver'));
  assert.deepEqual(r, { accepted: 0, rejected: 2 });
});

test('http: connect flow requires the connect key and a valid state', async () => {
  assert.equal((await fetch(`${base}/teams/connect?key=wrong`, { redirect: 'manual' })).status, 403);
  const ok = await fetch(`${base}/teams/connect?key=connect-key-0123456789`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location')!);
  assert.equal(loc.host, 'login.microsoftonline.com');
  assert.equal(loc.pathname, '/kita-tenant/oauth2/v2.0/authorize');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://support.internal.kita.ai/bridges/teams/connect/callback');
  assert.equal((await fetch(`${base}/teams/connect/callback?code=abc&state=forged`)).status, 400);
});

const signed = (body: string, secret = 'cw-customers') => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': `sha256=${hmacHex(secret, `${ts}.${body}`)}` };
};

test('http: /chatwoot/customers requires the Customers inbox signature; old per-platform routes are gone', async () => {
  const body = raw('chatwoot_outgoing.json');
  assert.equal((await post('/chatwoot/customers', body)).status, 401);
  assert.equal((await post('/chatwoot/customers', body, signed(body, 'cw-slack'))).status, 401);
  const res = await post('/chatwoot/customers', body, signed(body));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 'skip:unmapped_conversation');
  for (const old of ['/chatwoot/slack', '/chatwoot/viber', '/chatwoot/whatsapp/111']) assert.equal((await post(old, body, signed(body))).status, 404);
});

test('http: viber is a mirror: the desk never sends, even through the bot', async () => {
  store.putConversation({ platform: 'customers', threadKey: 'channel:viber:V1', conversationId: 4343, sourceId: 's', replyRef: {} });
  store.putChannel({ channelKey: 'viber:V1', conversationId: 4343, platform: 'viber', replyRef: { receiver: 'V1' }, label: 'Maria', lastAt: 1 });
  const body = JSON.stringify({ ...JSON.parse(raw('chatwoot_outgoing.json')), id: 777000, conversation: { id: 4343 } });
  const res = await post('/chatwoot/customers', body, signed(body));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 'skip:mirror');
  assert.equal(senders.viber.sent.length, 0);
});

test('http: a refused agent reply (Slack not connected) answers 422 so the desk marks it failed; nothing is posted', async () => {
  store.putConversation({ platform: 'customers', threadKey: 'channel:slack:C0REFUSE', conversationId: 4242, sourceId: 's', replyRef: {} });
  store.putChannel({ channelKey: 'slack:C0REFUSE', conversationId: 4242, platform: 'slack', replyRef: { channel: 'C0REFUSE' }, label: '#refuse', lastAt: 1 });
  senders.slack.send = async () => ({ refused: 'not_connected' as const });
  const body = JSON.stringify({ ...JSON.parse(raw('chatwoot_outgoing.json')), id: 777001, conversation: { id: 4242 } });
  const res = await post('/chatwoot/customers', body, signed(body));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { ok: false, result: 'refused:not_connected' });
  assert.equal(senders.slack.sent.length, 0);
});

test('http: media proxy serves agent attachments under the bridge URL without upstream headers; bad tokens 404', async () => {
  const token = 'A'.repeat(32);
  store.putMedia(token, 'https://support.internal.kita.ai/rails/active_storage/blobs/redirect/abc/steps.png', 'steps.png');
  const res = await fetch(`${base}/media/${token}/steps.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('server'), null);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [137, 80, 78, 71]);
  assert.equal((await fetch(`${base}/media/${'B'.repeat(32)}/steps.png`)).status, 404);
  assert.equal((await fetch(`${base}/media/short/steps.png`)).status, 404);
});

test('http: healthz and unknown routes', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await post('/nope', '{}')).status, 404);
});
