import {
  DEFAULT_TICKET_FILTERS,
  ticketLabel,
  ticketsQuery,
} from '../kitaTickets';

describe('kitaTickets helpers', () => {
  it('sends only the filters that are set', () => {
    expect(ticketsQuery(DEFAULT_TICKET_FILTERS)).toEqual({
      scope: 'all',
      status: 'open',
    });
    expect(
      ticketsQuery({
        ...DEFAULT_TICKET_FILTERS,
        scope: 'mine',
        priority: 'urgent',
        customerId: '7',
        platform: 'slack',
      })
    ).toEqual({
      scope: 'mine',
      status: 'open',
      priority: 'urgent',
      customer_id: '7',
      platform: 'slack',
    });
  });

  it('labels a ticket by its display id first', () => {
    expect(ticketLabel({ display_id: 'KT-142', ticket_id: 'abc' })).toBe(
      'KT-142'
    );
    expect(ticketLabel({ display_id: null, ticket_id: 'abc' })).toBe('abc');
  });
});
