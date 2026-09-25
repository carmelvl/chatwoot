# Kita: history kita-bridges imports when the Kita bot/user joins a channel or chat
# (content_attributes.kita_backfill, see Kita::Bridge.message_attributes). Such a message:
# - keeps the time it was really sent (content_attributes.external_created_at) as created_at;
# - never reopens a conversation, starts waiting_since / first-reply metrics, or bumps the contact;
# - leaves the conversation's last_activity_at on its real latest message;
# - still dispatches message_created (desk UI, webhooks: grip-sync counts it but only classifies recent threads),
#   while Kita::QuietBackfill keeps notifications, automations, hooks and bots out of it.
module Kita::MessageBackfill
  def self.prepended(base)
    base.before_create :apply_kita_backfill_created_at, if: :kita_backfill?
  end

  def kita_backfill?
    content_attributes.is_a?(Hash) && content_attributes['kita_backfill'] == true
  end

  private

  def apply_kita_backfill_created_at
    self.created_at = Time.zone.at(external_created_at.to_f) if external_created_at.present?
  end

  def reopen_conversation
    super unless kita_backfill?
  end

  def dispatch_create_events
    return super unless kita_backfill?

    Rails.configuration.dispatcher.dispatch(MESSAGE_CREATED, Time.zone.now, message: self, performed_by: Current.executed_by)
  end

  def set_conversation_activity
    return super unless kita_backfill?

    latest = conversation.messages.where.not(message_type: :activity).maximum(:created_at)
    # rubocop:disable Rails/SkipsModelValidations
    conversation.update_columns(last_activity_at: latest || created_at, updated_at: Time.current)
    # rubocop:enable Rails/SkipsModelValidations
  end

  def execute_message_template_hooks
    super unless kita_backfill?
  end

  def update_contact_activity
    super unless kita_backfill?
  end
end
