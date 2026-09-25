require 'rails_helper'

RSpec.describe 'Kita inbox', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent, name: 'Suraaj Samanta', email: 'suraaj@kita.ai') }
  let(:other_agent) { create(:user, account: account, role: :agent) }
  let(:inbox) { create(:inbox, account: account) }
  let(:hidden_inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/inbox" }
  let(:tala) do
    { 'grip_account' => 'Tala', 'grip_account_id' => '7', 'account_owner' => 'Suraaj', 'account_owner_email' => 'suraaj@usekita.com',
      'grip_stage' => 'Production' }
  end
  let!(:tala_slack) { create(:conversation, account: account, inbox: inbox, custom_attributes: tala.merge('channel' => 'slack')) }
  let!(:tala_whatsapp) { create(:conversation, account: account, inbox: inbox, custom_attributes: tala.merge('channel' => 'whatsapp')) }
  let!(:amartha) do
    create(:conversation, account: account, inbox: inbox, assignee: other_agent, priority: :urgent,
                          custom_attributes: { 'grip_account' => 'Amartha', 'grip_account_id' => '9', 'channel' => 'teams' })
  end
  let!(:unlinked) { create(:conversation, account: account, inbox: inbox, custom_attributes: { 'channel' => 'viber' }) }
  let!(:website) { create(:conversation, account: account, inbox: inbox, status: :resolved) }
  let(:unlinked_id) { "unlinked-viber:#{unlinked.display_id}" }
  let(:website_id) { "conversation-#{website.display_id}" }

  def incoming(conversation, at: Time.current)
    create(:message, conversation: conversation, account: account, inbox: inbox, message_type: :incoming, created_at: at)
  end

  def fetch(params = {})
    get path, params: params, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:ok)
    response.parsed_body
  end

  def ids(params = {})
    fetch(params)['payload'].pluck('id')
  end

  def ticket(conversation, priority)
    root = create(:message, conversation: conversation, account: account, inbox: inbox, message_type: :incoming)
    Kita::MessageThread.create!(account: account, conversation: conversation, root_message: root, ticket_id: SecureRandom.hex(4),
                                ticket_priority: priority, ticket_status: 'open', ticket_owner: 'Rhea', ticket_display_id: 'KT-41')
  end

  before do
    create(:inbox_member, user: agent, inbox: inbox)
    create(:conversation, account: account, inbox: hidden_inbox, custom_attributes: { 'grip_account' => 'Hidden', 'channel' => 'slack' })
    tala_slack.update!(last_activity_at: 1.minute.ago)
    tala_whatsapp.update!(last_activity_at: 5.minutes.ago)
    amartha.update!(last_activity_at: 1.hour.ago)
    unlinked.update!(last_activity_at: 2.hours.ago)
    website.update!(last_activity_at: 3.hours.ago)
  end

  it 'requires a signed-in agent' do
    get path
    expect(response).to have_http_status(:unauthorized)
  end

  it 'lists one row per customer, unlinked channel and other conversation, by section' do
    body = fetch(scope: 'all', status: 'all')

    expect(body['payload'].pluck('id')).to eq(['7', '9', unlinked_id, website_id])
    expect(body['payload'].pluck('section')).to eq(%w[active active unlinked resolved])
    expect(body['payload'].pluck('kind')).to eq(%w[customer customer unlinked conversation])
    expect(body['payload'].first).to include('name' => 'Tala', 'stage' => 'Production', 'platforms' => %w[slack whatsapp],
                                             'dri_name' => 'Suraaj', 'dri_id' => agent.id)
    expect(body['payload'].first['conversations'].pluck('id')).to eq([tala_slack.display_id, tala_whatsapp.display_id])
    expect(body['payload'].last).to include('name' => website.contact.name, 'unlinked' => false)
    expect(body['meta']).to include('count' => 4, 'page' => 1, 'has_more' => false)
  end

  it 'puts customers waiting on us first, pressing tickets pinned, then the longest wait' do
    incoming(tala_whatsapp)
    tala_whatsapp.update!(waiting_since: 2.hours.ago)
    incoming(unlinked)
    unlinked.update!(waiting_since: 3.hours.ago)
    incoming(amartha)
    amartha.update!(waiting_since: 1.minute.ago)
    body = fetch(scope: 'all')
    expect(body['payload'].pluck('id')).to eq(['7', '9', unlinked_id])
    expect(body['meta']['needs_reply']).to eq(3)
    expect(fetch(meta_only: true)).to eq('payload' => [], 'meta' => { 'needs_reply' => 1 })
    expect(body['payload'].first).to include('section' => 'needs_reply', 'waiting_platform' => 'whatsapp')

    ticket(amartha, 'urgent')
    rows = fetch(scope: 'all')['payload']
    expect(rows.pluck('id')).to eq(['9', '7', unlinked_id])
    expect(rows.first).to include('pressing_tickets' => 1, 'urgent_ticket' => true)
    expect(rows.first['top_ticket']).to include('display_id' => 'KT-41', 'priority' => 'urgent')
  end

  it 'clears needs reply when a phone reply is marked' do
    incoming(tala_whatsapp)
    post "/api/v1/accounts/#{account.id}/kita/account_actions", params: { ids: ['7'], action_name: 'replied_from_phone' },
                                                                headers: agent.create_new_auth_token
    expect(fetch(scope: 'all')['payload'].first['section']).to eq('active')
  end

  it 'scopes to mine by default: the DRI, the assignee, the ticket owner or a mention' do
    expect(ids).to eq(['7'])
    amartha.update!(assignee: agent)
    expect(ids).to eq(%w[7 9])

    ticket(unlinked, 'low').update!(ticket_owner: 'suraaj samanta')
    expect(ids).to include(unlinked_id)

    create(:mention, user: agent, conversation: website, account: account)
    expect(ids(status: 'all')).to include(website_id)
  end

  it 'scopes to unassigned: no DRI, or waiting on us with nobody assigned' do
    expect(ids(scope: 'unassigned')).to eq(['9', unlinked_id])
    incoming(tala_slack)
    expect(ids(scope: 'unassigned')).to eq(['7', '9', unlinked_id])
  end

  it 'filters by status, platform, team, labels, stage and DRI' do
    expect(ids(scope: 'all', status: 'resolved')).to eq([website_id])
    expect(ids(scope: 'all', platform: 'whatsapp')).to eq(['7'])
    expect(ids(scope: 'all', stage: 'Production')).to eq(['7'])
    expect(ids(scope: 'all', dri: 'SURAAJ@usekita.com')).to eq(['7'])

    team = create(:team, account: account)
    unlinked.update!(team: team)
    expect(ids(scope: 'all', team_id: team.id)).to eq([unlinked_id])

    amartha.update!(label_list: ['billing'])
    expect(ids(scope: 'all', labels: ['billing'])).to eq(['9'])
  end

  it 'filters by tickets and conversation type' do
    ticket(amartha, 'high')
    expect(ids(scope: 'all', ticket_priority: 'high', ticket_status: 'open')).to eq(['9'])

    create(:mention, user: agent, conversation: tala_slack, account: account)
    expect(ids(scope: 'all', conversation_type: 'mention')).to eq(['7'])
  end

  it 'archives "Not a customer" rows into Other' do
    post "/api/v1/accounts/#{account.id}/kita/account_actions", params: { ids: [unlinked_id], action_name: 'not_customer' },
                                                                headers: agent.create_new_auth_token
    expect(ids(scope: 'all')).not_to include(unlinked_id)
    expect(ids(scope: 'all', status: 'other')).to eq([unlinked_id])
  end

  it 'applies a Chatwoot advanced filter payload or a saved view' do
    filters = [{ attribute_key: 'status', filter_operator: 'equal_to', values: ['resolved'], query_operator: nil }]
    expect(ids(scope: 'all', status: 'all', filters: filters.to_json)).to eq([website_id])

    view = create(:custom_filter, user: agent, account: account, filter_type: :conversation, query: { payload: filters })
    expect(ids(scope: 'all', status: 'all', view_id: view.id)).to eq([website_id])
  end

  it 'sorts within sections and paginates by row' do
    expect(ids(scope: 'all', status: 'open', sort: 'priority').first).to eq('9')

    stub_const('Kita::Inbox::PER_PAGE', 2)
    expect(ids(scope: 'all', status: 'all', page: 2)).to eq([unlinked_id, website_id])
    expect(fetch(scope: 'all', status: 'all', page: 1)['meta']['has_more']).to be(true)
  end

  it 'rejects an unknown filter' do
    get path, params: { status: 'bogus' }, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:unprocessable_entity)
    get path, params: { view_id: 0 }, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
