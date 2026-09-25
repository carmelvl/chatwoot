import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { GripLinks } from '../src/griplinks.ts';
import { Store } from '../src/store.ts';
import { makeBridge } from './helpers.ts';

const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
const grip = (async (input: any, init: any = {}) => {
  const url = new URL(String(input));
  calls.push({ method: init.method, path: url.pathname + url.search, auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : undefined });
  if (url.pathname === '/api/v1/crm/accounts') return Response.json({ success: true, data: [{ id: 'acc-1', company_name: 'Tala' }] });
  if (url.pathname === '/api/v1/support/channels')
    return Response.json({ success: true, data: [{ id: 'link-9', channel_key: 'teams:19:abc', account_id: null }] });
  if (url.pathname === '/api/v1/support/channels/link-9' && init.method === 'PATCH') return Response.json({ success: true, data: { ok: true } });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

let refreshes = 0;
const gripLinks = new GripLinks({ baseUrl: 'https://grip.test', apiKey: 'grip_key', fetchImpl: grip, refresh: async () => void refreshes++ });
const cfg = { ...loadConfig(), linkSecret: 'link-secret' };
const { bridge } = makeBridge();
const server = createServer(createHandler({ cfg, store: new Store(':memory:'), bridge, enabled: [], gripLinks, linkRefresh: async () => void refreshes++ }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bridges`;
after(() => server.close());

const call = (path: string, init: RequestInit = {}, secret: string | null = 'link-secret') =>
  fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(secret ? { 'x-kita-bridge-secret': secret } : {}) } });

test('internal endpoints require the bridge secret', async () => {
  assert.equal((await call('/internal/link-refresh', { method: 'POST' }, null)).status, 401);
  assert.equal((await call('/internal/grip/accounts?search=ta', {}, 'wrong-secret')).status, 401);
});

test('link-refresh refreshes scope (and merges) now', async () => {
  const before = refreshes;
  assert.equal((await call('/internal/link-refresh', { method: 'POST' })).status, 200);
  assert.equal(refreshes, before + 1);
});

test('accounts search and link go to Grip with the grip_ key, then refresh', async () => {
  const accounts = await (await call('/internal/grip/accounts?search=ta')).json();
  assert.deepEqual(accounts, { accounts: [{ id: 'acc-1', name: 'Tala' }] });

  const before = refreshes;
  const res = await call('/internal/grip/link', { method: 'POST', body: JSON.stringify({ channel_key: 'teams:19:abc', account_id: 'acc-1' }) });
  assert.equal(res.status, 200);
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.deepEqual([patch.path, patch.body, patch.auth], ['/api/v1/support/channels/link-9', { account_id: 'acc-1' }, 'Bearer grip_key']);
  assert.equal(refreshes, before + 1);

  const missing = await call('/internal/grip/link', { method: 'POST', body: JSON.stringify({ channel_key: 'slack:C9', account_id: 'acc-1' }) });
  assert.equal(missing.status, 404);
  assert.equal((await call('/internal/grip/link', { method: 'POST', body: '{}' })).status, 422);
});
