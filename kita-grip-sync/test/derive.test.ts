import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationBody, deriveChannelKey, platformOf, preview, speakerOf, toE164, waitingOn } from '../src/derive.ts';
import { fixture } from './helpers.ts';

test('channel_key: bridge custom attribute wins', () => {
  const conv = fixture('message_incoming_slack.json').conversation;
  assert.equal(deriveChannelKey(conv), 'slack:C06SHARED01');
  assert.equal(platformOf('slack:C06SHARED01'), 'slack');
  for (const k of ['teams:19:abc@thread.v2', 'viber:01234567890A=', 'whatsapp:+639171234567']) assert.equal(deriveChannelKey({ custom_attributes: { channel_key: k } }), k);
});

test('channel_key: native WhatsApp inbox derives whatsapp:<E.164> from the contact phone', () => {
  const conv = fixture('message_incoming_whatsapp.json').conversation;
  assert.equal(deriveChannelKey(conv), 'whatsapp:+639171234567');
  // phone missing on the contact: fall back to the WhatsApp source id (wa_id, digits only)
  assert.equal(deriveChannelKey({ ...conv, meta: { sender: { phone_number: null } } }), 'whatsapp:+639171234567');
  // Twilio WhatsApp medium
  assert.equal(deriveChannelKey({ channel: 'Channel::TwilioSms', contact_inbox: { source_id: 'whatsapp:+14155550100' }, meta: { sender: {} } }), 'whatsapp:+14155550100');
});

test('channel_key: nothing derivable for other channels or junk attributes', () => {
  assert.equal(deriveChannelKey({ channel: 'Channel::WebWidget', custom_attributes: {} }), null);
  assert.equal(deriveChannelKey({ channel: 'Channel::Api', custom_attributes: { channel_key: 'email:x@y.z' } }), null);
  assert.equal(deriveChannelKey({ channel: 'Channel::TwilioSms', contact_inbox: { source_id: '+14155550100' }, meta: { sender: { phone_number: '+14155550100' } } }), null);
  assert.equal(deriveChannelKey({ channel: 'Channel::Whatsapp', contact_inbox: { source_id: '' }, meta: { sender: { phone_number: '09171234567' } } }), null);
});

test('toE164 normalizes formatting and refuses to guess country codes', () => {
  assert.equal(toE164('+63 917-123 4567'), '+639171234567');
  assert.equal(toE164('whatsapp:+14155550100'), '+14155550100');
  assert.equal(toE164('09171234567'), null);
  assert.equal(toE164('+0123'), null);
  assert.equal(toE164(null), null);
});

test('waiting_on: resolved -> none, customer spoke last -> kita, kita spoke last -> customer', () => {
  assert.equal(waitingOn('open', 'customer'), 'kita');
  assert.equal(waitingOn('pending', 'kita'), 'customer');
  assert.equal(waitingOn('snoozed', 'customer'), 'kita');
  assert.equal(waitingOn('resolved', 'customer'), 'none');
  assert.equal(waitingOn('open', null), 'none');
});

test('speakerOf: private notes and activities never count', () => {
  assert.equal(speakerOf(fixture('message_incoming_slack.json')), 'customer');
  assert.equal(speakerOf(fixture('message_outgoing_agent.json')), 'kita');
  assert.equal(speakerOf(fixture('message_private_note_self.json')), null);
  assert.equal(speakerOf({ message_type: 'activity', private: false }), null);
  assert.equal(speakerOf({ message_type: 'template', private: false }), 'kita');
});

test('preview collapses whitespace, truncates, and describes attachment-only messages', () => {
  assert.equal(preview('a\n\n b'), 'a b');
  assert.equal(preview('x'.repeat(300)).length, 200);
  assert.equal(preview('', [{}, {}]), '[2 attachments]');
});

test('conversationBody matches the Grip contract field set', () => {
  const body = conversationBody({ id: 42, accountId: 1, channelKey: 'slack:C1', platform: 'slack', channelLabel: '#c', status: 'open', labels: [], lastMessageAt: 'a', lastCustomerMessageAt: 'a', lastSpeaker: 'customer', preview: 'p', messageCount: 3, lastCustomerMessageId: 1, classifiedUpto: 0, dismissed: false }, 'https://support.internal.kita.ai');
  assert.deepEqual(Object.keys(body).sort(), ['channel_key', 'channel_label', 'chatwoot_conversation_id', 'chatwoot_url', 'last_customer_message_at', 'last_message_at', 'last_message_preview', 'message_count', 'platform', 'status', 'waiting_on'].sort());
  assert.equal(body.chatwoot_url, 'https://support.internal.kita.ai/app/accounts/1/conversations/42');
  assert.equal(body.waiting_on, 'kita');
});
