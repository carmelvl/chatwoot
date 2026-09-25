require 'rails_helper'

# Mentions end to end on a customer conversation: an @mention in a private note notifies the teammate (the bell's
# unread count and Chatwoot's email/push), and the mentioned conversation is theirs in the Inbox.
RSpec.describe 'Kita mentions', type: :request do
  let(:account) { create(:account) }
  let(:carmel) { create(:user, account: account, role: :agent) }
  let(:rhea) { create(:user, account: account, role: :agent, name: 'Rhea Malhotra') }
  let(:inbox) { create(:inbox, account: account) }
  let(:conversation) do
    create(:conversation, account: account, inbox: inbox,
                          custom_attributes: { 'grip_account' => 'Tala', 'grip_account_id' => '7', 'channel' => 'slack' })
  end

  before do
    create(:inbox_member, user: carmel, inbox: inbox)
    create(:inbox_member, user: rhea, inbox: inbox)
  end

  it 'notifies the mentioned teammate and lists the customer under their Mine and Mentions' do
    perform_enqueued_jobs(only: [EventDispatcherJob, Conversations::UserMentionJob]) do
      post "/api/v1/accounts/#{account.id}/conversations/#{conversation.display_id}/messages",
           params: { content: "[@Rhea Malhotra](mention://user/#{rhea.id}/Rhea%20Malhotra) can you check batch 14?", private: true },
           headers: carmel.create_new_auth_token, as: :json
    end
    expect(response).to have_http_status(:ok)

    notification = Notification.find_by(user: rhea, notification_type: 'conversation_mention')
    expect(notification).to have_attributes(primary_actor: conversation, read_at: nil)

    get "/api/v1/accounts/#{account.id}/notifications/unread_count", headers: rhea.create_new_auth_token
    expect(response.parsed_body).to eq(1)

    get "/api/v1/accounts/#{account.id}/kita/inbox", params: { conversation_type: 'mention', scope: 'all' }, headers: rhea.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('id')).to eq(['7'])
    get "/api/v1/accounts/#{account.id}/kita/inbox", headers: rhea.create_new_auth_token
    expect(response.parsed_body['payload'].pluck('id')).to eq(['7'])

    get "/api/v1/accounts/#{account.id}/kita/customers/lookup", params: { conversation_id: conversation.display_id },
                                                                headers: rhea.create_new_auth_token
    expect(response.parsed_body).to include('id' => '7', 'name' => 'Tala')
  end
end
