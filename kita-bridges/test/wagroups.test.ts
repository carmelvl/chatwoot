import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/app.ts';
import { Bridge } from '../src/bridge.ts';
import { loadConfig } from '../src/config.ts';
import { parseInternalInbound, WaGroupSender } from '../src/wagroups.ts';
import { fixture, makeBridge, PUBLIC_URL, staticScope } from './helpers.ts';

const G = '120363040000000001@g.us';
const payload = (o: Record<string, unknown> = {}) => ({
  platform: 'whatsapp',
  channel_key: `whatsapp-group:${G}`,
  channel_label: 'Kita x Tala',
  event_id: `wag:${G}:M1`,
  user_key: '+639181112222',
  user_name: 'Maria Santos',
  contact_identifier: 'whatsapp:+639181112222',
  author: 'customer',
  text: 'The upload failed',
  attachments: [],
  created_at: 1758000000,
  ...o,
});

const cfg = loadConfig();
cfg.linkSecret = 'link-secret';
const { bridge, cw, deskCalls, store } = makeBridge();
const server = createServer(createHandler({ cfg, store, bridge, enabled: [] }));
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bridges`;
after(() => server.close());
const post = (body: unknown, secret = 'link-secret') =>
  fetch(`${base}/internal/inbound`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': secret } });

test('internal inbound: needs the bridge secret; rejects anything but a valid WhatsApp-group message', async () => {
  assert.equal((await post(payload(), 'wrong')).status, 401);
  for (const bad of [payload({ platform: 'slack' }), payload({ channel_key: 'slack:C1' }), payload({ channel_key: 'whatsapp:+63917' }), payload({ author: 'bot' }), payload({ event_id: '' }), payload({ attachments: [{ url: '' }] }), payload({ text: 5 })])
    assert.equal((await post(bad)).status, 422, JSON.stringify(bad));
});

test('internal inbound: group message lands in the Customers inbox under the group, authored by the person; deduped', async () => {
  const r = await post(payload());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result, 'created');
  const contacts = cw.calls.filter((c) => c.path.endsWith('/contacts')).map((c) => [c.body.identifier, c.body.name]);
  assert.deepEqual(contacts, [[`whatsapp-channel:whatsapp-group:${G}`, 'Kita x Tala'], ['whatsapp:+639181112222', 'Maria Santos']]);
  const msg = cw.calls.find((c) => c.path.endsWith('/messages'))!;
  assert.equal(msg.body.content, 'The upload failed');
  assert.equal(msg.body.echo_id, `whatsapp:wag:${G}:M1`);
  assert.equal(msg.body.sender_identifier, 'whatsapp:+639181112222');
  assert.equal(msg.body.content_attributes.external_channel, 'Kita x Tala');
  assert.equal(msg.body.content_attributes.external_channel_key, `whatsapp-group:${G}`);
  assert.equal((await (await post(payload())).json()).result, 'duplicate');
});

test('internal inbound: a quote becomes in_reply_to; Kita staff go through the desk as the agent', async () => {
  const r = await post(payload({ event_id: `wag:${G}:M2`, text: 'Same', thread: { root: `wag:${G}:M1`, reply: true } }));
  assert.equal((await r.json()).result, 'appended');
  const reply = cw.calls.filter((c) => c.path.endsWith('/messages')).at(-1)!;
  assert.equal(reply.body.content_attributes.in_reply_to, 1);
  const staff = await post(payload({ event_id: `wag:${G}:M3`, author: 'staff', user_key: '+639171234567', user_name: 'Carmel', user_email: 'Carmel@kita.ai', text: 'On it' }));
  assert.equal((await staff.json()).result, 'staff_synced');
  const d = deskCalls.at(-1)!;
  assert.equal(d.body.email, 'carmel@kita.ai');
  assert.equal(d.body.staff_key, 'whatsapp:+639171234567');
});

test('parse: attachments (with the fetch header), created_at and backfill pass through', () => {
  const m = parseInternalInbound(payload({ backfill: true, attachments: [{ url: 'http://wa-groups:8090/wa-groups/internal/media/t', name: 'a.jpg', content_type: 'image/jpeg', headers: { 'x-kita-bridge-secret': 's' } }] }))!;
  assert.deepEqual(m.attachments, [{ url: 'http://wa-groups:8090/wa-groups/internal/media/t', name: 'a.jpg', contentType: 'image/jpeg', headers: { 'x-kita-bridge-secret': 's' } }]);
  assert.equal(m.createdAt, 1758000000);
  assert.equal(m.backfill, true);
  assert.deepEqual(m.replyRef, { groupJid: G });
});

const agentReply = (id: number, conversationId: number) => ({ ...fixture('chatwoot_outgoing.json'), attachments: [], id, conversation: { id: conversationId }, content: 'Fixed, try again' });

test('outbound: WhatsApp groups are mirror-only by default (private note, nothing sent)', async () => {
  const { bridge: b, appCalls, store: s } = makeBridge();
  await b.inbound(parseInternalInbound(payload())!);
  const conv = s.listConversations('customers', 'channel:')[0];
  assert.equal(await b.outbound(agentReply(9001, conv.conversationId)), 'skip:mirror');
  assert.equal(appCalls.at(-1)!.body.private, true);
});

test('outbound: with the group sender (WA_GROUPS_SEND=on) the reply posts into the group, echo pre-marked', async () => {
  const { store: s, cw: c } = makeBridge();
  const sent: any[] = [];
  const sender = new WaGroupSender('http://wa-groups:8090', 'link-secret', (async (u: any, init: any) => {
    sent.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ event_id: `wag:${G}:OUT1` });
  }) as typeof fetch);
  const b = new Bridge({ store: s, chatwoot: c.client, inbox: 'IN_CUSTOMERS', senders: {}, publicUrl: PUBLIC_URL, fetchImpl: c.fetchImpl, scope: staticScope(), groupSender: sender });
  await b.inbound(parseInternalInbound(payload())!);
  const conv = s.listConversations('customers', 'channel:')[0];
  assert.equal(await b.outbound(agentReply(9002, conv.conversationId)), 'sent');
  assert.deepEqual(sent[0], { url: 'http://wa-groups:8090/wa-groups/internal/send', headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': 'link-secret' }, body: { group_jid: G, text: 'Fixed, try again' } });
  // The group's copy of our own reply comes back from WhatsApp: never mirrored in again
  assert.equal(await b.inbound(parseInternalInbound(payload({ event_id: `wag:${G}:OUT1`, author: 'staff' }))!), 'duplicate');
});
