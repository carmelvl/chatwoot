# Kita: kita-bridges mirrors a message a Kita teammate typed directly in Slack/Teams (or sent from their
# WhatsApp phone) into the desk, authored by that teammate. Bridge-only (X-Kita-Bridge-Secret); agent
# access tokens never leave the desk.
# - The desk agent whose email matches (EMAIL_DOMAIN_ALIASES applied to both sides) is the sender.
# - A teammate with no desk account is posted as themselves: a Kita-staff contact (their platform name
#   and avatar, custom_attributes.kita_staff), never the shared bridge user.
class Api::V1::Kita::StaffMessagesController < ApplicationController
  skip_before_action :set_current_user
  before_action :authenticate_bridge!

  def create
    conversation = account.conversations.find_by!(display_id: params.require(:conversation_id))
    sender = matching_agent || staff_contact
    # The builder authors outgoing messages by whoever is passed in: here the agent or the staff contact.
    message = Messages::MessageBuilder.new(sender, conversation, message_params).perform
    render json: { id: message.id, sender_type: sender.class.name, sender_id: sender.id }
  end

  private

  def authenticate_bridge!
    head :unauthorized unless ::Kita::Bridge.valid_secret?(request.headers['X-Kita-Bridge-Secret'])
  end

  def account
    @account ||= Account.find(ENV.fetch('KITA_BRIDGE_ACCOUNT_ID', '1'))
  end

  def matching_agent
    return if params[:email].blank?

    email = ::Kita::Bridge.normalize_email(params[:email])
    account.users.find { |user| ::Kita::Bridge.normalize_email(user.email) == email }
  end

  def staff_contact
    contact = account.contacts.find_or_initialize_by(identifier: "kita-staff:#{params.require(:staff_key)}")
    contact.update!(name: params.require(:name), custom_attributes: contact.custom_attributes.merge('kita_staff' => true))
    Avatar::AvatarFromUrlJob.perform_later(contact, params[:avatar_url]) if params[:avatar_url].present? && !contact.avatar.attached?
    contact
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
