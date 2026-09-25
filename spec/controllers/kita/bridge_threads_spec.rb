require 'rails_helper'

RSpec.describe 'Kita bridge thread metadata', type: :request do
  let(:account) { create(:account) }
  let(:conversation) { create(:conversation, account: account) }
  let(:root) { create(:message, account: account, inbox: conversation.inbox, conversation: conversation) }
  let(:secret) { 'link-secret' }
  let(:path) { '/api/v1/kita/threads' }
  let(:headers) { { 'X-Kita-Bridge-Secret' => secret } }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: secret, KITA_BRIDGE_ACCOUNT_ID: account.id.to_s) { example.run }
  end

  it 'requires the bridge secret' do
    post path, params: { conversation_id: conversation.display_id, root_message_id: root.id, title: 'Login issue' }
    expect(response).to have_http_status(:unauthorized)
  end

  it 'upserts the title and ticket link by root message' do
    post path, params: { conversation_id: conversation.display_id, root_message_id: root.id, title: 'Login issue' }, headers: headers
    post path, params: { conversation_id: conversation.display_id, root_message_id: root.id, ticket_id: 'T-42', ticket_url: 'https://grip/t/42' },
               headers: headers

    thread = Kita::MessageThread.find_by!(root_message_id: root.id)
    expect(response.parsed_body).to eq('id' => thread.id)
    expect(Kita::MessageThread.count).to eq(1)
    expect(thread).to have_attributes(title: 'Login issue', ticket_id: 'T-42', ticket_url: 'https://grip/t/42', conversation_id: conversation.id,
                                      status: 'open')
  end

  it 'stores the ticket priority, status and owner grip-sync sends' do
    post path, params: { conversation_id: conversation.display_id, root_message_id: root.id, ticket_id: 'T-42', ticket_url: 'https://grip/t/42',
                         ticket_priority: 'urgent', ticket_status: 'open', ticket_owner: 'Carmel' }, headers: headers

    expect(Kita::MessageThread.find_by!(root_message_id: root.id))
      .to have_attributes(ticket_priority: 'urgent', ticket_status: 'open', ticket_owner: 'Carmel')
  end

  it 'rejects a root message from another conversation' do
    other = create(:message, account: account, conversation: create(:conversation, account: account))
    post path, params: { conversation_id: conversation.display_id, root_message_id: other.id, title: 'x' }, headers: headers
    expect(response).to have_http_status(:not_found)
  end
end
