require 'rails_helper'

RSpec.describe 'Kita bridge staff messages', type: :request do
  let(:account) { create(:account) }
  let(:api_channel) { create(:channel_api, account: account) }
  let(:contact) { create(:contact, account: account) }
  let(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: api_channel.inbox) }
  let(:conversation) { create(:conversation, account: account, inbox: api_channel.inbox, contact: contact, contact_inbox: contact_inbox) }
  let!(:agent) { create(:user, account: account, email: 'sam.lee@kita.ai') }
  let(:secret) { 'link-secret' }
  let(:params) { { conversation_id: conversation.display_id, email: 'Sam.Lee@Kita.ai', content: 'On it', content_attributes: { external_source: 'slack' } } }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: secret, KITA_BRIDGE_ACCOUNT_ID: account.id.to_s) { example.run }
  end

  it 'rejects requests without the bridge secret' do
    post '/api/v1/kita/staff_messages', params: params
    expect(response).to have_http_status(:unauthorized)
  end

  it 'rejects a wrong bridge secret' do
    post '/api/v1/kita/staff_messages', params: params, headers: { 'X-Kita-Bridge-Secret' => 'nope' }
    expect(response).to have_http_status(:unauthorized)
  end

  it 'posts as the matching desk agent, marked so the bridge never sends it back out' do
    expect do
      post '/api/v1/kita/staff_messages', params: params, headers: { 'X-Kita-Bridge-Secret' => secret }
    end.to change(conversation.messages, :count).by(1)

    message = conversation.messages.last
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq('id' => message.id, 'sender_id' => agent.id)
    expect(message.sender).to eq(agent)
    expect(message.message_type).to eq('outgoing')
    expect(message.private).to be(false)
    expect(message.content).to eq('On it')
    expect(message.content_attributes).to include('kita_bridge_origin' => true, 'external_source' => 'slack')
    expect(response.body).not_to include('access_token')
  end

  it 'returns no_agent when nobody in the Kita account has that email' do
    create(:user, email: 'outsider@kita.ai')
    expect do
      post '/api/v1/kita/staff_messages', params: params.merge(email: 'outsider@kita.ai'), headers: { 'X-Kita-Bridge-Secret' => secret }
    end.not_to change(Message, :count)
    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body).to eq('error' => 'no_agent')
  end

  it 'only reaches conversations in the Kita account' do
    other = create(:conversation)
    post '/api/v1/kita/staff_messages', params: params.merge(conversation_id: other.display_id + 1000),
                                        headers: { 'X-Kita-Bridge-Secret' => secret }
    expect(response).to have_http_status(:not_found)
  end
end
