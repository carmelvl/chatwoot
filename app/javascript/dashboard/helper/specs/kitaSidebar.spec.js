import { MY_CUSTOMERS_LIMIT, myCustomerItems } from '../kitaSidebar';

describe('myCustomerItems', () => {
  it('lists only linked customers, never unlinked or test channels', () => {
    expect(
      myCustomerItems([
        { id: 42, kind: 'customer', name: 'Tala' },
        {
          id: 'unlinked-slack:#kita-testcustomer',
          kind: 'unlinked',
          unlinked: true,
          name: '#kita-testcustomer',
        },
        { id: 'conversation-9', kind: 'conversation', name: 'Jun Lim' },
        { id: 7, kind: 'customer', name: null },
      ])
    ).toEqual([{ id: '42', name: 'Tala' }]);
  });

  it('shows at most eight, and nothing when there are none', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: index,
      kind: 'customer',
      name: `Customer ${index}`,
    }));
    expect(myCustomerItems(rows)).toHaveLength(MY_CUSTOMERS_LIMIT);
    expect(myCustomerItems([])).toEqual([]);
    expect(myCustomerItems()).toEqual([]);
  });
});
