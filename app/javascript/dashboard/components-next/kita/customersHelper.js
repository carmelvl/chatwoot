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
 * Customers directory sections: CUSTOMERS (Grip accounts, most recent first)
 * then UNLINKED channels. Empty sections are dropped.
 */
export const directorySections = customers =>
  [
    {
      key: 'CUSTOMERS',
      customers: customers.filter(customer => !customer.unlinked),
    },
    {
      key: 'UNLINKED',
      customers: customers.filter(customer => customer.unlinked),
    },
  ].filter(section => section.customers.length);

/**
 * The preview line of a row: "Maria: batch 14 …" (the platform shows as a
 * logo beside it). Own messages read "You".
 * @param {Object} customer - Row of the inbox/customers API
 * @param {{ you: string, currentUserName: string }} options
 */
export const customerPreview = (customer, { you, currentUserName }) => {
  const message = customer.last_message;
  if (!message) return '';
  const sender =
    message.sender_name && message.sender_name === currentUserName
      ? you
      : firstName(message.sender_name);
  return sender ? `${sender}: ${message.content}` : message.content;
};

/** Tab of one conversation of a customer: "Slack" + "#kita-tala". */
export const conversationTab = (conversation, platformName) => ({
  id: conversation.id,
  platform: conversation.platform,
  inboxId: conversation.inbox_id,
  channelType: conversation.channel_type,
  title: platformName(conversation.platform) || conversation.label || '',
  detail: platformName(conversation.platform) ? conversation.label : null,
  unreadCount: conversation.unread_count || 0,
});
