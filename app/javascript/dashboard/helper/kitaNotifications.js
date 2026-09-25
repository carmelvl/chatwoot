/**
 * Kita: the sidebar bell over Chatwoot's notifications (camelCased records of
 * the notifications store).
 */

const KINDS = {
  conversation_mention: 'mention',
  conversation_assignment: 'assignment',
  assigned_conversation_new_message: 'message',
  participating_conversation_new_message: 'message',
  conversation_creation: 'new_conversation',
};

export const notificationKind = type => KINDS[type] || 'other';

/**
 * Bell items, newest first, each with its kind; optionally mentions only.
 * @param {Array} notifications - notifications/getFilteredNotificationsV4
 * @param {{ mentionsOnly: boolean }} options
 */
export const bellItems = (notifications, { mentionsOnly = false } = {}) =>
  notifications
    .map(notification => ({
      ...notification,
      kind: notificationKind(notification.notificationType),
    }))
    .filter(notification => !mentionsOnly || notification.kind === 'mention');

/**
 * Where a notification opens: its conversation URL, which redirects into the
 * unified view (customer, platform tab), scrolled to the mentioning message.
 */
export const notificationRoute = (notification, accountId) => {
  const messageId = notification.secondaryActor?.id;
  const isMessage =
    notification.kind === 'mention' || notification.kind === 'message';
  return {
    name: 'inbox_conversation',
    params: {
      accountId,
      conversation_id: String(notification.primaryActor.id),
    },
    query: isMessage && messageId ? { messageId: String(messageId) } : {},
  };
};
