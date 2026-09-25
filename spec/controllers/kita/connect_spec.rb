require 'rails_helper'

RSpec.describe 'Kita connect accounts', type: :request do
  let(:account) { create(:account) }
  let(:user) { create(:user, account: account, email: 'sam.lee@kita.ai') }
  # Shared with kita-bridges/test/agents.test.ts: the same inputs must produce the same signed link.
  let(:fixture) { JSON.parse(Rails.root.join('kita-bridges/test/fixtures/connect-link.json').read) }
  let(:secret) { 'link-secret' }

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: secret, BRIDGE_PUBLIC_URL: nil, BRIDGE_INTERNAL_URL: 'http://bridges.test') { example.run }
  end

  def expected_signature(user, exp)
    OpenSSL::HMAC.hexdigest('SHA256', secret, "#{user.id}|#{user.email.downcase}|#{exp}")
  end

  describe 'Kita::Bridge.connect_url' do
    it 'signs exactly like the bridge (cross-language fixture)' do
      with_modified_env(BRIDGE_LINK_SECRET: fixture['secret'], BRIDGE_PUBLIC_URL: fixture['publicUrl']) do
        agent = User.new(id: fixture['agent']['id'], email: fixture['agent']['email'])
        expect(Kita::Bridge.connect_url(agent, now: Time.zone.at(fixture['nowS']))).to eq(fixture['url'])
      end
    end
  end

  describe 'GET /kita/connect' do
    it 'sends signed-out visitors to the login page' do
      get '/kita/connect'
      expect(response).to redirect_to('/app/login')
    end

    it 'redirects the signed-in agent to their signed bridge connect link' do
      freeze_time do
        get '/kita/connect', headers: user.create_new_auth_token

        exp = 7.days.from_now.to_i
        location = URI.parse(response.location)
        expect(response).to have_http_status(:redirect)
        expect("#{location.scheme}://#{location.host}#{location.path}").to eq('https://support.internal.kita.ai/bridges/connect')
        expect(Rack::Utils.parse_query(location.query)).to eq(
          'a' => user.id.to_s, 'e' => 'sam.lee@kita.ai', 'x' => exp.to_s, 's' => expected_signature(user, exp)
        )
      end
    end

    it 'accepts the dashboard session cookie (opened in a new tab)' do
      cookies[:cw_d_session_info] = user.create_new_auth_token.to_json
      get '/kita/connect'
      expect(response.location).to start_with('https://support.internal.kita.ai/bridges/connect?a=')
    end

    it 'rejects a forged session cookie' do
      cookies[:cw_d_session_info] = { 'access-token' => 'forged', 'client' => 'x', 'uid' => user.email }.to_json
      get '/kita/connect'
      expect(response).to redirect_to('/app/login')
    end
  end

  describe 'GET /api/v1/kita/connections' do
    let(:status) { { 'slack' => 'connected', 'teams' => 'unavailable', 'whatsapp' => 'none', 'viber' => 'not_applicable' } }

    it 'requires a signed-in user' do
      get '/api/v1/kita/connections'
      expect(response).to have_http_status(:unauthorized)
    end

    it "proxies the bridge's status for the current agent, authenticated with the shared secret" do
      stub = stub_request(:get, 'http://bridges.test/connect/status')
             .with(query: { a: user.id.to_s, e: 'sam.lee@kita.ai' }, headers: { 'X-Kita-Bridge-Secret' => secret })
             .to_return(status: 200, body: status.to_json, headers: { 'content-type' => 'application/json' })

      get '/api/v1/kita/connections', headers: user.create_new_auth_token

      expect(stub).to have_been_requested
      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).to eq(status)
    end

    it 'returns 502 when the bridge is unavailable' do
      stub_request(:get, %r{bridges\.test/connect/status}).to_return(status: 500)

      get '/api/v1/kita/connections', headers: user.create_new_auth_token

      expect(response).to have_http_status(:bad_gateway)
      expect(response.parsed_body).to eq('error' => 'bridge_unavailable')
    end
  end
end
