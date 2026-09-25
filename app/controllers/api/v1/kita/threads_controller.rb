# Kita: thread metadata from kita-grip-sync (AI title, Grip ticket link, display id, priority, status, owner, SLA) keyed by the thread's root desk message.
class Api::V1::Kita::ThreadsController < ApplicationController
  include ::Kita::BridgeRequest

  THREAD_FIELDS = %i[title ticket_id ticket_url ticket_display_id ticket_priority ticket_status ticket_owner ticket_sla_due_at].freeze

  def create
    conversation = account.conversations.find_by!(display_id: params.require(:conversation_id))
    root = conversation.messages.find(params.require(:root_message_id))
    thread = ::Kita::MessageThread.find_or_initialize_by(root_message_id: root.id)
    thread.update!(account: account, conversation: conversation, **params.permit(*THREAD_FIELDS).to_h.symbolize_keys)
    render json: { id: thread.id }
  end
end
