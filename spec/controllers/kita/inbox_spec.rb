require 'rails_helper'

RSpec.describe 'Kita inbox', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent, email: 'suraaj@kita.ai') }
  let(:other_agent) { create(:user, account: account, role: :agent) }
  let(:inbox) { create(:inbox, account: account) }
  let(:hidden_inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/inbox" }
  let(:tala) { { 'grip_account' => 'Tala', 'grip_account_id' => '7', 'account_owner' => 'Suraaj', 'account_owner_email' => 'suraaj@usekita.com' } }
  let!(:tala_slack) { create(:conversation, account: account, inbox: inbox, custom_attributes: tala.merge('channel' => 'slack')) }
  let!(:tala_whatsapp) { create(:conversation, account: account, inbox: inbox, custom_attributes: tala.merge('channel' => 'whatsapp')) }
  let!(:amartha) do
    create(:conversation, account: account, inbox: inbox, assignee: other_agent, priority: :urgent,
                          custom_attributes: { 'grip_account' => 'Amartha', 'grip_account_id' => '9', 'channel' => 'teams' })
  end
  let!(:unlinked) { create(:conversation, account: account, inbox: inbox, custom_attributes: { 'channel' => 'viber' }) }
  let!(:website) { create(:conversation, account: account, inbox: inbox, status: :resolved) }

  def incoming(conversation, at: Time.current)
    create(:message, conversation: conversation, account: account, inbox: inbox, message_type: :incoming, created_at: at)
  end

  def fetch(params = {})
    get path, params: params, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:ok)
    response.parsed_body
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

  it 'lists one row per customer, unlinked channel and other conversation, most recent first' do
    body = fetch(status: 'all')

    expect(body['payload'].pluck('id')).to eq(['7', '9', "unlinked-#{unlinked.display_id}", "conversation-#{website.display_id}"])
    expect(body['payload'].pluck('kind')).to eq(%w[customer customer unlinked conversation])
    expect(body['payload'].first).to include('name' => 'Tala', 'platforms' => %w[slack whatsapp], 'dri_name' => 'Suraaj')
    expect(body['payload'].first['conversations'].pluck('id')).to eq([tala_slack.display_id, tala_whatsapp.display_id])
    expect(body['payload'].last).to include('name' => website.contact.name, 'unlinked' => false)
    expect(body['meta']).to include('count' => 4, 'page' => 1, 'has_more' => false)
  end

  it 'shows only conversations waiting on us by default' do
    incoming(tala_whatsapp)
    create(:message, conversation: amartha, account: account, inbox: inbox, message_type: :outgoing)

    expect(fetch['payload'].pluck('id')).to eq(['7'])
    expect(fetch['payload'].first['conversations'].pluck('id')).to eq([tala_whatsapp.display_id])
  end

  it 'filters by status, platform, mine, team, labels and conversation type' do
    expect(fetch(status: 'resolved')['payload'].pluck('id')).to eq(["conversation-#{website.display_id}"])
    expect(fetch(status: 'all', platform: 'whatsapp')['payload'].pluck('id')).to eq(['7'])
    expect(fetch(status: 'all', mine: true)['payload'].pluck('id')).to eq(['7'])

    amartha.update!(assignee: agent)
    expect(fetch(status: 'all', mine: true)['payload'].pluck('id')).to eq(%w[7 9])

    team = create(:team, account: account)
    unlinked.update!(team: team)
    expect(fetch(status: 'all', team_id: team.id)['payload'].pluck('id')).to eq(["unlinked-#{unlinked.display_id}"])

    amartha.update!(label_list: ['billing'])
    expect(fetch(status: 'all', labels: ['billing'])['payload'].pluck('id')).to eq(['9'])

    create(:mention, user: agent, conversation: tala_slack, account: account)
    expect(fetch(status: 'all', conversation_type: 'mention')['payload'].pluck('id')).to eq(['7'])
  end

  it 'applies a Chatwoot advanced filter payload' do
    filters = [{ attribute_key: 'status', filter_operator: 'equal_to', values: ['resolved'], query_operator: nil }]
    expect(fetch(status: 'all', filters: filters.to_json)['payload'].pluck('id')).to eq(["conversation-#{website.display_id}"])
  end

  it 'sorts and paginates by row' do
    expect(fetch(status: 'all', sort: 'oldest')['payload'].first['id']).to eq("conversation-#{website.display_id}")
    expect(fetch(status: 'all', sort: 'priority')['payload'].first['id']).to eq('9')

    stub_const('Kita::Inbox::PER_PAGE', 2)
    expect(fetch(status: 'all', page: 2)['payload'].pluck('id')).to eq(["unlinked-#{unlinked.display_id}", "conversation-#{website.display_id}"])
    expect(fetch(status: 'all', page: 1)['meta']['has_more']).to be(true)
  end

  it 'rejects an unknown filter' do
    get path, params: { status: 'bogus' }, headers: agent.create_new_auth_token
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
