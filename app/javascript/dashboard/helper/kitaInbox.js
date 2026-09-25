/**
 * Kita Inbox: the desk's one work list (GET /kita/inbox), one row per
 * customer, unlinked channel or other conversation. The filters live in the
 * URL query (so views are shareable and old links can land on them); these
 * pure helpers map between the query, the API params and the rows.
 */

// The customer view's account-wide tickets tab
export const TICKETS_TAB = 'tickets';

export const INBOX_SCOPES = ['mine', 'unassigned', 'all'];
export const INBOX_STATUSES = ['open', 'snoozed', 'resolved', 'all', 'other'];
export const INBOX_SORTS = [
  'latest',
  'oldest',
  'created_desc',
  'created_asc',
  'priority',
];
export const INBOX_SECTIONS = [
  'needs_reply',
  'active',
  'unlinked',
  'snoozed',
  'resolved',
];
// Collapsed until opened
export const COLLAPSED_SECTIONS = ['unlinked', 'snoozed', 'resolved'];
export const TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'low'];

// URL query key => filter key; values are strings in the URL
const QUERY_KEYS = {
  scope: 'scope',
  status: 'status',
  platform: 'platform',
  label: 'label',
  team: 'teamId',
  inbox: 'inboxId',
  view: 'viewId',
  type: 'conversationType',
  dri: 'dri',
  stage: 'stage',
  tp: 'ticketPriority',
  ts: 'ticketStatus',
  sort: 'sort',
};

export const DEFAULT_INBOX_FILTERS = Object.freeze({
  scope: 'mine',
  status: 'open',
  platform: null,
  label: null,
  teamId: null,
  inboxId: null,
  viewId: null,
  conversationType: null,
  dri: null,
  stage: null,
  ticketPriority: null,
  ticketStatus: null,
  sort: null,
  // A Chatwoot advanced-filter payload (not kept in the URL)
  advanced: null,
});

/** Inbox filters from a route query (unknown keys ignored). */
export const filtersFromQuery = (query = {}) => {
  const filters = { ...DEFAULT_INBOX_FILTERS };
  Object.entries(QUERY_KEYS).forEach(([queryKey, key]) => {
    const value = query[queryKey];
    if (value !== undefined && value !== null && value !== '') {
      filters[key] = String(value);
    }
  });
  if (!INBOX_SCOPES.includes(filters.scope)) filters.scope = 'mine';
  if (!INBOX_STATUSES.includes(filters.status)) filters.status = 'open';
  return filters;
};

/** The route query of a set of filters; defaults are left out. */
export const queryFromFilters = filters =>
  Object.fromEntries(
    Object.entries(QUERY_KEYS)
      .map(([queryKey, key]) => [queryKey, filters[key]])
      .filter(
        ([queryKey, value]) =>
          value !== null &&
          value !== undefined &&
          value !== '' &&
          value !== DEFAULT_INBOX_FILTERS[QUERY_KEYS[queryKey]]
      )
  );

/** The list filters of a route query (drops the conversation/thread keys). */
export const listQuery = (query = {}) =>
  Object.fromEntries(
    Object.entries(query).filter(([key]) => key in QUERY_KEYS)
  );

/**
 * Params of GET /kita/inbox; empty filters are left out.
 * @param {Object} filters - DEFAULT_INBOX_FILTERS shape
 * @param {number} page - 1-based
 */
export const inboxParams = (filters, page = 1) => {
  const params = {
    scope: filters.scope,
    status: filters.status,
    platform: filters.platform,
    labels: filters.label ? [filters.label] : null,
    team_id: filters.teamId,
    inbox_id: filters.inboxId,
    view_id: filters.viewId,
    conversation_type: filters.conversationType,
    dri: filters.dri,
    stage: filters.stage,
    ticket_priority: filters.ticketPriority,
    ticket_status: filters.ticketStatus,
    sort: filters.sort,
    filters: filters.advanced?.length ? JSON.stringify(filters.advanced) : null,
    page,
  };
  return Object.fromEntries(
    Object.entries(params).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
};

/** Filters set beyond scope and status (drives the "Clear" link). */
export const activeFilterCount = filters =>
  [
    'platform',
    'label',
    'teamId',
    'inboxId',
    'viewId',
    'conversationType',
    'dri',
    'stage',
    'ticketPriority',
    'ticketStatus',
  ].filter(key => filters[key]).length + (filters.advanced?.length ? 1 : 0);

/**
 * Rows grouped into their sections, in section order; empty sections dropped.
 * @param {Array} rows - Inbox rows (already ordered by the server)
 */
export const sectionRows = rows =>
  INBOX_SECTIONS.map(key => ({
    key,
    rows: rows.filter(row => (row.section || 'active') === key),
  })).filter(section => section.rows.length);

/**
 * The tabs of a row's detail view: one per platform (its most recent
 * conversation there), one for a non-bridge conversation, then Tickets.
 * @param {Object} row - Inbox/customer row (conversations most recent first)
 * @returns {Array<{key: string, platform: string|null, conversation: Object}>}
 */
export const platformTabs = row => {
  const tabs = [];
  (row?.conversations || []).forEach(conversation => {
    const key = conversation.platform || 'conversation';
    if (!tabs.some(tab => tab.key === key)) {
      tabs.push({ key, platform: conversation.platform || null, conversation });
    }
  });
  return tabs;
};

/**
 * The tab a row opens on: where the customer is waiting (the oldest
 * unanswered message), else the most recent platform.
 */
export const defaultTab = row => {
  const tabs = platformTabs(row);
  return (
    tabs.find(tab => tab.key === row?.waiting_platform)?.key ??
    tabs[0]?.key ??
    null
  );
};

/**
 * The conversation a tab shows: the pinned one (?c=) when it belongs to the
 * row, else the tab's most recent conversation.
 */
export const tabConversation = (row, tab, pinnedId) => {
  const conversations = row?.conversations || [];
  const pinned = conversations.find(c => String(c.id) === String(pinnedId));
  if (pinned) return pinned;
  return platformTabs(row).find(item => item.key === tab)?.conversation;
};

/**
 * Route of a row in the Inbox (the detail view on a tab), keeping the list
 * filters in the query.
 */
export const rowRoute = (
  row,
  accountId,
  { tab, threadId, conversationId, query = {} } = {}
) => {
  const params = {
    accountId,
    customerId: String(row.id),
    tab: tab || defaultTab(row) || 'conversation',
  };
  const fullQuery = conversationId
    ? { ...listQuery(query), c: String(conversationId) }
    : listQuery(query);
  return threadId
    ? {
        name: 'kita_inbox_thread',
        params: { ...params, threadId: String(threadId) },
        query: fullQuery,
      }
    : { name: 'kita_inbox_customer', params, query: fullQuery };
};

/**
 * Wait shown on a row: "waiting 3h" from the oldest unanswered message, else
 * the last activity.
 * @param {Object} row
 * @param {number} now - unix seconds
 * @returns {{ waiting: boolean, seconds: number }|null}
 */
export const rowWait = (row, now) => {
  const since = row.waiting_since || row.last_activity_at;
  if (!since) return null;
  return { waiting: !!row.waiting_since, seconds: Math.max(0, now - since) };
};

/** "45s", "3m", "3h", "2d". */
export const shortDuration = seconds => {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

/** Platforms of a row that have a brand logo (slack, teams, whatsapp, viber). */
export const rowPlatforms = (row, platforms) =>
  (row.platforms || []).filter(platform => platforms.includes(platform));

/**
 * One logo per platform with its state: needs reply (unread dot), open (full
 * colour), snoozed (clock) or resolved (greyed). Worst state wins.
 */
export const platformStates = row => {
  const rank = { needs_reply: 0, open: 1, pending: 1, snoozed: 2, resolved: 3 };
  const states = {};
  (row.conversations || []).forEach(conversation => {
    if (!conversation.platform) return;
    const state = conversation.needs_reply
      ? 'needs_reply'
      : conversation.status;
    const current = states[conversation.platform];
    if (!current || rank[state] < rank[current.state]) {
      states[conversation.platform] = {
        state,
        unread: (current?.unread || 0) + (conversation.unread_count || 0),
      };
    } else {
      current.unread += conversation.unread_count || 0;
    }
  });
  return Object.entries(states).map(([platform, value]) => ({
    platform,
    ...value,
  }));
};
