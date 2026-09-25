require 'rails_helper'

RSpec.describe 'Kita bridge conversation merges', type: :request do
  let(:account) { create(:account) }
  let(:inbox) { create(:inbox, account: account) }
  let(:from) { create(:conversation, account: account, inbox: inbox, custom_attributes: { 'channel_key' => 'slack:T1:C1' }) }
  let(:to) { create(:conversation, account: account, inbox: inbox) }
  let(:secret) { 'link-secret' }
  let(:path) { '/api/v1/kita/conversation_merges' }
  let(:params) { { from_conversation_id: from.display_id, to_conversation_id: to.display_id } }
  let(:headers) { { 'X-Kita-Bridge-Secret' => secret } }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: secret, KITA_BRIDGE_ACCOUNT_ID: account.id.to_s) { example.run }
  end

  it 'requires the bridge secret' do
    post path, params: params, headers: { 'X-Kita-Bridge-Secret' => 'nope' }
    expect(response).to have_http_status(:unauthorized)
  end

  it 'moves messages and threads into the target, marks the source merged and resolves it' do
    root = create(:message, account: account, inbox: inbox, conversation: from)
    create(:message, account: account, inbox: inbox, conversation: from, content_attributes: { in_reply_to: root.id })
    thread = Kita::MessageThread.create!(account: account, conversation: from, root_message: root, title: 'Login issue')

    post path, params: params, headers: headers

    expect(response.parsed_body).to eq('moved' => 2)
    expect(to.messages.count).to eq(2)
    expect(from.messages.where.not(message_type: :activity).count).to eq(0)
    expect(thread.reload.conversation_id).to eq(to.id)
    expect(from.reload).to have_attributes(status: 'resolved')
    expect(from.custom_attributes).to include('channel_key' => 'slack:T1:C1', 'merged_into' => to.display_id)
  end

  it 'is idempotent' do
    create(:message, account: account, inbox: inbox, conversation: from)
    post path, params: params, headers: headers
    post path, params: params, headers: headers

    expect(response.parsed_body).to eq('moved' => 0)
    expect(to.messages.count).to eq(1)
  end

  it 'refuses conversations in different inboxes' do
    other = create(:conversation, account: account, inbox: create(:inbox, account: account))
    post path, params: params.merge(to_conversation_id: other.display_id), headers: headers
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
