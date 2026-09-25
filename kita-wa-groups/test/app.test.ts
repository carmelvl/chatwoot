import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler, type WaApi } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { pairSignature } from '../src/crypto.ts';
import { JoinError } from '../src/wa.ts';

const SECRET = 'link-secret-0123456789';
const cfg = { ...loadConfig(), linkSecret: SECRET };
const joins: unknown[] = [];
const wa: WaApi = {
  status: 'pairing',
  qr: '2@qr',
  number: undefined,
  groups: () => [{ jid: 'g@g.us', subject: 'Kita x Tala', participants: 4, joinedAt: 1 }],
  join: async (link) => {
    joins.push(link);
    if (link === 'bad') throw new JoinError(422, 'invalid_invite_link');
    return { jid: 'g@g.us', subject: 'Kita x Tala' };
  },
  send: async () => 'wag:g@g.us:1',
  logout: async () => {},
};
const server = createServer(createHandler({ cfg, wa, mirror: { media: async (t) => (t === 'a'.repeat(32) ? Buffer.from('BYTES') : undefined) }, qrSvg: async (qr) => `<svg data-qr="${qr}"></svg>` }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/wa-groups`;
after(() => server.close());
const auth = { 'x-kita-bridge-secret': SECRET, 'content-type': 'application/json' };

test('healthz reports connection, number and group count (no secret needed)', async () => {
  const r = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(r, { ok: true, connected: false, status: 'pairing', number: null, groups: 1 });
});

test('pair page: signed link or secret shows the self-refreshing QR; bad/expired links are refused', async () => {
  const x = String(Math.floor(Date.now() / 1000) + 600);
  const ok = await fetch(`${base}/pair?x=${x}&s=${pairSignature(SECRET, x)}`);
  const body = await ok.text();
  assert.equal(ok.status, 200);
  assert.match(body, /data-qr="2@qr"/);
  assert.match(body, /http-equiv="refresh"/);
  assert.equal(ok.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/pair`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/pair?x=${x}&s=${'0'.repeat(64)}`)).status, 403);
  const old = String(Math.floor(Date.now() / 1000) - 1);
  assert.equal((await fetch(`${base}/pair?x=${old}&s=${pairSignature(SECRET, old)}`)).status, 403);
});

test('pair page says "Connected as +…" once paired', async () => {
  wa.status = 'connected';
  wa.number = '14155550100';
  const body = await (await fetch(`${base}/pair`, { headers: auth })).text();
  assert.match(body, /Connected as \+14155550100/);
  assert.doesNotMatch(body, /refresh/);
  wa.status = 'pairing';
  wa.number = undefined;
});

test('join / groups / status need the bridge secret', async () => {
  assert.equal((await fetch(`${base}/join`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/groups`, { headers: { 'x-kita-bridge-secret': 'wrong' } })).status, 401);
  const ok = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ invite_link: 'https://chat.whatsapp.com/x' }) });
  assert.deepEqual(await ok.json(), { jid: 'g@g.us', subject: 'Kita x Tala' });
  const bad = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ invite_link: 'bad' }) });
  assert.equal(bad.status, 422);
  assert.deepEqual(await bad.json(), { error: 'invalid_invite_link' });
  assert.equal((await fetch(`${base}/join`, { method: 'POST', headers: auth, body: '{nope' })).status, 400);
  const s = await (await fetch(`${base}/status`, { headers: auth })).json();
  assert.equal(s.send_enabled, false);
  assert.equal(s.groups.length, 1);
});

test('internal media is secret-protected and token-shaped', async () => {
  assert.equal((await fetch(`${base}/internal/media/${'a'.repeat(32)}`)).status, 401);
  const r = await fetch(`${base}/internal/media/${'a'.repeat(32)}`, { headers: auth });
  assert.equal(await r.text(), 'BYTES');
  assert.equal((await fetch(`${base}/internal/media/${'b'.repeat(32)}`, { headers: auth })).status, 404);
});
