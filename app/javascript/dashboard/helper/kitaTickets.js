/** Kita Tickets page: filters of GET /kita/tickets. */
export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting_on_customer',
  'resolved',
  'dismissed',
  'all',
];
export const TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'low'];

export const TICKET_SCOPES = ['mine', 'unowned', 'all'];

export const DEFAULT_TICKET_FILTERS = Object.freeze({
  scope: 'all',
  status: 'open',
  priority: null,
  customerId: null,
  platform: null,
});

export const ticketsQuery = filters =>
  Object.fromEntries(
    Object.entries({
      scope: filters.scope,
      status: filters.status,
      priority: filters.priority,
      customer_id: filters.customerId,
      platform: filters.platform,
    }).filter(([, value]) => value !== null && value !== undefined)
  );

/** "KT-142", else the Grip ticket id. */
export const ticketLabel = ticket => ticket.display_id || ticket.ticket_id;
