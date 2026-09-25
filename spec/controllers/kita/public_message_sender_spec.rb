require 'rails_helper'

RSpec.describe 'Kita per-message senders on the public inbox API', type: :request do
  let!(:api_channel) { create(:channel_api) }
  let!(:contact) { create(:contact, account: api_channel.account, identifier: 'slack:U_CHANNEL') }
  let!(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: api_channel.inbox) }
  let!(:conversation) do
    create(:conversation, account: api_channel.account, inbox: api_channel.inbox, contact: contact, contact_inbox: contact_inbox)
  end
  let(:path) do
    "/public/api/v1/inboxes/#{api_channel.identifier}/contacts/#{contact_inbox.source_id}/conversations/#{conversation.display_id}/messages"
  end

  it 'attributes the message to another contact of the same inbox' do
    speaker = create(:contact, account: api_channel.account, identifier: 'slack:U_DANA', name: 'Dana Cruz')
    create(:contact_inbox, contact: speaker, inbox: api_channel.inbox)

    post path, params: { content: 'hi', sender_identifier: 'slack:U_DANA', content_attributes: { external_source: 'slack' } }

    expect(response).to have_http_status(:success)
    message = conversation.messages.incoming.last
    expect(message.sender).to eq(speaker)
    expect(message.message_type).to eq('incoming')
    expect(message.content_attributes['external_source']).to eq('slack')
  end

  it 'links a thread reply to its root with the native reply attribute' do
    root = create(:message, conversation: conversation, account: conversation.account, inbox: conversation.inbox, message_type: :incoming)

    post path, params: { content: 'reply', content_attributes: { in_reply_to: root.id.to_s, external_thread: { root: '1700.1' } } }

    attrs = conversation.messages.incoming.last.content_attributes
    expect(attrs['in_reply_to']).to eq(root.id)
    expect(attrs['external_thread']).to eq('root' => '1700.1')
  end

  it 'defaults to the conversation contact' do
    post path, params: { content: 'hi' }
    expect(conversation.messages.incoming.last.sender).to eq(contact)
  end

  it 'refuses a contact that is not in this inbox' do
    outsider = create(:contact, account: api_channel.account, identifier: 'slack:U_OTHER')
    create(:contact_inbox, contact: outsider, inbox: create(:channel_api, account: api_channel.account).inbox)

    post path, params: { content: 'hi', sender_identifier: 'slack:U_OTHER' }

    expect(response).to have_http_status(:not_found)
    expect(conversation.messages.where(content: 'hi')).to be_empty
  end

  it 'ignores unknown external sources' do
    post path, params: { content: 'hi', content_attributes: { external_source: 'email' } }
    expect(conversation.messages.incoming.last.content_attributes).not_to have_key('external_source')
  end
end
