# Kita: kita-bridges posts a message a Kita teammate typed directly in Slack/Teams, authored by that
# teammate's desk user (matched by email). Bridge-only (X-Kita-Bridge-Secret). This keeps agent
# access tokens inside the desk: the bridge never holds one.
class Api::V1::Kita::StaffMessagesController < ApplicationController
  skip_before_action :set_current_user
  before_action :authenticate_bridge!

  def create
    conversation = account.conversations.find_by!(display_id: params.require(:conversation_id))
    agent = account.users.find_by('LOWER(users.email) = ?', params.require(:email).to_s.downcase)
    return render json: { error: 'no_agent' }, status: :not_found if agent.nil?

    message = Messages::MessageBuilder.new(agent, conversation, message_params).perform
    render json: { id: message.id, sender_id: agent.id }
  end

  private

  def authenticate_bridge!
    head :unauthorized unless ::Kita::Bridge.valid_secret?(request.headers['X-Kita-Bridge-Secret'])
  end

  def account
    @account ||= Account.find(ENV.fetch('KITA_BRIDGE_ACCOUNT_ID', '1'))
  end

  def message_params
    {
      content: params[:content],
      message_type: 'outgoing',
      private: false,
      attachments: params[:attachments],
      content_attributes: ::Kita::Bridge.message_attributes(params[:content_attributes]).merge(kita_bridge_origin: true)
    }.with_indifferent_access
  end
end
