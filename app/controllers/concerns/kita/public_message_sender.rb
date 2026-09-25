# Kita: lets kita-bridges attribute each incoming API-channel message to the person who wrote it.
# `sender_identifier` names another contact of the same inbox (several customer people talk in one
# Slack/Teams channel conversation); `content_attributes` carries the platform, thread and reply target
# (Kita::Bridge.message_attributes).
module Kita::PublicMessageSender
  private

  def message_params
    overrides = {}
    overrides[:sender] = kita_sender if params[:sender_identifier].present?
    attrs = Kita::Bridge.message_attributes(params[:content_attributes])
    overrides[:content_attributes] = attrs if attrs.present?
    super.merge(overrides)
  end

  def kita_sender
    @conversation.inbox.contact_inboxes.joins(:contact).find_by!(contacts: { identifier: params[:sender_identifier] }).contact
  end
end
