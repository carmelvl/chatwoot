# Kita: customers (Grip accounts) derived from conversations, aggregated in SQL on
# conversations.custom_attributes (grip_account, account_owner, account_owner_email, channel; set by
# grip-sync and kita-bridges). A customer has one conversation per platform (Tala on Slack, Tala on WhatsApp),
# so rows group by grip_account_id (falling back to the grip_account name when only grip-sync has set it).
# A bridge conversation (custom_attributes.channel set) with neither is an unlinked channel: its own row
# (id "unlinked-<display id>", kind "unlinked", channel_key), named by its channel label. Any other conversation
# (a website, email or API inbox) is a row of its own too (id "conversation-<display id>", kind "conversation"),
# named by its contact. Both are listed after the customers.
# Row shape: {id, kind (customer|unlinked|conversation), name, stage, dri_name, dri_email, platforms[], open_count,
#   waiting_on_us, last_activity_at, grip_account_id, unread_count, open_tickets,
#   conversations[{id, platform, label, status, unread_count, last_activity_at, inbox_id, channel_type}] (most recent first),
#   last_message {content, sender_name, platform, message_type, created_at}|nil (latest public message),
#   urgent_ticket (an open urgent Grip ticket on one of its threads)};
# the source can later become Grip's full customer list without changing it.
class Kita::Customers
  UNLINKED_ID = 'unlinked'.freeze

  # Last public customer/Kita message of the conversation is from the customer (incoming).
  LAST_PUBLIC_MESSAGE_TYPE = <<~SQL.squish.freeze
    (SELECT m.message_type FROM messages m
     WHERE m.conversation_id = conversations.id AND m.private = false
       AND m.message_type IN (#{Message.message_types[:incoming]}, #{Message.message_types[:outgoing]}, #{Message.message_types[:template]})
     ORDER BY m.created_at DESC LIMIT 1)
  SQL

  def initialize(conversations)
    @conversations = conversations
  end

  CUSTOMER_KEY = "COALESCE(conversations.custom_attributes->>'grip_account_id', conversations.custom_attributes->>'grip_account')".freeze
  # The row id of a conversation, in SQL: its customer, else its own unlinked-/conversation- row.
  ROW_KEY = <<~SQL.squish.freeze
    COALESCE(NULLIF(conversations.custom_attributes->>'grip_account_id', ''), NULLIF(conversations.custom_attributes->>'grip_account', ''),
             CASE WHEN COALESCE(conversations.custom_attributes->>'channel', '') = '' THEN 'conversation-' ELSE 'unlinked-' END
             || conversations.display_id)
  SQL
  OPEN_TICKET = "kita_threads.ticket_id IS NOT NULL AND " \
                "(kita_threads.ticket_status IS NULL OR kita_threads.ticket_status NOT IN ('resolved', 'dismissed'))".freeze

  # Placeholder labels older bridges stored: a raw "platform:id" key is never shown.
  RAW_KEY = /\A(slack|teams|whatsapp|viber):/
  PLATFORM_FALLBACK = { 'slack' => 'Slack channel', 'teams' => 'Microsoft Teams chat', 'whatsapp' => 'WhatsApp chat',
                        'viber' => 'Viber chat' }.freeze

  def rows
    grouped = @conversations.reorder(nil).group(Arel.sql(CUSTOMER_KEY))
    rows = grouped.pluck(*columns).map { |values| row(values) }.reject { |r| r[:id] == UNLINKED_ID }
    attach_details(rows)
    linked = rows.sort_by { |r| -r[:last_activity_at].to_i }
    linked + @by_key.fetch(UNLINKED_ID, []).sort_by { |c| -c.last_activity_at.to_i }.map { |c| unlinked_row(c) }
  end

  # "#kita-tala", "Acme › Support", "Jun, Maria & 2 others"; never a raw key.
  def self.display_label(label, platform)
    return label if label.present? && !label.match?(RAW_KEY)

    PLATFORM_FALLBACK.fetch(platform.to_s, 'Unnamed channel')
  end

  private

  def customer_key(conversation)
    attrs = conversation.custom_attributes || {}
    (attrs['grip_account_id'].presence || attrs['grip_account'].presence || UNLINKED_ID).to_s
  end

  # The row id of a conversation (ROW_KEY in Ruby)
  def self.row_id(conversation)
    attrs = conversation.custom_attributes || {}
    key = attrs['grip_account_id'].presence || attrs['grip_account'].presence
    return key.to_s if key

    "#{attrs['channel'].present? ? 'unlinked' : 'conversation'}-#{conversation.display_id}"
  end

  # Per-customer conversations (the header tabs), latest public message and urgent tickets, in three queries.
  def attach_details(rows)
    conversations = @conversations.reorder(nil).includes(:contact, :inbox).to_a
    ids = conversations.map(&:id)
    @latest = latest_messages(ids)
    @unread = unread_counts(ids)
    @urgent = urgent_conversation_ids(ids)
    @tickets = open_ticket_counts(ids)
    @by_key = conversations.group_by { |conversation| customer_key(conversation) }
    rows.each { |row| row.merge!(details((@by_key[row[:id]] || []).sort_by { |c| -c.last_activity_at.to_i })) }
  end

  def unlinked_row(conversation)
    attrs = conversation.custom_attributes || {}
    bridge = attrs['channel'].present?
    {
      id: self.class.row_id(conversation), kind: bridge ? 'unlinked' : 'conversation', unlinked: bridge, channel_key: attrs['channel_key'],
      name: bridge ? channel_label(conversation) : conversation.contact&.name.presence || conversation.inbox&.name, stage: nil,
      dri_name: nil, dri_email: nil, platforms: [attrs['channel']].compact, open_count: conversation.open? ? 1 : 0,
      waiting_on_us: conversation.open? && @latest[conversation.id]&.incoming? == true,
      last_activity_at: conversation.last_activity_at&.to_i
    }.merge(details([conversation]))
  end

  def details(list)
    {
      grip_account_id: list.first&.custom_attributes&.dig('grip_account_id'),
      conversations: list.map { |c| conversation_row(c, @unread[c.id]) },
      last_message: latest_message_row(list),
      urgent_ticket: list.any? { |c| @urgent.include?(c.id) },
      unread_count: list.sum { |c| @unread[c.id].to_i },
      open_tickets: list.sum { |c| @tickets[c.id].to_i }
    }
  end

  def latest_message_row(list)
    message = list.filter_map { |c| @latest[c.id] }.max_by(&:created_at)
    message && message_row(message)
  end

  def conversation_row(conversation, unread_count)
    attrs = conversation.custom_attributes || {}
    {
      id: conversation.display_id, platform: attrs['channel'], label: channel_label(conversation), status: conversation.status,
      unread_count: unread_count.to_i, last_activity_at: conversation.last_activity_at&.to_i,
      inbox_id: conversation.inbox_id, channel_type: conversation.inbox&.channel_type
    }
  end

  def channel_label(conversation)
    attrs = conversation.custom_attributes || {}
    candidates = [attrs['channel_label'], first_channel_label(attrs['kita_channels']), conversation.contact&.name]
    self.class.display_label(candidates.find { |label| label.present? && !label.match?(RAW_KEY) }, attrs['channel'])
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

  def public_messages(ids)
    types = [Message.message_types[:incoming], Message.message_types[:outgoing], Message.message_types[:template]]
    Message.where(conversation_id: ids, private: false, message_type: types)
  end

  def latest_messages(ids)
    public_messages(ids).select('DISTINCT ON (messages.conversation_id) messages.*')
                        .reorder(Arel.sql('messages.conversation_id, messages.created_at DESC'))
                        .includes(:sender, :conversation).index_by(&:conversation_id)
  end

  # Incoming messages the agents haven't seen (Chatwoot's conversation-level agent_last_seen_at).
  def unread_counts(ids)
    Message.reorder(nil).joins(:conversation).where(conversation_id: ids, message_type: :incoming)
           .where('conversations.agent_last_seen_at IS NULL OR messages.created_at > conversations.agent_last_seen_at')
           .group(:conversation_id).count
  end

  # Conversations with an open urgent ticket on one of their threads
  def urgent_conversation_ids(ids)
    ::Kita::MessageThread.where(conversation_id: ids, ticket_priority: 'urgent').where.not(ticket_id: nil)
                         .where('ticket_status IS NULL OR ticket_status NOT IN (?)', %w[resolved dismissed])
                         .distinct.pluck(:conversation_id).to_set
  end

  def open_ticket_counts(ids)
    ::Kita::MessageThread.where(conversation_id: ids).where(OPEN_TICKET).group(:conversation_id).count
  end

  def columns
    open = Conversation.statuses[:open]
    [
      CUSTOMER_KEY,
      "MAX(conversations.custom_attributes->>'grip_account')",
      "MAX(conversations.custom_attributes->>'grip_stage')",
      "MAX(conversations.custom_attributes->>'account_owner')",
      "MAX(conversations.custom_attributes->>'account_owner_email')",
      "ARRAY_REMOVE(ARRAY_AGG(DISTINCT conversations.custom_attributes->>'channel'), NULL)",
      "COUNT(*) FILTER (WHERE conversations.status = #{open})",
      "COALESCE(BOOL_OR(conversations.status = #{open} AND #{LAST_PUBLIC_MESSAGE_TYPE} = #{Message.message_types[:incoming]}), false)",
      'MAX(conversations.last_activity_at)'
    ].map { |sql| Arel.sql(sql) }
  end

  def row(values)
    key, name, stage, dri_name, dri_email, platforms, open_count, waiting_on_us, last_activity_at = values
    {
      id: key.presence || UNLINKED_ID, kind: 'customer', name: name.presence, stage: stage.presence, dri_name: dri_name, dri_email: dri_email,
      platforms: platforms.sort, open_count: open_count, waiting_on_us: waiting_on_us, last_activity_at: last_activity_at&.to_i
    }
  end
end
