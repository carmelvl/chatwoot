require 'rails_helper'

RSpec.describe 'Kita WhatsApp groups', type: :request do
  let(:account) { create(:account) }
  let(:admin) { create(:user, account: account, role: :administrator) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:base) { "/api/v1/accounts/#{account.id}/kita/whatsapp_groups" }
  let(:json) { { 'Content-Type' => 'application/json' } }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: 'link-secret', WA_GROUPS_INTERNAL_URL: 'http://wa-groups.test',
                      WA_GROUPS_PUBLIC_URL: 'https://desk.test/wa-groups') { example.run }
  end

  it 'is for administrators only' do
    get base, headers: agent.create_new_auth_token, as: :json
    expect(response).to have_http_status(:unauthorized)
  end

  it 'shows the connection status and joined groups from the service' do
    status = { status: 'connected', connected: true, number: '+14155550100', send_enabled: false,
               groups: [{ jid: '1203@g.us', subject: 'Kita x Tala', participants: 4 }] }
    stub_request(:get, 'http://wa-groups.test/wa-groups/status')
      .with(headers: { 'X-Kita-Bridge-Secret' => 'link-secret' })
      .to_return(status: 200, body: status.to_json, headers: json)

    get base, headers: admin.create_new_auth_token, as: :json

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body['number']).to eq('+14155550100')
    expect(response.parsed_body['groups'].first['subject']).to eq('Kita x Tala')
  end

  it 'answers 502 when the service is down' do
    stub_request(:get, 'http://wa-groups.test/wa-groups/status').to_raise(Errno::ECONNREFUSED)

    get base, headers: admin.create_new_auth_token, as: :json

    expect(response).to have_http_status(:bad_gateway)
  end

  it 'joins a group by invite link through the service' do
    stub = stub_request(:post, 'http://wa-groups.test/wa-groups/join')
           .with(body: { invite_link: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' }.to_json,
                 headers: { 'X-Kita-Bridge-Secret' => 'link-secret' })
           .to_return(status: 200, body: { jid: '1203@g.us', subject: 'Kita x Tala' }.to_json, headers: json)

    post base, params: { invite_link: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' }, headers: admin.create_new_auth_token, as: :json

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq('jid' => '1203@g.us', 'subject' => 'Kita x Tala')
    expect(stub).to have_been_requested
  end

  it 'passes on a bad link and the join rate limit' do
    stub_request(:post, 'http://wa-groups.test/wa-groups/join')
      .to_return({ status: 422, body: { error: 'invalid_invite_link' }.to_json, headers: json },
                 { status: 429, body: { error: 'join_rate_limited' }.to_json, headers: json })

    post base, params: { invite_link: 'nope' }, headers: admin.create_new_auth_token, as: :json
    expect(response).to have_http_status(:unprocessable_entity)
    expect(response.parsed_body['error']).to eq('invalid_invite_link')

    post base, params: { invite_link: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' }, headers: admin.create_new_auth_token, as: :json
    expect(response).to have_http_status(:too_many_requests)
  end

  it 'mints a short-lived signed pair link without exposing the secret' do
    travel_to Time.zone.at(1_758_000_000) do
      get "#{base}/pair_link", headers: admin.create_new_auth_token, as: :json
    end

    exp = (1_758_000_000 + 15.minutes.to_i).to_s
    sig = OpenSSL::HMAC.hexdigest('SHA256', 'link-secret', "wa-groups-pair|#{exp}")
    expect(response.parsed_body['url']).to eq("https://desk.test/wa-groups/pair?x=#{exp}&s=#{sig}")
    expect(response.body).not_to include('link-secret')
  end
end
