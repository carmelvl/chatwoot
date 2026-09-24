import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { verifyChatwootSignature } from '../src/chatwoot.ts';
import { hmacHex } from '../src/crypto.ts';
import { raw, world } from './helpers.ts';

const SECRET = 'cw-account-webhook-secret';
const w = world();
let kicks = 0;
const server = createServer(createHandler({ webhookSecret: SECRET, sync: w.sync, kick: () => kicks++ }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/grip-sync`;
after(() => server.close());

const sign = (body: string, ts = String(Math.floor(Date.now() / 1000)), secret = SECRET) => ({
  'x-chatwoot-timestamp': ts,
  'x-chatwoot-signature': `sha256=${hmacHex(secret, `${ts}.${body}`)}`,
});
const post = (body: string, headers: Record<string, string>) =>
  fetch(`${base}/chatwoot/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

test('signature: valid account-webhook signature accepted and ingested', async () => {
  const body = raw('message_incoming_slack.json');
  const res = await post(body, { ...sign(body), 'x-chatwoot-delivery': 'uuid-1' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 'ok');
  assert.equal(kicks, 1);
  assert.equal(w.store.getConversation(42)!.messageCount, 1);
});

test('signature: wrong secret, tampered body, missing headers and stale timestamps are 401', async () => {
  const body = raw('message_incoming_slack.json');
  assert.equal((await post(body, sign(body, undefined, 'wrong'))).status, 401);
  assert.equal((await post(body.replace('500s', '404s'), sign(body))).status, 401);
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, sign(body, String(Math.floor(Date.now() / 1000) - 600)))).status, 401);
});

test('signature: unit check, and an empty configured secret rejects everything', () => {
  const ts = '1790301480';
  const sig = `sha256=${hmacHex('s', `${ts}.{}`)}`;
  assert.equal(verifyChatwootSignature('s', '{}', { signature: sig, timestamp: ts }, 1790301480), true);
  assert.equal(verifyChatwootSignature('', '{}', { signature: sig, timestamp: ts }, 1790301480), false);
  assert.equal(verifyChatwootSignature('s', '{}', { signature: sig, timestamp: 'abc' }, 1790301480), false);
});

test('http: duplicate delivery id acknowledged as duplicate; bad JSON 400; unknown path 404; healthz', async () => {
  const body = raw('message_outgoing_agent.json');
  assert.equal((await (await post(body, { ...sign(body), 'x-chatwoot-delivery': 'uuid-2' })).json()).result, 'ok');
  assert.equal((await (await post(body, { ...sign(body), 'x-chatwoot-delivery': 'uuid-2' })).json()).result, 'duplicate');
  assert.equal((await post('{nope', sign('{nope'))).status, 400);
  assert.equal((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status, 404);
  const hz = await fetch(`${base}/healthz`);
  assert.equal(hz.status, 200);
  // also reachable without the /grip-sync prefix (Caddy handle_path strips it)
  assert.equal((await fetch(base.replace('/grip-sync', '/healthz'))).status, 200);
});
