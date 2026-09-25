require 'rails_helper'

RSpec.describe 'Kita tickets', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent, name: 'Suraaj Samanta', email: 'suraaj@kita.ai') }
  let(:inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/tickets" }
  let(:conversation) do
    create(:conversation, account: account, inbox: inbox,
                          custom_attributes: { 'grip_account' => 'Tala', 'grip_account_id' => '7', 'channel' => 'slack' })
  end

  def ticket(attrs)
    root = create(:message, conversation: conversation, account: account, inbox: inbox, message_type: :incoming, content: 'Batch 14 is empty')
    Kita::MessageThread.create!({ account: account, conversation: conversation, root_message: root, ticket_id: SecureRandom.hex(4) }.merge(attrs))
  end

  before { create(:inbox_member, user: agent, inbox: inbox) }

  it 'lists open tickets across customers, urgent first' do
    ticket(ticket_priority: 'low', ticket_status: 'open', title: 'Slow export')
    urgent = ticket(ticket_priority: 'urgent', ticket_status: 'in_progress', ticket_display_id: 'KT-142', ticket_owner: 'Suraaj Samanta')
    ticket(ticket_priority: 'high', ticket_status: 'resolved')

    get path, headers: agent.create_new_auth_token
    rows = response.parsed_body['payload']
    expect(rows.pluck('priority')).to eq(%w[urgent low])
    expect(rows.first).to include('id' => urgent.id, 'display_id' => 'KT-142', 'title' => 'Batch 14 is empty', 'status' => 'in_progress',
                                  'owner' => 'Suraaj Samanta', 'platform' => 'slack', 'customer_id' => '7', 'customer_name' => 'Tala',
                                  'conversation_id' => conversation.display_id, 'root_message_id' => urgent.root_message_id)
  end

  it 'filters mine, priority and status' do
    ticket(ticket_priority: 'urgent', ticket_owner: 'suraaj@usekita.com')
    ticket(ticket_priority: 'high', ticket_owner: 'Rhea')
    ticket(ticket_priority: 'high', ticket_status: 'resolved')

    get path, params: { scope: 'mine' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('owner')).to eq(['suraaj@usekita.com'])
    get path, params: { scope: 'unowned', status: 'all' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('owner')).to eq([nil])
    get path, params: { customer_id: '7', platform: 'slack' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].size).to eq(2)
    get path, params: { platform: 'teams' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload']).to be_empty
    get path, params: { priority: 'high', status: 'all' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].size).to eq(2)
    get path, params: { status: 'nope' }, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
