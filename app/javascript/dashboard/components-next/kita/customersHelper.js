export const UNLINKED_CUSTOMER_ID = 'unlinked';

export const isUnlinkedCustomer = customer =>
  customer.id === UNLINKED_CUSTOMER_ID;

export const customerLabel = (customer, unlinkedLabel) =>
  isUnlinkedCustomer(customer) ? unlinkedLabel : customer.name;

export const driLabel = customer =>
  customer.dri_name || customer.dri_email || '—';

// Grip (internal.kita.ai) is where accounts and tickets live
export const GRIP_URL = 'https://internal.kita.ai';

export const gripAccountUrl = customer =>
  customer?.grip_account_id
    ? `${GRIP_URL}/crm/accounts/${customer.grip_account_id}`
    : null;

export const firstName = name => (name || '').trim().split(/\s+/)[0] || '';

/**
 * Customers list sections: NEEDS REPLY (the latest public message is the
 * customer's, on an open conversation), then ACTIVE (the rest). Empty
 * sections are dropped; rows keep the API's most-recent-first order.
 */
export const sectionCustomers = customers =>
  [
    {
      key: 'NEEDS_REPLY',
      customers: customers.filter(customer => customer.waiting_on_us),
    },
    {
      key: 'ACTIVE',
      customers: customers.filter(customer => !customer.waiting_on_us),
    },
  ].filter(section => section.customers.length);

/**
 * The preview line of a customer row: "Slack · Maria: batch 14 …". Own
 * messages read "You".
 * @param {Object} customer - Row of the customers API
 * @param {{ platformName: Function, you: string, currentUserName: string }} options
 */
export const customerPreview = (
  customer,
  { platformName, you, currentUserName }
) => {
  const message = customer.last_message;
  if (!message) return '';
  const sender =
    message.sender_name && message.sender_name === currentUserName
      ? you
      : firstName(message.sender_name);
  const text = sender ? `${sender}: ${message.content}` : message.content;
  const platform = platformName(message.platform);
  return platform ? `${platform} · ${text}` : text;
};

/** Tab of one per-platform conversation: "Slack" + "#kita-tala". */
export const conversationTab = (conversation, platformName) => ({
  id: conversation.id,
  platform: conversation.platform,
  title: platformName(conversation.platform) || conversation.label || '',
  detail: platformName(conversation.platform) ? conversation.label : null,
  unreadCount: conversation.unread_count || 0,
});
