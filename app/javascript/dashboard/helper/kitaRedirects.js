/**
 * Kita: the classic Chatwoot conversation URLs (kept registered, so emails,
 * notifications and bookmarks keep working) redirect into the unified Inbox.
 * List URLs become Inbox filters; conversation URLs resolve to the customer
 * row the conversation belongs to, on its platform tab.
 */

// Classic list route name => Inbox query it stands for
const LIST_QUERIES = {
  home: () => ({}),
  kita_my_customers: () => ({}),
  inbox_dashboard: params => ({ scope: 'all', inbox: params.inbox_id }),
  label_conversations: params => ({ scope: 'all', label: params.label }),
  team_conversations: params => ({ scope: 'all', team: params.teamId }),
  folder_conversations: params => ({ scope: 'all', view: params.id }),
  conversation_mentions: () => ({
    scope: 'all',
    status: 'all',
    type: 'mention',
  }),
  conversation_participating: () => ({ scope: 'all', type: 'participating' }),
  conversation_unattended: () => ({ scope: 'all', type: 'unattended' }),
};

/** Route guard: a classic list URL opens the Inbox with that filter. */
export const redirectListToInbox = to => ({
  name: 'kita_inbox',
  params: { accountId: to.params.accountId },
  query: (LIST_QUERIES[to.name] || LIST_QUERIES.home)(to.params),
});

/**
 * The Inbox route of a conversation's row.
 * @param {Object} row - GET /kita/customers/lookup response
 * @param {number|string} conversationId - display id
 * @param {Object} to - the classic route
 */
export const conversationRowRoute = (row, conversationId, to) => {
  const conversation = (row.conversations || []).find(
    item => String(item.id) === String(conversationId)
  );
  const query = { c: String(conversationId) };
  if (to.query?.messageId) query.messageId = to.query.messageId;
  return {
    name: 'kita_inbox_customer',
    params: {
      accountId: to.params.accountId,
      customerId: String(row.id),
      tab: conversation?.platform || 'conversation',
    },
    query,
  };
};

/**
 * Route guard factory: a classic conversation URL opens the unified view.
 * @param {(conversationId: string) => Promise<Object>} lookup - resolves the row
 */
export const redirectConversationToInbox = lookup => async to => {
  const conversationId = to.params.conversation_id || to.params.conversationId;
  try {
    const row = await lookup(conversationId);
    return conversationRowRoute(row, conversationId, to);
  } catch {
    return {
      name: 'kita_inbox',
      params: { accountId: to.params.accountId },
    };
  }
};
