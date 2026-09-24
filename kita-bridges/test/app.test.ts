import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { hmacHex } from '../src/crypto.ts';
import { makeBridge, raw } from './helpers.ts';

const cfg = loadConfig();
cfg.slack.signingSecret = 'slack-secret';
cfg.slack.botToken = 'xoxb';
cfg.slack.internalTeamIds = ['TKITA0001'];
cfg.viber.authToken = 'viber-tok';
cfg.teams.appId = 'kita-bot-app-id';
cfg.inboxes.viber.webhookSecret = 'cw-viber';
const { bridge, senders, store } = makeBridge();
const upstream = (async (url: any, init: any = {}) => {
  assert.equal(String(url), 'https://support.internal.kita.ai/rails/active_storage/blobs/redirect/abc/steps.png');
  return new Response(init.method === 'HEAD' ? null : new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png', 'content-length': '4', server: 'chatwoot-rails' } });
}) as typeof fetch;
const server = createServer(createHandler({ cfg, store, fetchImpl: upstream, bridge, enabled: ['slack', 'teams', 'viber'], jwks: async () => undefined }));
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

test('http: teams without a valid JWT is rejected', async () => {
  assert.equal((await post('/teams/messages', raw('teams_personal.json'))).status, 401);
});

test('http: chatwoot webhook requires the inbox signature; unmapped conversation is a 200 skip', async () => {
  const body = raw('chatwoot_outgoing.json');
  assert.equal((await post('/chatwoot/viber', body)).status, 401);
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await post('/chatwoot/viber', body, { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': `sha256=${hmacHex('cw-viber', `${ts}.${body}`)}` });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 'skip:unmapped_conversation');
  assert.equal(senders.viber.sent.length, 0);
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
