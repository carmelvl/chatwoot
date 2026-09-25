# Kita: every Grip ticket on the desk (kita_threads rows with a ticket), across the customers an agent can see.
# Row shape: {id, root_message_id, conversation_id (display id), ticket_id, display_id (KT-n)|nil, title, url, priority,
#   status, owner, platform, customer_id (Inbox row id), customer_name, created_at, updated_at}; by priority, then most
#   recently updated.
# Filters: scope (mine = the ticket owner is me, unowned, all), priority, status (open = not resolved or dismissed, the
# default; all; or a Grip status), customer_id (an Inbox row id), platform.
class Kita::Tickets
  PRIORITIES = %w[urgent high medium low].freeze
  SCOPES = %w[mine unowned all].freeze
  STATUSES = %w[open all in_progress waiting_on_customer resolved dismissed].freeze
  CLOSED = %w[resolved dismissed].freeze

  class InvalidFilter < StandardError; end

  def initialize(viewer, params)
    @viewer = viewer
    @params = params
  end

  def rows
    threads = filter(::Kita::MessageThread.where.not(ticket_id: nil).where(conversation_id: conversations.select(:id)))
    threads = threads.includes(:conversation, :root_message).to_a
    @row_ids = ::Kita::Customers.row_ids(Conversation.where(id: threads.map(&:conversation_id)))
    threads.sort_by { |thread| [PRIORITIES.index(thread.ticket_priority) || PRIORITIES.size, -thread.updated_at.to_i] }.map { |t| row(t) }
  end

  private

  def conversations
    scope = @viewer.conversations
    scope = scope.where("#{::Kita::Customers::ROW_KEY} = ?", @params[:customer_id]) if @params[:customer_id].present?
    return scope if @params[:platform].blank?

    scope.where("conversations.custom_attributes->>'channel' = ?", @params[:platform])
  end

  def filter(threads)
    status = @params[:status].presence || 'open'
    raise InvalidFilter, "Invalid status: #{status}" unless STATUSES.include?(status)

    threads = case status
              when 'open' then threads.where('ticket_status IS NULL OR ticket_status NOT IN (?)', CLOSED)
              when 'all' then threads
              else threads.where(ticket_status: status)
              end
    if @params[:priority].present?
      raise InvalidFilter, "Invalid priority: #{@params[:priority]}" unless PRIORITIES.include?(@params[:priority])

      threads = threads.where(ticket_priority: @params[:priority])
    end
    filter_scope(threads)
  end

  def filter_scope(threads)
    case @params[:scope].presence || 'all'
    when 'mine' then mine(threads)
    when 'unowned' then threads.where(ticket_owner: [nil, ''])
    when 'all' then threads
    else raise InvalidFilter, "Invalid scope: #{@params[:scope]}"
    end
  end

  # grip-sync sends the owner as a name or an email
  def mine(threads)
    threads.where('LOWER(ticket_owner) IN (?)', @viewer.names_and_emails)
  end

  def row(thread)
    conversation = thread.conversation
    attrs = conversation.custom_attributes || {}
    {
      id: thread.id, root_message_id: thread.root_message_id, conversation_id: conversation.display_id, ticket_id: thread.ticket_id,
      display_id: thread.ticket_display_id, title: thread.title.presence || thread.root_message&.content.to_s.truncate(120),
      url: thread.ticket_url, priority: thread.ticket_priority, status: thread.ticket_status || 'open', owner: thread.ticket_owner,
      platform: attrs['channel'], customer_id: @row_ids[conversation.id],
      customer_name: attrs['grip_account'].presence || ::Kita::Customers.display_label(attrs['channel_label'], attrs['channel']),
      created_at: thread.created_at.to_i, updated_at: thread.updated_at.to_i
    }
  end
end
