import { landOnCustomers } from '../kitaLanding';

describe('landOnCustomers', () => {
  const to = { params: { accountId: '1' } };

  it('lands on Customers when the app opens on the dashboard', () => {
    expect(landOnCustomers(to, { matched: [] })).toEqual({
      name: 'kita_customers',
      params: { accountId: '1' },
    });
  });

  it('keeps the classic list when navigating from inside the app', () => {
    const from = { matched: [{ name: 'kita_customers' }] };
    expect(landOnCustomers(to, from)).toBe(true);
  });
});
