# Kita: kita-bridges merges a channel's `channel:<key>` conversation into its customer's account conversation
# once Grip links the channel. Moves every message (and thread metadata / read marks) into the target,
# marks the source merged_into and resolves it. Idempotent: a repeat call moves nothing.
class Api::V1::Kita::ConversationMergesController < ApplicationController
  include ::Kita::BridgeRequest

  def create
    from = account.conversations.find_by!(display_id: params.require(:from_conversation_id))
    to = account.conversations.find_by!(display_id: params.require(:to_conversation_id))
    return render_could_not_create_error('Conversations must differ and share an inbox') if from.id == to.id || from.inbox_id != to.inbox_id

    moved = merge(from, to)
    render json: { moved: moved }
  end

  private

  # A repeat call is a no-op (resolving `from` may have added an activity message there since).
  def merge(from, to)
    return 0 if from.custom_attributes['merged_into'] == to.display_id

    ActiveRecord::Base.transaction do
      # rubocop:disable Rails/SkipsModelValidations
      moved = from.messages.update_all(conversation_id: to.id)
      ::Kita::MessageThread.where(conversation_id: from.id).update_all(conversation_id: to.id)
      ::Kita::ThreadRead.where(conversation_id: from.id).update_all(conversation_id: to.id)
      # rubocop:enable Rails/SkipsModelValidations
      from.update!(status: :resolved, custom_attributes: from.custom_attributes.merge('merged_into' => to.display_id))
      last_activity = to.messages.maximum(:created_at)
      to.update!(last_activity_at: last_activity) if last_activity && last_activity > to.last_activity_at
      moved
    end
  end
end
