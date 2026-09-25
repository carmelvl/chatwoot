require 'rails_helper'

RSpec.describe 'Kita account actions', type: :request do
  let(:account) { create(:account) }
  let(:agent) { create(:user, account: account, role: :agent) }
  let(:inbox) { create(:inbox, account: account) }
  let(:path) { "/api/v1/accounts/#{account.id}/kita/account_actions" }
  let(:attrs) { { 'grip_account' => 'Tala', 'grip_account_id' => '7' } }
  let!(:slack) { create(:conversation, account: account, inbox: inbox, custom_attributes: attrs.merge('channel' => 'slack')) }
  let!(:whatsapp) { create(:conversation, account: account, inbox: inbox, custom_attributes: attrs.merge('channel' => 'whatsapp')) }
  let!(:other) { create(:conversation, account: account, inbox: inbox, custom_attributes: { 'grip_account_id' => '9', 'channel' => 'teams' }) }

  def act(params)
    post path, params: params, headers: agent.create_new_auth_token, as: :json
  end

  before { create(:inbox_member, user: agent, inbox: inbox) }

  it 'resolves every conversation of the customer, and its open tickets when asked' do
    root = create(:message, conversation: slack, account: account, inbox: inbox)
    thread = Kita::MessageThread.create!(account: account, conversation: slack, root_message: root, ticket_id: 'T1', ticket_status: 'open')
    allow(Kita::GripSync).to receive(:set_ticket_status)

    act(ids: ['7'], action_name: 'resolve', close_tickets: true)

    expect(response.parsed_body).to eq('updated' => 2)
    expect([slack, whatsapp].map { |c| c.reload.status }).to eq(%w[resolved resolved])
    expect(other.reload.status).to eq('open')
    expect(thread.reload).to have_attributes(status: 'resolved', ticket_status: 'resolved')
    expect(Kita::GripSync).to have_received(:set_ticket_status).with(slack, root.id, 'resolved')
  end

  it 'snoozes, assigns, labels and moves to a team across the customer' do
    act(ids: %w[7 9], action_name: 'snooze', snoozed_until: 1.day.from_now.to_i)
    expect([slack, whatsapp, other].map { |c| c.reload.status }.uniq).to eq(['snoozed'])

    act(ids: ['7'], action_name: 'assign', assignee_id: agent.id)
    expect([slack, whatsapp].map { |c| c.reload.assignee }).to eq([agent, agent])

    act(ids: ['7'], action_name: 'label', label: 'billing')
    expect(whatsapp.reload.label_list).to eq(['billing'])

    team = create(:team, account: account)
    act(ids: ['7'], action_name: 'team', team_id: team.id)
    expect(slack.reload.team).to eq(team)
  end

  it 'marks one conversation as replied from the phone' do
    act(conversation_ids: [whatsapp.display_id], action_name: 'replied_from_phone')
    expect(response.parsed_body).to eq('updated' => 1)
    expect(whatsapp.reload.custom_attributes['kita_replied_at'].to_f).to be_within(5).of(Time.current.to_f)
    expect(slack.reload.custom_attributes).not_to have_key('kita_replied_at')
  end

  it 'rejects an unknown action or missing rows' do
    act(ids: ['7'], action_name: 'delete')
    expect(response).to have_http_status(:unprocessable_entity)
    act(action_name: 'resolve')
    expect(response).to have_http_status(:unprocessable_entity)
  end
end
