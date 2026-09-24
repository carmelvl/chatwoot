require 'rails_helper'

RSpec.describe 'Kita Google SSO provisioning', type: :request do
  let!(:account) { create(:account) }

  def mock_google(email:, verified: true, hd: 'kita.ai')
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:google_oauth2] = OmniAuth::AuthHash.new(
      provider: 'google', uid: '42',
      info: { name: 'Sam Lee', email: email, email_verified: verified },
      extra: { raw_info: { hd: hd } }
    )
  end

  def callback
    get '/omniauth/google_oauth2/callback'
    follow_redirect!
  end

  around do |example|
    with_modified_env(KITA_SSO_DOMAINS: 'kita.ai', KITA_SSO_ACCOUNT_ID: account.id.to_s,
                      ENABLE_ACCOUNT_SIGNUP: 'false', FRONTEND_URL: 'http://www.example.com') { example.run }
  end

  before { GlobalConfig.clear_cache }

  it 'adds a verified kita.ai user to the Kita account as an agent and signs them in' do
    mock_google(email: 'sam@kita.ai')
    expect { callback }.to change(User, :count).by(1)
    user = User.find_by(email: 'sam@kita.ai')
    expect(user.account_users.find_by(account: account).role).to eq('agent')
    expect(user.confirmed?).to be(true)
    expect(response.location).to include('sso_auth_token=')
  end

  it 'signs in an existing kita.ai user without creating another' do
    create(:user, email: 'existing@kita.ai', account: account)
    mock_google(email: 'existing@kita.ai')
    expect { callback }.not_to change(User, :count)
    expect(response.location).to include('sso_auth_token=')
  end

  it 'refuses other domains' do
    mock_google(email: 'someone@gmail.com', hd: nil)
    expect { callback }.not_to change(User, :count)
    expect(response.location).to include('error=no-account-found')
  end

  it 'refuses unverified kita.ai emails' do
    mock_google(email: 'spoof@kita.ai', verified: false)
    expect { callback }.not_to change(User, :count)
  end
end
