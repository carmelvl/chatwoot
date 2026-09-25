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
# Whether a conversation needs a reply, and the section order, are in Kita::CustomerSql; the per-row details in
# Kita::CustomerDetails.
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
  include Kita::CustomerSql

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
    ::Kita::CustomerDetails.new(@conversations, rows).attach
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
    kind = %w[unlinked conversation].find { |prefix| key.start_with?("#{prefix}-") } || 'customer'
    {
      id: key, kind: kind, unlinked: kind == 'unlinked', name: name.presence || key, stage: stage.presence,
      dri_name: kind == 'customer' ? dri_name : nil, dri_email: kind == 'customer' ? dri_email : nil,
      platforms: platforms.sort, open_count: open_count, waiting_on_us: waiting_on_us, last_activity_at: last_activity_at&.to_i
    }
  end
end
