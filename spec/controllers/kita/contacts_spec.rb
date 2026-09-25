require 'rails_helper'

RSpec.describe 'Kita contacts', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/contacts" }
  let(:tala_attrs) { { 'grip_account' => 'Tala', 'grip_account_id' => '7', 'channel' => 'slack' } }
  let(:tala) { create(:conversation, account: account, inbox: inbox, custom_attributes: tala_attrs) }
  let(:website) { create(:conversation, account: account, inbox: inbox) }
  let(:maria) { create(:contact, account: account, name: 'Maria Reyes') }

  before do
    create(:inbox_member, user: agent, inbox: inbox)
    create(:message, conversation: tala, account: account, inbox: inbox, message_type: :incoming, sender: maria)
    website
    create(:contact, account: account, name: 'Stranger') # no conversation the agent can see
  end

  it 'lists the people of the conversations the agent can see, with their customers' do
    get path, headers: agent.create_new_auth_token
    rows = response.parsed_body['payload']
    expect(rows.pluck('name')).to contain_exactly('Maria Reyes', tala.contact.name, website.contact.name)
    expect(rows.find { |row| row['id'] == maria.id }['customers']).to eq([{ 'id' => '7', 'name' => 'Tala' }])
    expect(rows.find { |row| row['id'] == website.contact_id }['customers']).to eq([])
  end

  it 'filters by customer and name' do
    get path, params: { customer_id: '7' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('id')).to contain_exactly(maria.id, tala.contact_id)
    get path, params: { q: 'mari' }, headers: agent.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('id')).to eq([maria.id])
  end
end
