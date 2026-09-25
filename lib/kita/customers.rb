# Kita: customers (Grip accounts) derived from conversations, aggregated in SQL on
# conversations.custom_attributes (grip_account, account_owner, account_owner_email, channel; set by
# grip-sync and kita-bridges). A customer has one conversation per platform ("Tala · Slack", "Tala · WhatsApp"),
# so rows group by grip_account_id (falling back to the grip_account name when only grip-sync has set it).
# Conversations with neither are grouped as "Unlinked".
# Row shape: {id, name, dri_name, dri_email, platforms[], open_count, waiting_on_us, last_activity_at};
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

  def rows
    grouped = @conversations.reorder(nil).group(Arel.sql(CUSTOMER_KEY))
    rows = grouped.pluck(*columns).map { |values| row(values) }
    rows.sort_by { |r| [r[:id] == UNLINKED_ID ? 1 : 0, -r[:last_activity_at].to_i] }
  end

  private

  def columns
    open = Conversation.statuses[:open]
    [
      CUSTOMER_KEY,
      "MAX(conversations.custom_attributes->>'grip_account')",
      "MAX(conversations.custom_attributes->>'account_owner')",
      "MAX(conversations.custom_attributes->>'account_owner_email')",
      "ARRAY_REMOVE(ARRAY_AGG(DISTINCT conversations.custom_attributes->>'channel'), NULL)",
      "COUNT(*) FILTER (WHERE conversations.status = #{open})",
      "COALESCE(BOOL_OR(conversations.status = #{open} AND #{LAST_PUBLIC_MESSAGE_TYPE} = #{Message.message_types[:incoming]}), false)",
      'MAX(conversations.last_activity_at)'
    ].map { |sql| Arel.sql(sql) }
  end

  def row(values)
    key, name, dri_name, dri_email, platforms, open_count, waiting_on_us, last_activity_at = values
    {
      id: key.presence || UNLINKED_ID, name: name.presence, dri_name: dri_name, dri_email: dri_email,
      platforms: platforms.sort, open_count: open_count, waiting_on_us: waiting_on_us, last_activity_at: last_activity_at&.to_i
    }
  end
end
