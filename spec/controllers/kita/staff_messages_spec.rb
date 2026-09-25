require 'rails_helper'

RSpec.describe 'Kita bridge staff messages', type: :request do
  let(:account) { create(:account) }
  let(:api_channel) { create(:channel_api, account: account) }
  let(:contact) { create(:contact, account: account) }
  let(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: api_channel.inbox) }
  let(:conversation) { create(:conversation, account: account, inbox: api_channel.inbox, contact: contact, contact_inbox: contact_inbox) }
  let!(:agent) { create(:user, account: account, email: 'sam.lee@kita.ai') }
  let(:secret) { 'link-secret' }
  let(:params) do
    {
      conversation_id: conversation.display_id, email: 'Sam.Lee@Kita.ai', content: 'On it',
      content_attributes: { external_source: 'slack', external_channel: '#kita-tala', external_channel_key: 'slack:T1:C1' }
    }
  end

  around do |example|
    with_modified_env(BRIDGE_LINK_SECRET: secret, KITA_BRIDGE_ACCOUNT_ID: account.id.to_s) { example.run }
  end

  it 'rejects requests without the bridge secret' do
    post '/api/v1/kita/staff_messages', params: params
    expect(response).to have_http_status(:unauthorized)
  end

  it 'rejects a wrong bridge secret' do
    post '/api/v1/kita/staff_messages', params: params, headers: { 'X-Kita-Bridge-Secret' => 'nope' }
    expect(response).to have_http_status(:unauthorized)
  end

  it 'posts as the matching desk agent, marked so the bridge never sends it back out' do
    expect do
      post '/api/v1/kita/staff_messages', params: params, headers: { 'X-Kita-Bridge-Secret' => secret }
    end.to change(conversation.messages.outgoing, :count).by(1)

    message = conversation.messages.outgoing.last
    expect(response.parsed_body).to eq('id' => message.id, 'sender_type' => 'User', 'sender_id' => agent.id)
    expect(message).to have_attributes(sender: agent, private: false, content: 'On it')
    expect(message.content_attributes).to include('kita_bridge_origin' => true, 'external_source' => 'slack',
                                                  'external_channel' => '#kita-tala', 'external_channel_key' => 'slack:T1:C1')
    expect(response.body).not_to include('access_token')
  end

  it 'posts a file-only staff message (no text) with its images and files as desk attachments' do
    image = Rack::Test::UploadedFile.new(Rails.root.join('spec/assets/avatar.png'), 'image/png')
    pdf = Rack::Test::UploadedFile.new(Rails.root.join('spec/assets/sample.pdf'), 'application/pdf')
    post '/api/v1/kita/staff_messages', params: params.merge(content: '', attachments: [image, pdf]),
                                        headers: { 'X-Kita-Bridge-Secret' => secret }

    expect(response).to have_http_status(:ok)
    message = conversation.messages.outgoing.last
    expect(message.content).to be_blank
    expect(message.attachments.map(&:file_type)).to eq(%w[image file])
    expect(message.attachments.map { |a| a.file.attached? }).to eq([true, true])
  end

  it 'matches across Kita email domain aliases (usekita.com is kita.ai)' do
    post '/api/v1/kita/staff_messages', params: params.merge(email: 'SAM.LEE@usekita.com'), headers: { 'X-Kita-Bridge-Secret' => secret }
    expect(conversation.messages.outgoing.last.sender).to eq(agent)
  end

  it 'posts a teammate with no desk account as themselves (a Kita staff contact), never the bridge user' do
    create(:user, email: 'outsider@kita.ai')
    staff = params.merge(email: 'outsider@kita.ai', staff_key: 'slack:U_SURAAJ', name: 'Suraaj Samanta')
    expect do
      post '/api/v1/kita/staff_messages', params: staff, headers: { 'X-Kita-Bridge-Secret' => secret }
    end.to change(account.contacts, :count).by(1)

    message = conversation.messages.outgoing.last
    expect(response.parsed_body).to include('sender_type' => 'Contact')
    expect(message.sender).to have_attributes(name: 'Suraaj Samanta', identifier: 'kita-staff:slack:U_SURAAJ')
    expect(message.sender.custom_attributes).to eq('kita_staff' => true)
    expect(message.content).to eq('On it')
  end

  it 'reuses the staff contact for the same teammate' do
    staff = params.except(:email).merge(staff_key: 'slack:U_SURAAJ', name: 'Suraaj Samanta')
    post '/api/v1/kita/staff_messages', params: staff, headers: { 'X-Kita-Bridge-Secret' => secret }
    expect do
      post '/api/v1/kita/staff_messages', params: staff, headers: { 'X-Kita-Bridge-Secret' => secret }
    end.not_to change(Contact, :count)
  end

  it 'only reaches conversations in the Kita account' do
    other = create(:conversation)
    post '/api/v1/kita/staff_messages', params: params.merge(conversation_id: other.display_id + 1000),
                                        headers: { 'X-Kita-Bridge-Secret' => secret }
    expect(response).to have_http_status(:not_found)
  end
end
