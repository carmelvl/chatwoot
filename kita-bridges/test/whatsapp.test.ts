import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Bridge } from '../src/bridge.ts';
import { ChatwootAppClient, KitaDeskClient } from '../src/chatwoot.ts';
import { createHandler, MIRROR_NOTE } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { hmacHex } from '../src/crypto.ts';
import { Store } from '../src/store.ts';
import {
  e164, parseWhatsAppWebhook, resolveMedia, verifyWhatsAppSignature, verifyWhatsAppSubscription, whatsappChannelKey, type WhatsAppNumber,
} from '../src/platforms/whatsapp.ts';
import type { Platform } from '../src/types.ts';
import { fakeChatwoot, fixture, PUBLIC_URL, raw } from './helpers.ts';

const numbers: WhatsAppNumber[] = [
  { phoneNumberId: '111111111111111', inboxIdentifier: 'IN_WA_CARMEL', webhookSecret: 'cw-wa-carmel', ownerName: 'Carmel Limcaoco' },
  { phoneNumberId: '222222222222222', inboxIdentifier: 'IN_WA_RHEA', webhookSecret: 'cw-wa-rhea', ownerName: 'Rhea Malhotra', agentAccessToken: 'RHEA_TOKEN' },
];

test('Cloud API signature: X-Hub-Signature-256 = sha256=HMAC(app secret, raw body)', () => {
  const body = raw('wa_messages_text.json');
  assert.equal(verifyWhatsAppSignature('app-secret', body, `sha256=${hmacHex('app-secret', body)}`), true);
  assert.equal(verifyWhatsAppSignature('app-secret', body, `sha256=${hmacHex('other', body)}`), false);
  assert.equal(verifyWhatsAppSignature('app-secret', body.replace('approved', 'rejected'), `sha256=${hmacHex('app-secret', body)}`), false);
  assert.equal(verifyWhatsAppSignature('app-secret', body, undefined), false);
});

test('webhook verification handshake (GET hub.challenge)', () => {
  assert.equal(verifyWhatsAppSubscription('vt', new URLSearchParams('hub.mode=subscribe&hub.verify_token=vt&hub.challenge=1158201444')), '1158201444');
  assert.equal(verifyWhatsAppSubscription('vt', new URLSearchParams('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')), undefined);
  assert.equal(verifyWhatsAppSubscription('vt', new URLSearchParams('hub.mode=unsubscribe&hub.verify_token=vt&hub.challenge=1')), undefined);
});

test('customer message -> incoming in that number\'s inbox; contact whatsapp:+E164; channel_key for Grip', () => {
  const { items, skipped } = parseWhatsAppWebhook(fixture('wa_messages_text.json'), numbers);
  assert.deepEqual(skipped, []);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.kind, 'customer');
  assert.equal(it.message.inboxIdentifier, 'IN_WA_CARMEL');
  assert.equal(it.message.contactIdentifier, 'whatsapp:+639998887777');
  assert.equal(it.message.conversationAttributes!.channel_key, 'whatsapp:+639998887777');
  assert.equal(it.message.userName, 'Maria Santos');
  assert.equal(it.message.text, 'Hi Carmel, is the loan approved?');
  assert.equal(it.message.threadKey, '111111111111111:639998887777');
  assert.equal(it.message.newConversationIfResolved, true);
  assert.equal(e164('639998887777'), '+639998887777');
  assert.equal(whatsappChannelKey('+639998887777'), 'whatsapp:+639998887777');
});

test('phone-app echo -> business echo for the customer in `to`; multiple numbers route to their own inbox; revoke skipped', () => {
  const a = parseWhatsAppWebhook(fixture('wa_echo_text.json'), numbers);
  assert.equal(a.items[0].kind, 'echo');
  assert.equal(a.items[0].message.contactIdentifier, 'whatsapp:+639998887777');
  assert.equal(a.items[0].number.ownerName, 'Carmel Limcaoco');
  const b = parseWhatsAppWebhook(fixture('wa_echo_document_and_revoke.json'), numbers);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].message.inboxIdentifier, 'IN_WA_RHEA');
  assert.equal(b.items[0].message.text, "Here's the offer");
  assert.deepEqual(b.items[0].media, [{ mediaId: 'MEDIA_ID_2', name: 'offer.pdf', contentType: 'application/pdf' }]);
  assert.deepEqual(b.skipped, ['echo_type:revoke']);
});

test('statuses, history, smb_app_state_sync and unknown numbers are acknowledged but not mirrored', () => {
  const { items, skipped } = parseWhatsAppWebhook(fixture('wa_statuses_history.json'), numbers);
  assert.equal(items.length, 0);
  assert.deepEqual(skipped, ['statuses:1', 'field:history', 'field:smb_app_state_sync', 'unknown_number']);
});

test('media: GET /<media-id> then download the URL with the same bearer token', async () => {
  const calls: string[] = [];
  const f = (async (u: any, init: any) => {
    calls.push(`${String(u)} ${init.headers.authorization}`);
    return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg' });
  }) as typeof fetch;
  const { items } = parseWhatsAppWebhook(fixture('wa_messages_image.json'), numbers);
  assert.equal(items[0].message.text, 'my ID');
  const atts = await resolveMedia(items[0].media, 'WA_TOKEN', f);
  assert.deepEqual(calls, ['https://graph.facebook.com/v21.0/MEDIA_ID_1 Bearer WA_TOKEN']);
  assert.deepEqual(atts, [{ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', name: 'image-wamid.IMG1.jpeg', contentType: 'image/jpeg', headers: { authorization: 'Bearer WA_TOKEN' } }]);
});

// ---------- bridge + HTTP end to end ----------

function world() {
  const cw = fakeChatwoot();
  const store = new Store(':memory:');
  const appPosts: { token: string; conv: string; body: any }[] = [];
  let id = 7000;
  const appFetch = (async (u: any, init: any) => {
    const body = init.body instanceof FormData ? { content: init.body.get('content'), private: init.body.get('private') === 'true', files: init.body.getAll('attachments[]').map((f: any) => f.name) } : JSON.parse(init.body);
    appPosts.push({ token: init.headers['api-access-token'], conv: String(u).split('/conversations/')[1].split('/')[0], body });
    return Response.json({ id: ++id });
  }) as typeof fetch;
  const app = new ChatwootAppClient('http://rails:3000', 'BRIDGE_TOKEN', '1', appFetch);
  const rheaApp = new ChatwootAppClient('http://rails:3000', 'RHEA_TOKEN', '1', appFetch);
  const inboxes = { slack: { inboxIdentifier: '' }, teams: { inboxIdentifier: '' }, viber: { inboxIdentifier: '' }, whatsapp: { inboxIdentifier: '' } } as Record<Platform, { inboxIdentifier: string }>;
  // Media download + public API both served by the fake Chatwoot fetch; Graph media lookups answered here.
  const fetchImpl = (async (u: any, init: any = {}) => {
    if (String(u).startsWith('https://graph.facebook.com/')) return Response.json({ url: 'https://lookaside.fbsbx.com/m/2', mime_type: 'application/pdf' });
    return cw.fetchImpl(u, init);
  }) as typeof fetch;
  const deskPosts: any[] = [];
  const deskFetch = (async (_u: any, init: any) => {
    const body = init.body instanceof FormData ? { ...Object.fromEntries([...init.body.entries()].filter(([k]) => k !== 'attachments[]')), files: init.body.getAll('attachments[]').map((f: any) => f.name) } : JSON.parse(init.body);
    deskPosts.push(body);
    return Response.json({ id: ++id });
  }) as typeof fetch;
  const desk = new KitaDeskClient('https://support.internal.kita.ai', 'link-secret', deskFetch);
  const bridge = new Bridge({ store, chatwoot: cw.client, inboxes, senders: {}, publicUrl: PUBLIC_URL, app, desk, fetchImpl });
  return { cw, store, appPosts, deskPosts, bridge, rheaApp, fetchImpl };
}

const cfg = loadConfig();
cfg.whatsapp = { appSecret: 'app-secret', verifyToken: 'vt', accessToken: 'WA_TOKEN', numbers };
const w = world();
const server = createServer(createHandler({ cfg, store: w.store, bridge: w.bridge, enabled: ['whatsapp'], fetchImpl: w.fetchImpl, whatsappOwnerApps: new Map([['222222222222222', w.rheaApp]]) }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const postSigned = (path: string, body: string) => fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${hmacHex('app-secret', body)}` } });
const settle = () => new Promise((r) => setTimeout(r, 30));

test('http: GET handshake, unsigned POST rejected', async () => {
  assert.equal(await (await fetch(`${base}/bridges/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`)).text(), '42');
  assert.equal((await fetch(`${base}/bridges/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=42`)).status, 403);
  assert.equal((await fetch(`${base}/whatsapp/webhook`, { method: 'POST', body: raw('wa_messages_text.json') })).status, 401);
});

test('e2e: customer message then phone-app echo land in the same conversation (incoming, then outgoing as the owner)', async () => {
  assert.equal((await postSigned('/whatsapp/webhook', raw('wa_messages_text.json'))).status, 200);
  await settle();
  const contact = w.cw.calls.find((c) => c.path === '/public/api/v1/inboxes/IN_WA_CARMEL/contacts')!;
  assert.equal(contact.body.identifier, 'whatsapp:+639998887777');
  assert.equal(contact.body.name, 'Maria Santos');
  assert.equal(contact.body.email, undefined);
  const conv = w.cw.calls.find((c) => c.path.endsWith('/conversations'))!;
  assert.equal(conv.body.custom_attributes.channel_key, 'whatsapp:+639998887777');

  await postSigned('/whatsapp/webhook', raw('wa_echo_text.json'));
  await postSigned('/whatsapp/webhook', raw('wa_echo_text.json')); // Meta retry
  await settle();
  assert.equal(w.appPosts.filter((p) => !p.body.private).length, 0); // never the shared bridge user
  assert.equal(w.deskPosts.length, 1);
  const echo = w.deskPosts[0];
  assert.equal(echo.conversation_id, 100); // same conversation as the customer's message
  assert.equal(echo.content, 'Yes Maria, approved today!'); // no name prefix: authored by the owner
  assert.equal(echo.name, 'Carmel Limcaoco');
  assert.equal(echo.staff_key, 'whatsapp:111111111111111');
  assert.deepEqual(echo.content_attributes, { external_source: 'whatsapp' });
});

test('e2e: echo to a new customer creates the conversation, authored by the number\'s owner; media attached', async () => {
  await postSigned('/whatsapp/webhook', raw('wa_echo_document_and_revoke.json'));
  await settle();
  assert.ok(w.cw.calls.some((c) => c.path === '/public/api/v1/inboxes/IN_WA_RHEA/contacts' && c.body.identifier === 'whatsapp:+639991112222'));
  const rhea = w.deskPosts.find((p) => p.name === 'Rhea Malhotra')!;
  assert.equal(rhea.content, "Here's the offer");
  assert.deepEqual(rhea.files, ['offer.pdf']);
});

test('mirror mode: an agent typing in the desk sends nothing and gets a private note (once); our own echoes never loop', async () => {
  const payload = { ...fixture('chatwoot_outgoing.json'), attachments: [], conversation: { id: 100 } };
  const body = JSON.stringify(payload);
  const sign = (b: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'x-chatwoot-timestamp': ts, 'x-chatwoot-signature': `sha256=${hmacHex('cw-wa-carmel', `${ts}.${b}`)}` };
  };
  const hit = (b: string) => fetch(`${base}/chatwoot/whatsapp/111111111111111`, { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...sign(b) } }).then((r) => r.json());
  const before = w.appPosts.length;
  assert.equal((await hit(body)).result, 'skip:mirror');
  assert.equal((await hit(body)).result, 'skip:duplicate');
  const notes = w.appPosts.slice(before);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].body, { content: MIRROR_NOTE.whatsapp, message_type: 'outgoing', private: true, content_attributes: { kita_bridge_origin: true } });
  // the echo we mirrored comes back as an outgoing webhook: skipped, never re-noted
  assert.equal((await hit(JSON.stringify({ ...payload, id: 9999, content_attributes: { kita_bridge_origin: true } }))).result, 'skip:external_echo');
  // wrong number secret
  const bad = await fetch(`${base}/chatwoot/whatsapp/222222222222222`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...sign(body) } });
  assert.equal(bad.status, 401);
});

test('the desk never sends on WhatsApp: the mirror note says to reply in WhatsApp yourself', () => {
  assert.match(MIRROR_NOTE.whatsapp, /^Reply in WhatsApp yourself — this inbox is a mirror\./);
});

test('phone-app echo with the owner\'s agentEmail is authored by that desk agent (no prefix, no tokens in the bridge)', async () => {
  const deskCalls: any[] = [];
  const desk = new KitaDeskClient('https://support.internal.kita.ai', 'link-secret', (async (_u: any, init: any) => (deskCalls.push(JSON.parse(init.body)), Response.json({ id: 8100 }))) as typeof fetch);
  process.env.EMAIL_DOMAIN_ALIASES = 'usekita.com=kita.ai';
  const cw = fakeChatwoot();
  const store = new Store(':memory:');
  const bridge = new Bridge({ store, chatwoot: cw.client, inboxes: {} as any, senders: {}, publicUrl: PUBLIC_URL, desk, fetchImpl: cw.fetchImpl });
  const echo = parseWhatsAppWebhook(fixture('wa_echo_text.json'), numbers).items.find((i) => i.kind === 'echo')!;
  assert.equal(await bridge.businessEcho({ ...echo.message, attachments: [] }, { ownerName: 'Carmel Limcaoco', ownerEmail: 'carmel@kita.ai', ownerKey: 'whatsapp:111' }), 'staff_synced');
  assert.equal(deskCalls[0].email, 'carmel@kita.ai');
  assert.equal(deskCalls[0].content, 'Yes Maria, approved today!');
  assert.equal(deskCalls[0].content_attributes.external_source, 'whatsapp');
  assert.equal(store.isSeen('out:whatsapp:8100'), true); // never sent back out
});


test('BSUID tolerance: phone preferred; business-scoped user id used only when the phone is withheld', () => {
  const echo = fixture('wa_echo_text.json');
  const e = echo.entry[0].changes[0].value;
  delete e.message_echoes[0].to;
  e.message_echoes[0].to_user_id = 'IN.2081978709342942';
  const p = parseWhatsAppWebhook(echo, numbers);
  assert.equal(p.items[0].message.contactIdentifier, 'whatsapp:IN.2081978709342942');
  e.contacts = [{ wa_id: '639998887777', user_id: 'IN.2081978709342942' }];
  assert.equal(parseWhatsAppWebhook(echo, numbers).items[0].message.contactIdentifier, 'whatsapp:+639998887777');
});
