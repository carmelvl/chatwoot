# Kita: the details of customer rows (Kita::Customers), loaded for all rows in a few queries: the per-platform
# conversations (the header tabs), the waiting or latest public message, unread counts, tickets, labels and the DRI.
class Kita::CustomerDetails
  PRESSING = %w[urgent high].freeze
  PRIORITIES = %w[urgent high medium low].freeze
  # The worst state of a row's conversations names its section (in this order)
  SECTION_BY_STATE = { 'needs_reply' => 'needs_reply', 'open' => 'active', 'pending' => 'active', 'snoozed' => 'snoozed' }.freeze

  def initialize(conversations, rows)
    @conversations = conversations
    @rows = rows
  end

  def attach
    keys = ::Kita::Customers.row_ids(@conversations)
    conversations = @conversations.includes(:contact, :inbox).to_a
    load(conversations.map(&:id))
    by_key = conversations.group_by { |conversation| keys[conversation.id] }
    @rows.each { |row| row.merge!(details(row, (by_key[row[:id]] || []).sort_by { |c| -c.last_activity_at.to_i })) }
  end

  private

  def load(ids)
    @latest = latest_messages(ids)
    @unread = unread_counts(ids)
    @tickets = ::Kita::MessageThread.where(conversation_id: ids).where(::Kita::CustomerSql::OPEN_TICKET).includes(:conversation)
                                    .group_by(&:conversation_id)
    @needs_reply = @conversations.where(::Kita::CustomerSql::NEEDS_REPLY).pluck(:id).to_set
    @users = dri_users
  end

  def details(row, list)
    identity(row, list).merge(activity(list), tickets(list.flat_map { |c| @tickets.fetch(c.id, []) }), attributes(list))
  end

  def identity(row, list)
    {
      name: row_name(row, list.first), section: section(row, list),
      channel_key: row[:kind] == 'unlinked' ? attribute(list.first, 'channel_key') : nil,
      grip_account_id: list.filter_map { |c| attribute(c, 'grip_account_id').presence }.first,
      dri_id: @users[::Kita::Bridge.normalize_email(row[:dri_email].to_s)]&.id,
      not_customer: list.all? { |c| attribute(c, 'kita_not_customer') == 'true' }
    }
  end

  def attribute(conversation, key)
    (conversation&.custom_attributes || {})[key]
  end

  # The customer waits since its oldest unanswered message; the preview is that message, else the latest one.
  def activity(list)
    waiting = list.select { |c| @needs_reply.include?(c.id) }.min_by { |c| waiting_since(c) }
    {
      conversations: list.map { |c| conversation_row(c) }, unread_count: list.sum { |c| @unread[c.id].to_i },
      waiting_since: waiting && waiting_since(waiting), waiting_platform: attribute(waiting, 'channel'),
      last_message: latest_message_row(waiting ? [waiting] : list)
    }
  end

  def waiting_since(conversation)
    (conversation.waiting_since || conversation.last_activity_at).to_i
  end

  def tickets(tickets)
    pressing = tickets.select { |t| PRESSING.include?(t.ticket_priority) }
                      .sort_by { |t| [PRESSING.index(t.ticket_priority), -t.updated_at.to_i] }
    {
      open_tickets: tickets.size, tickets_by_priority: PRIORITIES.index_with { |priority| tickets.count { |t| t.ticket_priority == priority } },
      urgent_ticket: tickets.any? { |t| t.ticket_priority == 'urgent' },
      top_ticket: pressing.first && ticket_row(pressing.first), pressing_tickets: pressing.size
    }
  end

  def ticket_row(ticket)
    { display_id: ticket.ticket_display_id, ticket_id: ticket.ticket_id, priority: ticket.ticket_priority, title: ticket.title,
      url: ticket.ticket_url, conversation_id: ticket.conversation.display_id, root_message_id: ticket.root_message_id }
  end

  def attributes(list)
    {
      labels: list.flat_map(&:cached_label_list_array).uniq.sort, team_ids: list.filter_map(&:team_id).uniq,
      assignee_ids: list.filter_map(&:assignee_id).uniq,
      snoozed_until: list.select(&:snoozed?).filter_map(&:snoozed_until).min&.to_i
    }
  end

  # Worst state wins: needs reply, then active (open), snoozed, resolved. Unlinked channels are their own section.
  def section(row, list)
    return 'unlinked' if row[:kind] == 'unlinked'

    states = list.map { |c| @needs_reply.include?(c.id) ? 'needs_reply' : c.status }
    SECTION_BY_STATE.find { |state, _section| states.include?(state) }&.last || 'resolved'
  end

  # normalized email => User, for the DRIs of the rows
  def dri_users
    emails = @rows.filter_map { |row| row[:dri_email].presence&.then { |email| ::Kita::Bridge.normalize_email(email) } }.uniq
    return {} if emails.empty?

    users = User.joins(:account_users).where(account_users: { account_id: @conversations.pick(:account_id) })
    users.to_a.select { |user| emails.include?(::Kita::Bridge.normalize_email(user.email)) }
         .index_by { |user| ::Kita::Bridge.normalize_email(user.email) }
  end

  def row_name(row, latest)
    case row[:kind]
    when 'customer' then row[:name]
    when 'unlinked' then channel_label(latest)
    else latest&.contact&.name.presence || latest&.inbox&.name
    end
  end

  def latest_message_row(list)
    message = list.filter_map { |c| @latest[c.id] }.max_by(&:created_at)
    message && message_row(message)
  end

  def conversation_row(conversation)
    attrs = conversation.custom_attributes || {}
    {
      id: conversation.display_id, platform: attrs['channel'], label: channel_label(conversation), status: conversation.status,
      needs_reply: @needs_reply.include?(conversation.id), unread_count: @unread[conversation.id].to_i,
      last_activity_at: conversation.last_activity_at&.to_i, inbox_id: conversation.inbox_id, channel_type: conversation.inbox&.channel_type
    }
  end

  def channel_label(conversation)
    attrs = conversation.custom_attributes || {}
    candidates = [attrs['channel_label'], first_channel_label(attrs['kita_channels']), conversation.contact&.name]
    ::Kita::Customers.display_label(candidates.find { |label| label.present? && !label.match?(::Kita::Customers::RAW_KEY) }, attrs['channel'])
  end

  def first_channel_label(raw)
    return if raw.blank?

    channel = JSON.parse(raw).first
    channel.is_a?(Hash) ? channel['label'].presence : nil
  rescue JSON::ParserError
    nil
  end

  def message_row(message)
    {
      content: message.content.to_s.truncate(160), sender_name: message.sender&.name || message.additional_attributes&.dig('sender_name'),
      platform: message.content_attributes&.dig('external_source') || message.conversation.custom_attributes&.dig('channel'),
      message_type: message.message_type, created_at: message.created_at.to_i
    }
  end

  def latest_messages(ids)
    types = [Message.message_types[:incoming], Message.message_types[:outgoing], Message.message_types[:template]]
    Message.where(conversation_id: ids, private: false, message_type: types)
           .select('DISTINCT ON (messages.conversation_id) messages.*')
           .reorder(Arel.sql('messages.conversation_id, messages.created_at DESC'))
           .includes(:sender, :conversation).index_by(&:conversation_id)
  end

  # Incoming messages the agents haven't seen (Chatwoot's conversation-level agent_last_seen_at).
  def unread_counts(ids)
    Message.reorder(nil).joins(:conversation).where(conversation_id: ids, message_type: :incoming)
           .where('conversations.agent_last_seen_at IS NULL OR messages.created_at > conversations.agent_last_seen_at')
           .group(:conversation_id).count
  end
end
