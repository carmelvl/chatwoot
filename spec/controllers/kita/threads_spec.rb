require 'rails_helper'

RSpec.describe 'Kita conversation threads', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:teammate) { create(:user, account: account, role: :agent, name: 'Sam Lee') }
  let(:customer) { create(:contact, account: account, name: 'Ana Cruz') }
  let(:inbox) { create(:inbox, account: account) }
  let(:conversation) { create(:conversation, account: account, inbox: inbox) }
  let(:base) { "/api/v1/accounts/#{account.id}/kita/conversations/#{conversation.display_id}/threads" }
  let(:slack) { { external_source: 'slack', external_channel: '#kita-tala' } }
  let!(:root) { create(:message, account: account, inbox: inbox, conversation: conversation, sender: customer, content_attributes: slack) }
  let!(:quiet_root) { create(:message, account: account, inbox: inbox, conversation: conversation, sender: customer) }

  before do
    create(:inbox_member, user: agent, inbox: inbox)
    create(:message, account: account, inbox: inbox, conversation: conversation, sender: customer, created_at: 2.hours.ago,
                     content_attributes: slack.merge(in_reply_to: root.id))
    create(:message, account: account, inbox: inbox, conversation: conversation, sender: teammate, message_type: :outgoing,
                     created_at: 1.hour.ago, content_attributes: { in_reply_to: root.id })
    Kita::MessageThread.create!(account: account, conversation: conversation, root_message: quiet_root, title: 'Billing', ticket_id: 'T-9',
                                ticket_url: 'https://grip/t/9', ticket_priority: 'urgent', ticket_status: 'open', ticket_owner: 'Carmel',
                                ticket_display_id: 'KT-9')
  end

  it 'requires a signed-in agent' do
    get base
    expect(response).to have_http_status(:unauthorized)
  end

  it 'hides conversations in inboxes the agent is not a member of' do
    hidden = create(:conversation, account: account)
    get "/api/v1/accounts/#{account.id}/kita/conversations/#{hidden.display_id}/threads", headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:not_found)
  end

  it 'lists threads with replies, participants, unread and metadata, most recent activity first' do
    get base, headers: agent.create_new_auth_token, as: :json

    rows = response.parsed_body['payload']
    expect(rows.pluck('root_message_id')).to eq([quiet_root.id, root.id])
    expect(rows.last).to include('title' => nil, 'status' => 'open', 'reply_count' => 2, 'unread' => true, 'ticket' => nil,
                                 'external_source' => 'slack', 'external_channel' => '#kita-tala')
    expect(rows.last['last_reply_at']).to be_within(2).of(1.hour.ago.to_i)
    expect(rows.last['participants'].map { |p| p.slice('id', 'type', 'name') }).to eq(
      [{ 'id' => customer.id, 'type' => 'Contact', 'name' => 'Ana Cruz' }, { 'id' => teammate.id, 'type' => 'User', 'name' => 'Sam Lee' }]
    )
    expect(rows.first).to include('title' => 'Billing', 'reply_count' => 0, 'last_reply_at' => nil, 'participants' => [], 'unread' => false,
                                  'ticket' => { 'id' => 'T-9', 'url' => 'https://grip/t/9', 'display_id' => 'KT-9', 'priority' => 'urgent',
                                                'status' => 'open', 'owner' => 'Carmel' })
  end

  it 'marks a thread read for the current agent only, until someone else replies' do
    post "#{base}/#{root.id}/read", headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:ok)

    get base, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].last['unread']).to be(false)

    create(:message, account: account, inbox: inbox, conversation: conversation, sender: agent, message_type: :outgoing,
                     content_attributes: { in_reply_to: root.id })
    get base, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].first).to include('root_message_id' => root.id, 'unread' => false, 'reply_count' => 3)
  end

  it 'sets the thread status independently of the conversation' do
    patch "#{base}/#{root.id}", params: { status: 'resolved' }, headers: agent.create_new_auth_token, as: :json

    expect(response.parsed_body).to eq('root_message_id' => root.id, 'status' => 'resolved', 'ticket_synced' => nil)
    expect(Kita::MessageThread.find_by!(root_message_id: root.id).status).to eq('resolved')
    expect(conversation.reload.status).to eq('open')
  end

  it "moves the thread's Grip ticket through grip-sync when the thread resolves" do
    with_modified_env(BRIDGE_LINK_SECRET: 'link-secret', GRIP_SYNC_INTERNAL_URL: 'http://grip-sync.test') do
      stub = stub_request(:post, 'http://grip-sync.test/kita/tickets/status')
             .with(body: { conversation_id: conversation.display_id, root_message_id: quiet_root.id, status: 'done' }.to_json,
                   headers: { 'X-Kita-Bridge-Secret' => 'link-secret' })
             .to_return(status: 200, body: '{}')

      patch "#{base}/#{quiet_root.id}", params: { status: 'resolved' }, headers: agent.create_new_auth_token, as: :json

      expect(stub).to have_been_requested
      expect(response.parsed_body).to include('status' => 'resolved', 'ticket_synced' => true)
      expect(Kita::MessageThread.find_by!(root_message_id: quiet_root.id).ticket_status).to eq('resolved')
    end
  end

  it 'still resolves the thread when grip-sync is unreachable, and says so' do
    with_modified_env(BRIDGE_LINK_SECRET: 'link-secret', GRIP_SYNC_INTERNAL_URL: 'http://grip-sync.test') do
      stub_request(:post, 'http://grip-sync.test/kita/tickets/status').to_return(status: 503)

      patch "#{base}/#{quiet_root.id}", params: { status: 'resolved' }, headers: agent.create_new_auth_token, as: :json

      expect(response.parsed_body).to include('status' => 'resolved', 'ticket_synced' => false)
      expect(Kita::MessageThread.find_by!(root_message_id: quiet_root.id)).to have_attributes(status: 'resolved', ticket_status: 'open')
    end
  end

  it 'rejects an unknown status' do
    patch "#{base}/#{root.id}", params: { status: 'snoozed' }, headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
