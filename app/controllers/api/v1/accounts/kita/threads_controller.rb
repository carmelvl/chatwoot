# Kita: the thread list beside a customer conversation (threads = root messages with replies, or with
# kita_threads metadata), thread-level status and per-agent read marks.
class Api::V1::Accounts::Kita::ThreadsController < Api::V1::Accounts::BaseController
  before_action :fetch_conversation
  before_action :fetch_root_message, only: [:update, :read]

  def index
    render json: { payload: ::Kita::Threads.new(@conversation, Current.user).rows }
  end

  def update
    status = params.require(:status)
    return render_could_not_create_error('Invalid status') unless ::Kita::MessageThread.statuses.key?(status)

    thread = ::Kita::MessageThread.find_or_initialize_by(root_message_id: @root_message.id)
    thread.update!(account: Current.account, conversation: @conversation, status: status)
    render json: { root_message_id: @root_message.id, status: thread.status, ticket_synced: sync_ticket(thread) }
  end

  def read
    mark = ::Kita::ThreadRead.find_or_initialize_by(user: Current.user, root_message_id: @root_message.id)
    mark.update!(conversation: @conversation, last_read_at: Time.current)
    head :ok
  end

  private

  # Resolving (or reopening) a thread moves its Grip ticket too, through kita-grip-sync. The thread status
  # is the desk's own, so it is kept even when grip-sync can't be reached; the client is told.
  def sync_ticket(thread)
    return nil if thread.ticket_id.blank?

    ticket_status = thread.resolved? ? 'resolved' : 'open'
    ::Kita::GripSync.set_ticket_status(@conversation, thread.root_message_id, ticket_status)
    thread.update!(ticket_status: ticket_status)
    true
  rescue StandardError => e
    Rails.logger.warn("kita grip-sync ticket status failed: #{e.message}")
    false
  end

  def fetch_conversation
    accessible = Current.account.conversations.where(inbox_id: Current.user.assigned_inboxes.select(:id))
    @conversation = accessible.find_by!(display_id: params[:conversation_id])
  end

  def fetch_root_message
    @root_message = @conversation.messages.find(params[:id])
  end
end
