import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { AgentConnect } from '../src/connect.ts';
import { seal } from '../src/crypto.ts';
import { signConnectLink, verifyConnectParams } from '../src/links.ts';
import { SlackUserOAuth } from '../src/platforms/slack.ts';
import { TeamsIntegration } from '../src/platforms/teams/index.ts';
import { Store } from '../src/store.ts';
import { fixture, makeBridge, PUBLIC_URL } from './helpers.ts';

const SECRET = 'link-secret';
const store = new Store(':memory:');
const slack = new SlackUserOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: `${PUBLIC_URL}/connect/slack/callback`, botToken: 'x', encryptionKey: 'k'.repeat(32) }, store);
const teams = new TeamsIntegration(
  { tenantId: 'kita-tenant', clientId: 'cid', clientSecret: 'sec', kitaUserUpn: 'kita@kita.ai', internalTenantIds: ['kita-tenant'], connectKey: 'connect-key-0123456789', teamIds: [], extraChannels: [], messageFormat: 'auto', encryptionKey: 'k'.repeat(32) },
  PUBLIC_URL, store, (async () => new Response('unexpected', { status: 500 })) as typeof fetch,
);
const whatsappNumbers = [{ phoneNumberId: '1098', inboxIdentifier: 'IN_WA', webhookSecret: 'w', ownerName: 'Carmel Limcaoco', agentEmail: 'Carmel@kita.ai', displayPhoneNumber: '+63 917 555 0100' }];
const connect = new AgentConnect({ linkSecret: SECRET, slack, teams, whatsappNumbers, deskUrl: 'https://support.internal.kita.ai' });
store.putKv('slack.agent.3.token', seal('k'.repeat(32), 'xoxp-carmel'));

const { bridge } = makeBridge();
const server = createServer(createHandler({ cfg: loadConfig(), store, bridge, enabled: [], connect }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bridges`;
after(() => server.close());

test('cross-language fixture: the desk (Ruby) and the bridge sign the same connect link', () => {
  const f = fixture('connect-link.json');
  assert.equal(signConnectLink(f.secret, f.publicUrl, f.agent, f.ttlDays, f.nowS), f.url);
  assert.deepEqual(verifyConnectParams(f.secret, new URL(f.url).searchParams, f.nowS + 1), { agentId: f.agent.id, email: f.agent.email.toLowerCase() });
});

test('status: per-agent Slack/Teams/WhatsApp/Viber', () => {
  assert.deepEqual(connect.status(3, 'carmel@kita.ai'), { slack: 'connected', teams: 'not_connected', whatsapp: '+63 917 555 0100', viber: 'not_applicable' });
  assert.deepEqual(connect.status(4, 'sam@kita.ai'), { slack: 'not_connected', teams: 'not_connected', whatsapp: 'none', viber: 'not_applicable' });
  // platforms not configured on this bridge
  assert.deepEqual(new AgentConnect({ linkSecret: SECRET }).status(3, 'carmel@kita.ai'), { slack: 'unavailable', teams: 'unavailable', whatsapp: 'none', viber: 'not_applicable' });
});

test('http: GET /connect/status requires the shared secret (server-to-server) or a signed link', async () => {
  const q = 'a=3&e=carmel%40kita.ai';
  assert.equal((await fetch(`${base}/connect/status?${q}`)).status, 401);
  assert.equal((await fetch(`${base}/connect/status?${q}`, { headers: { 'x-kita-bridge-secret': 'wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/connect/status`, { headers: { 'x-kita-bridge-secret': SECRET } })).status, 400);
  const ok = await fetch(`${base}/connect/status?${q}`, { headers: { 'x-kita-bridge-secret': SECRET } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { slack: 'connected', teams: 'not_connected', whatsapp: '+63 917 555 0100', viber: 'not_applicable' });
  const signed = new URL(signConnectLink(SECRET, PUBLIC_URL, { id: 4, email: 'sam@kita.ai' }));
  const bySignedLink = await fetch(`${base}/connect/status${signed.search}`);
  assert.equal(bySignedLink.status, 200);
  assert.equal((await bySignedLink.json()).slack, 'not_connected');
});

test('http: an expired or hand-typed connect link shows a friendly page pointing back to the desk', async () => {
  for (const path of ['/connect', '/connect?a=3&e=carmel%40kita.ai&x=1&s=bad', '/connect/slack/start?a=3']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /Open this from the desk: <b>Profile → Connect accounts<\/b>/);
    assert.match(html, /href="https:\/\/support\.internal\.kita\.ai\/app"/);
  }
});

test('http: the connect page shows all four platforms with their status', async () => {
  const signed = new URL(signConnectLink(SECRET, PUBLIC_URL, { id: 3, email: 'carmel@kita.ai' }));
  const res = await fetch(`${base}/connect${signed.search}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Slack<\/h2><span class="badge ok">Connected/);
  assert.match(html, /Microsoft Teams<\/h2><span class="badge todo">Not connected/);
  assert.match(html, /Your WhatsApp Business number is linked by an admin \(QR scan\)/);
  assert.match(html, /\+63 917 555 0100/);
  assert.match(html, /Replies go out through the Kita Viber bot\. Viber has no personal accounts for businesses, so there's no personal link\./);
  assert.match(html, /href="connect\/teams\/start\?a=3&amp;e=|href="connect\/teams\/start\?a=3&e=/);
  assert.doesNotMatch(html, /chatwoot/i);
});
