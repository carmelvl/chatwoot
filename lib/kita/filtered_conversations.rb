# Kita: Chatwoot's conversation filter (advanced filters and saved views) as a relation, unpaginated and
# uncounted, so the Inbox can group its matches by customer.
class Kita::FilteredConversations < Conversations::FilterService
  def relation
    validate_query_operator
    query_builder(@filters['conversations'])
  end
end
