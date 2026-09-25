# Kita: the SQL behind customer rows (see Kita::Customers): the row key of a conversation, whether it needs a reply,
# whether it has a pressing ticket, and the section order of a row.
# A conversation needs a reply (NEEDS_REPLY) when it's open and its latest public message is the customer's, unless
# an agent marked it "Replied from phone" after that message (custom_attributes.kita_replied_at, unix seconds: a
# WhatsApp/Viber reply the bridge didn't mirror).
module Kita::CustomerSql
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
end
