// The sidebar's MY CUSTOMERS list shows at most this many
export const MY_CUSTOMERS_LIMIT = 8;

/**
 * MY CUSTOMERS: linked customers (Grip accounts) I own, most recent first as
 * the API sends them. Unlinked channels and other conversations never appear.
 * @param {Array} rows - GET /kita/customers?mine=true
 * @returns {Array<{id: string, name: string}>}
 */
export const myCustomerItems = (rows = []) =>
  rows
    .filter(row => row.kind === 'customer' && !row.unlinked && row.name)
    .slice(0, MY_CUSTOMERS_LIMIT)
    .map(row => ({ id: String(row.id), name: row.name }));
