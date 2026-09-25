require 'rails_helper'

RSpec.describe 'Kita history backfill on the public inbox API', type: :request do
  let!(:api_channel) { create(:channel_api) }
  let(:account) { api_channel.account }
  let!(:contact) { create(:contact, account: account, identifier: 'slack-channel:slack:C1') }
  let!(:contact_inbox) { create(:contact_inbox, contact: contact, inbox: api_channel.inbox) }
  let!(:conversation) do
    create(:conversation, account: account, inbox: api_channel.inbox, contact: contact, contact_inbox: contact_inbox)
  end
  let(:path) do
    "/public/api/v1/inboxes/#{api_channel.identifier}/contacts/#{contact_inbox.source_id}/conversations/#{conversation.display_id}/messages"
  end
  let(:sent_at) { Time.zone.parse('2026-03-02 09:15:30') }

  def backfill(content, time)
    attrs = { external_source: 'slack', kita_backfill: 'true', external_created_at: time.to_f.to_s }
    post path, params: { content: content, content_attributes: attrs }
    expect(response).to have_http_status(:success)
    conversation.messages.incoming.find_by!(content: content)
  end

  it 'keeps the original timestamp and marks the message as history' do
    message = backfill('old question', sent_at)

    expect(message.created_at).to be_within(1.second).of(sent_at)
    expect(message.content_attributes).to include('kita_backfill' => true, 'external_source' => 'slack')
    expect(conversation.reload.last_activity_at).to be_within(1.second).of(sent_at)
  end

  it 'ignores external_created_at on live messages' do
    post path, params: { content: 'live', content_attributes: { external_created_at: sent_at.to_i.to_s } }

    message = conversation.messages.incoming.last
    expect(message.created_at).to be_within(1.minute).of(Time.current)
    expect(message.content_attributes).not_to have_key('kita_backfill')
    expect(message.content_attributes).not_to have_key('external_created_at')
  end

  it 'leaves last_activity_at on the real latest message and does not reopen a resolved conversation' do
    create(:message, conversation: conversation, account: account, inbox: conversation.inbox, message_type: :incoming, created_at: 1.hour.ago)
    conversation.resolved!
    latest = conversation.messages.maximum(:created_at)

    backfill('older history', sent_at)

    expect(conversation.reload.status).to eq('resolved')
    expect(conversation.last_activity_at).to be_within(1.second).of(latest)
  end

  it 'orders imported history by its original time' do
    backfill('second', sent_at + 1.minute)
    backfill('first', sent_at)

    expect(conversation.messages.incoming.pluck(:content)).to eq(%w[first second])
  end

  it 'notifies no agent and runs no automation for imported history' do
    message = backfill('old question', sent_at)
    event = Events::Base.new('message.created', Time.zone.now, message: message)

    expect(Messages::NewMessageNotificationService).not_to receive(:new)
    expect(Messages::MentionService).not_to receive(:new)
    NotificationListener.instance.message_created(event)
    expect(AutomationRuleListener.instance.message_created(event)).to be_nil
  end

  it 'still notifies for live messages' do
    post path, params: { content: 'live' }
    event = Events::Base.new('message.created', Time.zone.now, message: conversation.messages.incoming.last)

    expect(Messages::NewMessageNotificationService).to receive(:new).and_call_original
    NotificationListener.instance.message_created(event)
  end
end
