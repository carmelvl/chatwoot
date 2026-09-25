# Kita: customers (Grip accounts) derived from conversations, aggregated in SQL on
# conversations.custom_attributes (grip_account_id, grip_account, account_owner, account_owner_email, channel,
# channel_key, channel_label; set by grip-sync and kita-bridges). Every conversation belongs to exactly one row,
# keyed by ROW_KEY:
# - a customer: its grip_account_id. A conversation that only carries the grip_account name joins the row of the
#   conversations that have that name and an id, so a customer is listed once. Name-only customers key by name.
# - an unlinked channel (a bridge conversation, custom_attributes.channel set, with no Grip account):
#   "unlinked-<platform>:<channel label, else channel key, else display id>". Older data models left several desk
#   conversations for one channel (per thread, per channel, per platform); they share one row.
# - any other conversation (a website, email or API inbox): "conversation-<display id>", named by its contact.
# A conversation needs a reply (NEEDS_REPLY) when it's open and its latest public message is the customer's, unless
# an agent marked it "Replied from phone" after that message (custom_attributes.kita_replied_at, unix seconds: a
# WhatsApp/Viber reply the bridge didn't mirror).
# A row's section derives from its conversations (worst state wins): needs_reply, active (open), snoozed, resolved;
# unlinked channels are their own section. SECTION_RANK orders them in SQL.
# Customers are listed first, then unlinked channels, then other conversations, each most recent first.
# Row shape: {id, kind (customer|unlinked|conversation), section, name, stage, dri_name, dri_email, dri_id, platforms[],
#   open_count, waiting_on_us, waiting_since, waiting_platform, last_activity_at, grip_account_id, channel_key, unlinked,
#   not_customer, unread_count, open_tickets, tickets_by_priority {urgent, high, medium, low}, labels[], team_ids[],
#   assignee_ids[], snoozed_until,
#   conversations[{id, platform, label, status, needs_reply, unread_count, last_activity_at, inbox_id, channel_type}]
#     (most recent first),
#   last_message {content, sender_name, platform, message_type, created_at}|nil (latest public message),
#   urgent_ticket (an open urgent Grip ticket on one of its threads),
#   top_ticket {display_id, ticket_id, priority, title, url, conversation_id, root_message_id}|nil (the most pressing
#     open urgent/high ticket), pressing_tickets (how many there are)};
# the source can later become Grip's full customer list without changing it.
class Kita::Customers
  # Last public customer/Kita message of the conversation is from the customer (incoming).
  LAST_PUBLIC_MESSAGE_TYPE = <<~SQL.squish.freeze
    (SELECT m.message_type FROM messages m
     WHERE m.conversation_id = conversations.id AND m.private = false
       AND m.message_type IN (#{Message.message_types[:incoming]}, #{Message.message_types[:outgoing]}, #{Message.message_types[:template]})
     ORDER BY m.created_at DESC LIMIT 1)
  SQL

  CUSTOMER_KEY = <<~SQL.squish.freeze
    COALESCE(
      NULLIF(conversations.custom_attributes->>'grip_account_id', ''),
      (SELECT same.custom_attributes->>'grip_account_id' FROM conversations same
       WHERE same.account_id = conversations.account_id
         AND same.custom_attributes->>'grip_account' = conversations.custom_attributes->>'grip_account'
         AND NULLIF(same.custom_attributes->>'grip_account_id', '') IS NOT NULL
       ORDER BY same.last_activity_at DESC LIMIT 1),
      NULLIF(conversations.custom_attributes->>'grip_account', '')
    )
  SQL
  CHANNEL_KEY = <<~SQL.squish.freeze
    COALESCE(NULLIF(conversations.custom_attributes->>'channel_label', ''), NULLIF(conversations.custom_attributes->>'channel_key', ''),
             conversations.display_id::text)
  SQL
  ROW_KEY = <<~SQL.squish.freeze
    COALESCE(#{CUSTOMER_KEY},
             CASE WHEN COALESCE(conversations.custom_attributes->>'channel', '') = '' THEN 'conversation-' || conversations.display_id
             ELSE 'unlinked-' || (conversations.custom_attributes->>'channel') || ':' || #{CHANNEL_KEY} END)
  SQL
  OPEN_TICKET = 'kita_threads.ticket_id IS NOT NULL AND ' \
                "(kita_threads.ticket_status IS NULL OR kita_threads.ticket_status NOT IN ('resolved', 'dismissed'))".freeze
  PRESSING = %w[urgent high].freeze
  LAST_PUBLIC_AT = <<~SQL.squish.freeze
    (SELECT m.created_at FROM messages m
     WHERE m.conversation_id = conversations.id AND m.private = false
       AND m.message_type IN (#{Message.message_types[:incoming]}, #{Message.message_types[:outgoing]}, #{Message.message_types[:template]})
     ORDER BY m.created_at DESC LIMIT 1)
  SQL
  NEEDS_REPLY = <<~SQL.squish.freeze
    (conversations.status = #{Conversation.statuses[:open]}
     AND COALESCE(#{LAST_PUBLIC_MESSAGE_TYPE} = #{Message.message_types[:incoming]}, false)
     AND COALESCE(to_timestamp(NULLIF(conversations.custom_attributes->>'kita_replied_at', '')::double precision) < #{LAST_PUBLIC_AT}, true))
  SQL
  PRESSING_TICKET = <<~SQL.squish.freeze
    EXISTS (SELECT 1 FROM kita_threads WHERE kita_threads.conversation_id = conversations.id
            AND kita_threads.ticket_priority IN ('urgent', 'high') AND #{OPEN_TICKET})
  SQL
  # On keyed conversations
  SECTION_RANK = <<~SQL.squish.freeze
    CASE WHEN conversations.row_key LIKE 'unlinked-%' THEN 2 WHEN BOOL_OR(conversations.needs_reply) THEN 0
         WHEN BOOL_OR(conversations.status = #{Conversation.statuses[:open]}) THEN 1
         WHEN BOOL_OR(conversations.status = #{Conversation.statuses[:snoozed]}) THEN 3 ELSE 4 END
  SQL
  NOT_CUSTOMER = "COALESCE(conversations.custom_attributes->>'kita_not_customer', '') = 'true'".freeze
  KIND_ORDER = %w[customer unlinked conversation].freeze

  # Placeholder labels older bridges stored: a raw "platform:id" key is never shown.
  RAW_KEY = /\A(slack|teams|whatsapp|viber):/
  PLATFORM_FALLBACK = { 'slack' => 'Slack channel', 'teams' => 'Microsoft Teams chat', 'whatsapp' => 'WhatsApp chat',
                        'viber' => 'Viber chat' }.freeze

  def initialize(conversations)
    @conversations = conversations.reorder(nil)
  end

  # Customers, then unlinked channels, then other conversations; sort: :recent (most recent first) or :name
  def rows(sort: :recent)
    rows = self.class.keyed(@conversations).group('conversations.row_key').pluck(*columns).map { |values| row(values) }
    attach_details(rows)
    return rows.sort_by { |r| [KIND_ORDER.index(r[:kind]), r[:name].to_s.downcase] } if sort == :name

    rows.sort_by { |r| [KIND_ORDER.index(r[:kind]), -r[:last_activity_at].to_i] }
  end

  # The conversations with their row id (row_key), needs_reply and pressing (an open urgent/high ticket) as columns,
  # to group by (a GROUP BY on ROW_KEY itself would repeat its subquery).
  def self.keyed(conversations)
    select = "conversations.*, #{ROW_KEY} AS row_key, #{NEEDS_REPLY} AS needs_reply, #{PRESSING_TICKET} AS pressing"
    Conversation.from(conversations.reorder(nil).select(Arel.sql(select)), :conversations)
  end

  # row id => median first response (seconds) over the last 30 days, for the Customers directory
  def self.first_response_medians(conversations)
    keys = row_ids(conversations)
    events = ReportingEvent.where(name: 'first_response', conversation_id: keys.keys, created_at: 30.days.ago..)
    events.pluck(:conversation_id, :value).group_by { |id, _value| keys[id] }.transform_values do |pairs|
      values = pairs.map(&:last).sort
      middle = values.size / 2
      (values.size.odd? ? values[middle] : (values[middle - 1] + values[middle]) / 2.0).round
    end
  end

  # conversation id => row id
  def self.row_ids(conversations)
    conversations.reorder(nil).pluck(:id, Arel.sql(ROW_KEY)).to_h
  end

  # "#kita-tala", "Acme › Support", "Jun, Maria & 2 others"; never a raw key.
  def self.display_label(label, platform)
    return label if label.present? && !label.match?(RAW_KEY)

    PLATFORM_FALLBACK.fetch(platform.to_s, 'Unnamed channel')
  end

  private

  # Per-row conversations (the header tabs), latest public message, unread and tickets, in a few queries.
  def attach_details(rows)
    keys = self.class.row_ids(@conversations)
    conversations = @conversations.includes(:contact, :inbox).to_a
    ids = conversations.map(&:id)
    @latest = latest_messages(ids)
    @unread = unread_counts(ids)
    @urgent = urgent_conversation_ids(ids)
    @tickets = open_tickets(ids)
    @needs_reply = @conversations.where(NEEDS_REPLY).pluck(:id).to_set
    @users = dri_users(rows)
    by_key = conversations.group_by { |conversation| keys[conversation.id] }
    rows.each { |row| row.merge!(details(row, (by_key[row[:id]] || []).sort_by { |c| -c.last_activity_at.to_i })) }
  end

  def details(row, list)
    latest = list.first
    attrs = latest&.custom_attributes || {}
    tickets = list.flat_map { |c| @tickets.fetch(c.id, []) }
    waiting = list.select { |c| @needs_reply.include?(c.id) }.min_by { |c| (c.waiting_since || c.last_activity_at).to_i }
    {
      name: row_name(row, latest), section: section(row, list), channel_key: row[:kind] == 'unlinked' ? attrs['channel_key'] : nil,
      grip_account_id: list.filter_map { |c| c.custom_attributes&.dig('grip_account_id').presence }.first,
      dri_id: @users[::Kita::Bridge.normalize_email(row[:dri_email].to_s)]&.id,
      not_customer: list.all? { |c| c.custom_attributes&.dig('kita_not_customer') == 'true' },
      conversations: list.map { |c| conversation_row(c, @unread[c.id]) },
      waiting_since: waiting && (waiting.waiting_since || waiting.last_activity_at)&.to_i,
      waiting_platform: waiting&.custom_attributes&.dig('channel'),
      last_message: latest_message_row(waiting ? [waiting] : list) || latest_message_row(list),
      urgent_ticket: list.any? { |c| @urgent.include?(c.id) },
      unread_count: list.sum { |c| @unread[c.id].to_i },
      open_tickets: tickets.size, tickets_by_priority: ticket_counts(tickets), **pressing(tickets),
      labels: list.flat_map(&:cached_label_list_array).uniq.sort, team_ids: list.filter_map(&:team_id).uniq,
      assignee_ids: list.filter_map(&:assignee_id).uniq,
      snoozed_until: list.filter_map { |c| c.snoozed_until if c.snoozed? }.min&.to_i
    }
  end

  def section(row, list)
    return 'unlinked' if row[:kind] == 'unlinked'
    return 'needs_reply' if list.any? { |c| @needs_reply.include?(c.id) }
    return 'active' if list.any?(&:open?)

    list.any?(&:snoozed?) ? 'snoozed' : 'resolved'
  end

  def ticket_counts(tickets)
    %w[urgent high medium low].index_with { |priority| tickets.count { |t| t.ticket_priority == priority } }
  end

  def pressing(tickets)
    list = tickets.select { |t| PRESSING.include?(t.ticket_priority) }.sort_by { |t| [PRESSING.index(t.ticket_priority), -t.updated_at.to_i] }
    top = list.first
    ticket = top && { display_id: top.ticket_display_id, ticket_id: top.ticket_id, priority: top.ticket_priority, title: top.title,
                      url: top.ticket_url, conversation_id: top.conversation.display_id, root_message_id: top.root_message_id }
    { top_ticket: ticket, pressing_tickets: list.size }
  end

  # normalized email => User, for the DRIs of the rows
  def dri_users(rows)
    emails = rows.filter_map { |row| row[:dri_email].presence&.then { |email| ::Kita::Bridge.normalize_email(email) } }.uniq
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

  def conversation_row(conversation, unread_count)
    attrs = conversation.custom_attributes || {}
    {
      id: conversation.display_id, platform: attrs['channel'], label: channel_label(conversation), status: conversation.status,
      needs_reply: @needs_reply.include?(conversation.id), unread_count: unread_count.to_i, last_activity_at: conversation.last_activity_at&.to_i,
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
    ::Kita::MessageThread.where(conversation_id: ids, ticket_priority: 'urgent').where(OPEN_TICKET).distinct.pluck(:conversation_id).to_set
  end

  # conversation id => open tickets
  def open_tickets(ids)
    ::Kita::MessageThread.where(conversation_id: ids).where(OPEN_TICKET).includes(:conversation).group_by(&:conversation_id)
  end

  def columns
    open = Conversation.statuses[:open]
    [
      'conversations.row_key',
      "MAX(conversations.custom_attributes->>'grip_account')",
      "MAX(conversations.custom_attributes->>'grip_stage')",
      "MAX(conversations.custom_attributes->>'account_owner')",
      "MAX(conversations.custom_attributes->>'account_owner_email')",
      "ARRAY_REMOVE(ARRAY_AGG(DISTINCT conversations.custom_attributes->>'channel'), NULL)",
      "COUNT(*) FILTER (WHERE conversations.status = #{open})",
      'COALESCE(BOOL_OR(conversations.needs_reply), false)',
      'MAX(conversations.last_activity_at)'
    ].map { |sql| Arel.sql(sql) }
  end

  def row(values)
    key, name, stage, dri_name, dri_email, platforms, open_count, waiting_on_us, last_activity_at = values
    kind = if key.start_with?('unlinked-') then 'unlinked'
           elsif key.start_with?('conversation-') then 'conversation'
           else 'customer'
           end
    {
      id: key, kind: kind, unlinked: kind == 'unlinked', name: name.presence || key, stage: stage.presence,
      dri_name: kind == 'customer' ? dri_name : nil, dri_email: kind == 'customer' ? dri_email : nil,
      platforms: platforms.sort, open_count: open_count, waiting_on_us: waiting_on_us, last_activity_at: last_activity_at&.to_i
    }
  end
end
