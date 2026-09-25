require 'rails_helper'

RSpec.describe 'Kita customers', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent, email: 'suraaj@kita.ai') }
  let(:inbox) { create(:inbox, account: account) }
  let(:hidden_inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/customers" }

  def conversation_for(attrs, inbox: self.inbox, status: :open)
    create(:conversation, account: account, inbox: inbox, status: status, custom_attributes: attrs)
  end

  def message(conversation, type, private: false)
    create(:message, conversation: conversation, account: account, inbox: conversation.inbox, message_type: type, private: private)
  end

  before do
    create(:inbox_member, user: agent, inbox: inbox)
    tala = { 'grip_account' => 'Tala', 'account_owner' => 'Suraaj Samanta', 'account_owner_email' => 'suraaj@usekita.com' }
    waiting = conversation_for(tala.merge('channel' => 'slack'))
    message(waiting, :outgoing)
    message(waiting, :incoming)
    message(waiting, :outgoing, private: true) # private notes don't count
    answered = conversation_for(tala.merge('channel' => 'whatsapp'))
    message(answered, :incoming)
    message(answered, :outgoing)
    conversation_for({ 'grip_account' => 'Amartha', 'account_owner_email' => 'carmel@kita.ai', 'channel' => 'teams' }, status: :resolved)
    conversation_for({ 'channel' => 'viber' })
    conversation_for({ 'grip_account' => 'Hidden Co', 'channel' => 'slack' }, inbox: hidden_inbox)
  end

  it 'requires a signed-in agent' do
    get path
    expect(response).to have_http_status(:unauthorized)
  end

  it 'groups the conversations the agent can see by Grip account, with an Unlinked group last' do
    get path, headers: agent.create_new_auth_token, as: :json

    rows = response.parsed_body['payload']
    expect(rows.pluck('id')).to contain_exactly('Tala', 'Amartha', 'unlinked')
    expect(rows.last['id']).to eq('unlinked')
    tala = rows.find { |row| row['id'] == 'Tala' }
    expect(tala).to include('name' => 'Tala', 'dri_name' => 'Suraaj Samanta', 'dri_email' => 'suraaj@usekita.com',
                            'platforms' => %w[slack whatsapp], 'open_count' => 2, 'waiting_on_us' => true)
    expect(rows.find { |row| row['id'] == 'Amartha' }).to include('open_count' => 0, 'waiting_on_us' => false, 'platforms' => ['teams'])
    expect(rows.last).to include('name' => nil, 'platforms' => ['viber'])
  end

  it 'filters to my customers, matching the DRI email across Kita domain aliases' do
    get path, params: { mine: true }, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].pluck('id')).to eq(['Tala'])
  end

  it 'creates one "My customers" saved view per agent that filters conversations by account_owner_email' do
    post "#{path}/my_view", headers: agent.create_new_auth_token, as: :json
    first_id = response.parsed_body['id']
    post "#{path}/my_view", headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['id']).to eq(first_id)

    view = CustomFilter.find(first_id)
    expect(view).to have_attributes(user: agent, name: 'My customers', filter_type: 'conversation')
    expect(view.query['payload'].pluck('values')).to eq([['suraaj@kita.ai'], ['suraaj@usekita.com']])

    post "/api/v1/accounts/#{account.id}/conversations/filter", params: { payload: view.query['payload'] },
                                                                  headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body['payload'].map { |c| c['custom_attributes']['grip_account'] }.uniq).to eq(['Tala'])
  end
end
