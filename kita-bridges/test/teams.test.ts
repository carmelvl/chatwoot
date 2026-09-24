import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { authorizeTeamsAttachments, buildTeamsActivity, parseTeamsActivity, TeamsSender, teamsText, verifyTeamsJwt } from '../src/platforms/teams.ts';
import { fixture } from './helpers.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
const jwks = async (kid: string) => (kid === 'k1' ? jwk : undefined);
const NOW = 1790000000;
const APP = 'kita-bot-app-id';
const SVC = 'https://smba.trafficmanager.net/amer/';

function sign(claims: Record<string, unknown>, key = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b(header)}.${b(claims)}`;
  const s = createSign('RSA-SHA256').update(input).sign(key).toString('base64url');
  return `Bearer ${input}.${s}`;
}
const good = { iss: 'https://api.botframework.com', aud: APP, exp: NOW + 3600, nbf: NOW - 10, serviceurl: SVC };

test('teams JWT: valid Bot Framework token accepted', async () => {
  const r = await verifyTeamsJwt(sign(good), { appId: APP, serviceUrl: SVC, jwks, nowS: NOW });
  assert.equal(r.ok, true);
});

test('teams JWT: rejects forged signature, wrong audience/issuer, expiry, serviceUrl mismatch, alg none', async () => {
  const v = (h: string | undefined, serviceUrl = SVC) => verifyTeamsJwt(h, { appId: APP, serviceUrl, jwks, nowS: NOW }).then((r) => (r.ok ? 'ok' : r.reason));
  assert.equal(await v(sign(good, other.privateKey)), 'signature');
  assert.equal(await v(sign({ ...good, aud: 'someone-else' })), 'audience');
  assert.equal(await v(sign({ ...good, iss: 'https://evil.example' })), 'issuer');
  assert.equal(await v(sign({ ...good, exp: NOW - 3600 })), 'expired');
  assert.equal(await v(sign(good), 'https://smba.trafficmanager.net/emea/'), 'service_url');
  assert.equal(await v(sign(good, privateKey, { alg: 'none', kid: 'k1' })), 'alg');
  assert.equal(await v(sign(good, privateKey, { alg: 'RS256', kid: 'unknown' })), 'unknown_kid');
  assert.equal(await v(undefined), 'missing_bearer');
  assert.equal(await v('Bearer abc'), 'malformed');
});

test('teams personal chat: contact = AAD object id, thread = conversation id, reference stored', () => {
  const p = parseTeamsActivity(fixture('teams_personal.json'));
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.equal(p.message.userKey, 'aad-dana-0001');
  assert.equal(p.message.threadKey, 'a:1personalCONV');
  assert.deepEqual(p.message.replyRef, { serviceUrl: SVC, conversationId: 'a:1personalCONV', botId: '28:kita-bot-app-id', tenantId: 'tenant-cust-01', conversationType: 'personal' });
  assert.deepEqual(p.message.attachments, [{ url: 'https://cust.sharepoint.com/download/log.txt', name: 'log.txt' }]);
});

test('teams channel mention: strips <at> + HTML, thread is the channel reply chain, html dup attachment dropped', () => {
  const p = parseTeamsActivity(fixture('teams_channel_mention.json'));
  assert.equal(p.kind, 'message');
  if (p.kind !== 'message') return;
  assert.equal(p.message.text, 'payouts are delayed & stuck');
  assert.equal(p.message.threadKey, '19:abc@thread.tacv2;messageid=1790000000000');
  assert.equal(p.message.attachments.length, 1);
  const authed = authorizeTeamsAttachments(p.message, 'TOKEN');
  assert.deepEqual(authed.attachments[0].headers, { authorization: 'Bearer TOKEN' });
});

test('teams: non-message activities and bot echoes are ignored', () => {
  assert.deepEqual(parseTeamsActivity(fixture('teams_conversation_update.json')), { kind: 'ignore', reason: 'type:conversationUpdate' });
  const echo = fixture('teams_personal.json');
  echo.from = { id: '28:kita-bot-app-id' };
  assert.deepEqual(parseTeamsActivity(echo), { kind: 'ignore', reason: 'bot' });
});

test('teams outbound transform: markdown text, file links, image attachments', () => {
  const a = buildTeamsActivity({ botId: '28:kita-bot-app-id' }, {
    messageId: 1, conversationId: 1, text: 'Fixed',
    attachments: [{ url: 'https://x/s.png', name: 's.png', fileType: 'image' }, { url: 'https://x/g.pdf', name: 'g.pdf' }],
  });
  assert.equal(a.textFormat, 'markdown');
  assert.equal(a.text, 'Fixed\n\n[g.pdf](https://x/g.pdf)');
  assert.deepEqual(a.attachments, [{ contentType: 'image/*', contentUrl: 'https://x/s.png', name: 's.png' }]);
  assert.equal(teamsText('a<br/>b'), 'a\nb');
});

test('teams proactive send: token is cached and activity posted to stored serviceUrl/conversation', async () => {
  const calls: string[] = [];
  const f = (async (url: any, init: any) => {
    calls.push(`${init.method} ${url}`);
    if (String(url).includes('login.microsoftonline.com')) return Response.json({ access_token: 'AT', expires_in: 3600 });
    assert.equal(init.headers.authorization, 'Bearer AT');
    return Response.json({ id: 'x' });
  }) as typeof fetch;
  const s = new TeamsSender({ appId: APP, appPassword: 'pw', tenantId: 'kita-tenant' }, f);
  const ref = { serviceUrl: SVC, conversationId: '19:abc@thread.tacv2;messageid=1', botId: '28:b' };
  await s.send(ref, { messageId: 1, conversationId: 1, text: 'hi', attachments: [] });
  await s.send(ref, { messageId: 2, conversationId: 1, text: 'again', attachments: [] });
  assert.deepEqual(calls, [
    'POST https://login.microsoftonline.com/kita-tenant/oauth2/v2.0/token',
    'POST https://smba.trafficmanager.net/amer/v3/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D1/activities',
    'POST https://smba.trafficmanager.net/amer/v3/conversations/19%3Aabc%40thread.tacv2%3Bmessageid%3D1/activities',
  ]);
});
