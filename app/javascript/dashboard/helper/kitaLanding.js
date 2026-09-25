/**
 * Kita: Customers is the primary view. Opening the app (after login, or the
 * dashboard URL directly) lands there; navigating to the dashboard from inside
 * the app (the Conversations entry) still opens the classic list.
 */
export const landOnCustomers = (to, from) =>
  from.matched.length
    ? true
    : { name: 'kita_customers', params: { accountId: to.params.accountId } };
