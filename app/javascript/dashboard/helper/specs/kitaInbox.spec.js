import {
  DEFAULT_INBOX_FILTERS,
  activeFilterCount,
  defaultTab,
  filtersFromQuery,
  inboxParams,
  listQuery,
  platformStates,
  platformTabs,
  queryFromFilters,
  rowPlatforms,
  rowRoute,
  rowWait,
  sectionRows,
  shortDuration,
  tabConversation,
} from '../kitaInbox';

const tala = {
  id: '7',
  waiting_platform: 'whatsapp',
  conversations: [
    { id: 11, platform: 'slack', status: 'open', unread_count: 0 },
    {
      id: 12,
      platform: 'whatsapp',
      status: 'open',
      needs_reply: true,
      unread_count: 2,
    },
    { id: 10, platform: 'slack', status: 'resolved', unread_count: 1 },
  ],
};

describe('kitaInbox helpers', () => {
  it('reads filters from the URL and writes back only what differs', () => {
    const filters = filtersFromQuery({
      scope: 'all',
      platform: 'slack',
      label: 'billing',
      type: 'mention',
      view: '3',
      c: '12',
    });
    expect(filters).toMatchObject({
      scope: 'all',
      status: 'open',
      platform: 'slack',
      label: 'billing',
      conversationType: 'mention',
      viewId: '3',
    });
    expect(queryFromFilters(filters)).toEqual({
      scope: 'all',
      platform: 'slack',
      label: 'billing',
      type: 'mention',
      view: '3',
    });
    expect(filtersFromQuery({ scope: 'bogus' }).scope).toBe('mine');
    expect(listQuery({ scope: 'all', c: '12', messageId: '4' })).toEqual({
      scope: 'all',
    });
  });

  it('sends only the set filters to the API', () => {
    expect(inboxParams(DEFAULT_INBOX_FILTERS)).toEqual({
      scope: 'mine',
      status: 'open',
      page: 1,
    });
    const advanced = [
      { attribute_key: 'priority', filter_operator: 'equal_to', values: [1] },
    ];
    expect(
      inboxParams(
        {
          ...DEFAULT_INBOX_FILTERS,
          label: 'billing',
          teamId: '2',
          ticketPriority: 'urgent',
          advanced,
        },
        2
      )
    ).toEqual({
      scope: 'mine',
      status: 'open',
      labels: ['billing'],
      team_id: '2',
      ticket_priority: 'urgent',
      filters: JSON.stringify(advanced),
      page: 2,
    });
  });

  it('counts the filters beyond scope and status', () => {
    expect(activeFilterCount(DEFAULT_INBOX_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...DEFAULT_INBOX_FILTERS,
        platform: 'slack',
        advanced: [{}],
      })
    ).toBe(2);
  });

  it('groups rows into sections in order', () => {
    const rows = [
      { id: 'a', section: 'active' },
      { id: 'b', section: 'needs_reply' },
      { id: 'c', section: 'unlinked' },
    ];
    expect(sectionRows(rows).map(s => [s.key, s.rows.map(r => r.id)])).toEqual([
      ['needs_reply', ['b']],
      ['active', ['a']],
      ['unlinked', ['c']],
    ]);
  });

  it('has one tab per platform and opens where the customer is waiting', () => {
    expect(
      platformTabs(tala).map(tab => [tab.key, tab.conversation.id])
    ).toEqual([
      ['slack', 11],
      ['whatsapp', 12],
    ]);
    expect(defaultTab(tala)).toBe('whatsapp');
    expect(defaultTab({ ...tala, waiting_platform: null })).toBe('slack');
    expect(defaultTab({ conversations: [{ id: 3, platform: null }] })).toBe(
      'conversation'
    );
    expect(tabConversation(tala, 'slack').id).toBe(11);
    expect(tabConversation(tala, 'slack', '10').id).toBe(10);
  });

  it('routes a row to its tab and thread, keeping the list filters', () => {
    expect(rowRoute(tala, 1, { query: { scope: 'all', c: '9' } })).toEqual({
      name: 'kita_inbox_customer',
      params: { accountId: 1, customerId: '7', tab: 'whatsapp' },
      query: { scope: 'all' },
    });
    expect(
      rowRoute(tala, 1, { tab: 'slack', threadId: 55, conversationId: 10 })
    ).toEqual({
      name: 'kita_inbox_thread',
      params: { accountId: 1, customerId: '7', tab: 'slack', threadId: '55' },
      query: { c: '10' },
    });
  });

  it('shows the wait since the oldest unanswered message', () => {
    expect(
      rowWait({ waiting_since: 100, last_activity_at: 500 }, 1000)
    ).toEqual({ waiting: true, seconds: 900 });
    expect(rowWait({ last_activity_at: 500 }, 1000)).toEqual({
      waiting: false,
      seconds: 500,
    });
    expect(rowWait({}, 1000)).toBeNull();
    expect([30, 180, 7200, 172800].map(shortDuration)).toEqual([
      '30s',
      '3m',
      '2h',
      '2d',
    ]);
  });

  it('gives each platform logo its worst state and unread total', () => {
    expect(platformStates(tala)).toEqual([
      { platform: 'slack', state: 'open', unread: 1 },
      { platform: 'whatsapp', state: 'needs_reply', unread: 2 },
    ]);
  });

  it('keeps only platforms with a brand logo', () => {
    expect(
      rowPlatforms({ platforms: ['slack', 'email'] }, ['slack', 'teams'])
    ).toEqual(['slack']);
  });
});
