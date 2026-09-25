require 'rails_helper'

RSpec.describe 'Kita channel links', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, account: account, role: :administrator) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:conversation) { create(:conversation, account: account, custom_attributes: { 'channel' => 'teams', 'channel_key' => 'teams:19:abc' }) }
  let(:base) { "/api/v1/accounts/#{account.id}/kita/channel_links" }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: 'link-secret', BRIDGE_INTERNAL_URL: 'http://bridges.test') { example.run }
  end

  it 'is for administrators only' do
    get "#{base}/accounts", params: { search: 'ta' }, headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:unauthorized)
  end

  it 'searches Grip accounts through the bridge' do
    stub_request(:get, 'http://bridges.test/internal/grip/accounts?search=ta')
      .with(headers: { 'X-Kita-Bridge-Secret' => 'link-secret' })
      .to_return(status: 200, body: { accounts: [{ id: 'acc-1', name: 'Tala' }] }.to_json, headers: { 'Content-Type' => 'application/json' })

    get "#{base}/accounts", params: { search: 'ta' }, headers: admin.create_new_auth_token, as: :json

    expect(response.parsed_body['payload']).to eq([{ 'id' => 'acc-1', 'name' => 'Tala' }])
  end

  it "links the conversation's channel to the account through the bridge" do
    stub = stub_request(:post, 'http://bridges.test/internal/grip/link')
           .with(body: { channel_key: 'teams:19:abc', account_id: 'acc-1' }.to_json, headers: { 'X-Kita-Bridge-Secret' => 'link-secret' })
           .to_return(status: 200, body: { linked: true }.to_json, headers: { 'Content-Type' => 'application/json' })

    post base, params: { conversation_id: conversation.display_id, grip_account_id: 'acc-1' }, headers: admin.create_new_auth_token, as: :json

    expect(response).to have_http_status(:ok), response.body
    expect(stub).to have_been_requested
  end

  it 'passes on a channel Grip does not list as unlinked' do
    stub_request(:post, 'http://bridges.test/internal/grip/link')
      .to_return(status: 404, body: { error: 'channel is not in Grip’s unlinked list' }.to_json, headers: { 'Content-Type' => 'application/json' })

    post base, params: { conversation_id: conversation.display_id, grip_account_id: 'acc-1' }, headers: admin.create_new_auth_token, as: :json

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body['error']).to include('unlinked list')
  end
end
