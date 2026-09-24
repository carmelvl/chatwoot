import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hmacHex } from '../src/crypto.ts';
import { ChatwootClient, toOutbound, verifyChatwootSignature } from '../src/chatwoot.ts';
import { fixture, raw } from './helpers.ts';

test('chatwoot signature: accepts the exact scheme from lib/webhooks/trigger.rb', () => {
  const body = raw('chatwoot_outgoing.json');
  const ts = '1790000000';
  const sig = `sha256=${hmacHex('inbox-secret', `${ts}.${body}`)}`;
  assert.equal(verifyChatwootSignature('inbox-secret', body, { signature: sig, timestamp: ts }, 1790000010), true);
});

test('chatwoot signature: rejects wrong secret, tampered body, stale timestamp, missing headers', () => {
  const body = raw('chatwoot_outgoing.json');
  const ts = '1790000000';
  const sig = `sha256=${hmacHex('inbox-secret', `${ts}.${body}`)}`;
  assert.equal(verifyChatwootSignature('other', body, { signature: sig, timestamp: ts }, 1790000000), false);
  assert.equal(verifyChatwootSignature('inbox-secret', body + ' ', { signature: sig, timestamp: ts }, 1790000000), false);
  assert.equal(verifyChatwootSignature('inbox-secret', body, { signature: sig, timestamp: ts }, 1790000000 + 3600), false);
  assert.equal(verifyChatwootSignature('inbox-secret', body, { timestamp: ts }, 1790000000), false);
  assert.equal(verifyChatwootSignature('', body, { signature: sig, timestamp: ts }, 1790000000), false);
});

test('toOutbound: agent reply becomes an outbound message with attachments', () => {
  const d = toOutbound(fixture('chatwoot_outgoing.json'));
  assert.equal(d.send, true);
  if (!d.send) return;
  assert.equal(d.message.conversationId, 42);
  assert.equal(d.message.messageId, 9001);
  assert.equal('agentName' in d.message, false); // always sent as the Kita bot
  assert.deepEqual(d.message.attachments.map((a) => a.name), ['steps.png', 'guide.pdf']);
});

test('toOutbound loop prevention: private notes, incoming echoes, other events, empty content are skipped', () => {
  assert.deepEqual(toOutbound(fixture('chatwoot_private_note.json')), { send: false, reason: 'private_note' });
  assert.deepEqual(toOutbound(fixture('chatwoot_incoming_echo.json')), { send: false, reason: 'type:incoming' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_outgoing.json'), event: 'message_updated' }), { send: false, reason: 'event:message_updated' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_outgoing.json'), message_type: 'activity' }), { send: false, reason: 'type:activity' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_outgoing.json'), content: '', attachments: [] }), { send: false, reason: 'empty' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_outgoing.json'), content_attributes: { kita_bridge_origin: true } }), { send: false, reason: 'external_echo' });
});

test('toOutbound never leaks Chatwoot: CSAT surveys, interactive types and survey links are not sent', () => {
  assert.deepEqual(toOutbound(fixture('chatwoot_csat.json')), { send: false, reason: 'content_type:input_csat' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_outgoing.json'), content_type: 'input_select' }), { send: false, reason: 'content_type:input_select' });
  assert.deepEqual(toOutbound({ ...fixture('chatwoot_csat.json'), content_type: 'text' }), { send: false, reason: 'survey_link' });
});

test('createContact never sends an email (no Chatwoot email notifications/continuity for bridge contacts)', async () => {
  let sent: any;
  const f = (async (_u: any, init: any) => { sent = JSON.parse(init.body); return Response.json({ source_id: 's' }); }) as typeof fetch;
  await new ChatwootClient('http://rails:3000', f).createContact('IN', { identifier: 'slack:U1', name: 'Ana', custom_attributes: { channel: 'slack' }, email: 'ana@cust.com', phone_number: '+63' } as any);
  assert.deepEqual(Object.keys(sent).sort(), ['custom_attributes', 'identifier', 'name']);
});
