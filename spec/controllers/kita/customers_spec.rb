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

  it 'groups the conversations the agent can see by Grip account, with each unlinked channel as its own row last' do
    get path, headers: agent.create_new_auth_token, as: :json

    rows = response.parsed_body['payload']
    unlinked = Conversation.find_by("custom_attributes->>'channel' = 'viber'")
    expect(rows.pluck('id')).to contain_exactly('Tala', 'Amartha', "unlinked-#{unlinked.display_id}")
    expect(rows.last).to include('unlinked' => true, 'name' => unlinked.contact.name)
    tala = rows.find { |row| row['id'] == 'Tala' }
    expect(tala).to include('name' => 'Tala', 'dri_name' => 'Suraaj Samanta', 'dri_email' => 'suraaj@usekita.com',
                            'platforms' => %w[slack whatsapp], 'open_count' => 2, 'waiting_on_us' => true)
    expect(rows.find { |row| row['id'] == 'Amartha' }).to include('open_count' => 0, 'waiting_on_us' => false, 'platforms' => ['teams'])
    expect(rows.last).to include('platforms' => ['viber'])
  end

  it 'aggregates one customer across its per-platform conversations by grip_account_id' do
    %w[slack whatsapp].each do |platform|
      conversation_for({ 'grip_account' => 'Kredit', 'grip_account_id' => '42', 'channel' => platform })
    end

    get path, headers: agent.create_new_auth_token, as: :json

    kredit = response.parsed_body['payload'].find { |row| row['id'] == '42' }
    expect(kredit).to include('name' => 'Kredit', 'platforms' => %w[slack whatsapp], 'open_count' => 2)
  end

  it 'lists each customer with its per-platform conversations, latest public message and urgent tickets' do
    conversations = %w[slack whatsapp].map do |platform|
      conversation_for({ 'grip_account' => 'Kredit', 'grip_account_id' => '42', 'channel' => platform,
                         'channel_label' => platform == 'slack' ? '#kita-kredit' : nil }.compact)
    end
    maria = create(:contact, account: account, name: 'Maria Reyes')
    create(:message, conversation: conversations.first, account: account, inbox: inbox, message_type: :incoming, sender: maria,
                     content: 'Batch 14 came back empty', created_at: 1.minute.ago)
    create(:message, conversation: conversations.last, account: account, inbox: inbox, message_type: :outgoing, private: true,
                     content: 'internal', created_at: Time.current)
    root = create(:message, conversation: conversations.first, account: account, inbox: inbox, message_type: :incoming)
    Kita::MessageThread.create!(account: account, conversation: conversations.first, root_message: root, ticket_id: 'T-1',
                                ticket_url: 'https://grip/t/1', ticket_priority: 'urgent', ticket_status: 'open')

    get path, headers: agent.create_new_auth_token, as: :json

    kredit = response.parsed_body['payload'].find { |row| row['id'] == '42' }
    expect(kredit).to include('grip_account_id' => '42', 'urgent_ticket' => true)
    expect(kredit['conversations'].map { |c| c.slice('id', 'platform', 'label') }).to contain_exactly(
      { 'id' => conversations.first.display_id, 'platform' => 'slack', 'label' => '#kita-kredit' },
      { 'id' => conversations.last.display_id, 'platform' => 'whatsapp', 'label' => conversations.last.contact.name }
    )
    expect(kredit['conversations'].find { |c| c['platform'] == 'slack' }['unread_count']).to eq(1)
    expect(kredit['last_message']).to include('content' => root.content, 'platform' => 'slack', 'message_type' => 'incoming')
    expect(response.parsed_body['payload'].find { |row| row['id'] == 'Tala' }['urgent_ticket']).to be(false)
  end

  it 'filters to my customers, matching the DRI email across Kita domain aliases, and keeps unlinked channels' do
    get path, params: { mine: true }, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].pluck('id')).to match([eq('Tala'), start_with('unlinked-')])
  end

  it 'names an unlinked channel by its label, never a raw platform key' do
    teams = conversation_for({ 'channel' => 'teams', 'channel_key' => 'teams:19:104cd490', 'channel_label' => 'teams:19:104cd490' })
    teams.contact.update!(name: 'teams:19:104cd490')
    get path, headers: agent.create_new_auth_token, as: :json

    row = response.parsed_body['payload'].find { |r| r['id'] == "unlinked-#{teams.display_id}" }
    expect(row).to include('name' => 'Microsoft Teams chat', 'channel_key' => 'teams:19:104cd490')
    expect(row['conversations'].first['label']).to eq('Microsoft Teams chat')

    teams.update!(custom_attributes: teams.custom_attributes.merge('channel_label' => 'Acme › Support'))
    get path, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].find { |r| r['id'] == "unlinked-#{teams.display_id}" }['name']).to eq('Acme › Support')
  end

  it 'leaves conversations from other inboxes out of the directory and serves any row on its own' do
    website = conversation_for({})
    get path, headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['payload'].pluck('kind').uniq).to contain_exactly('customer', 'unlinked')

    get "#{path}/Tala", headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body).to include('id' => 'Tala', 'kind' => 'customer', 'open_count' => 2, 'open_tickets' => 0)
    expect(response.parsed_body['conversations'].size).to eq(2)

    get "#{path}/conversation-#{website.display_id}", headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body).to include('kind' => 'conversation', 'name' => website.contact.name)

    get "#{path}/Hidden%20Co", headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:not_found)
  end

  it 'creates one "My customers" saved view per agent that filters conversations by account_owner_email' do
    post "#{path}/my_view", headers: agent.create_new_auth_token, as: :json
    first_id = response.parsed_body['id']
    post "#{path}/my_view", headers: agent.create_new_auth_token, as: :json
    expect(response.parsed_body['id']).to eq(first_id)

    view = CustomFilter.find(first_id)
    expect(view).to have_attributes(user: agent, name: 'My customers', filter_type: 'conversation')
    expect(view.query['payload'].pluck('values')).to eq([['suraaj@kita.ai'], ['suraaj@usekita.com']])

    post "/api/v1/accounts/#{account.id}/conversations/filter",
         params: { payload: view.query['payload'] }, headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body['payload'].map { |c| c['custom_attributes']['grip_account'] }.uniq).to eq(['Tala'])
  end
end
