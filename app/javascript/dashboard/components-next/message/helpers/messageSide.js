import {
  MESSAGE_STATUS,
  MESSAGE_TYPES,
  ORIENTATION,
  SENDER_TYPES,
} from '../constants';

const senderTypeOf = ({ sender, senderType }) =>
  (sender?.type ?? senderType ?? '').toLowerCase();

const senderIdOf = ({ sender, senderId }) => senderId ?? sender?.id;

const isOwnMessage = message =>
  senderTypeOf(message) === SENDER_TYPES.USER.toLowerCase() &&
  senderIdOf(message) === message.currentUserId;

/**
 * Chat-app alignment: only the current user's own messages sit on the right.
 * Customers, other teammates, bots and sender-less messages sit on the left.
 */
export const getMessageOrientation = message => {
  if (message.messageType === MESSAGE_TYPES.ACTIVITY) return ORIENTATION.CENTER;
  // an outgoing message still processing was sent by the current user
  if (
    message.status === MESSAGE_STATUS.PROGRESS &&
    message.messageType === MESSAGE_TYPES.OUTGOING
  ) {
    return ORIENTATION.RIGHT;
  }
  return isOwnMessage(message) ? ORIENTATION.RIGHT : ORIENTATION.LEFT;
};

/**
 * A Kita teammate is any desk user other than the current user, or a Kita
 * staff contact (no desk account) flagged with custom_attributes.kita_staff.
 */
export const isKitaTeammate = message => {
  const type = senderTypeOf(message);
  if (type === SENDER_TYPES.USER.toLowerCase()) return !isOwnMessage(message);
  if (type !== SENDER_TYPES.CONTACT.toLowerCase()) return false;

  const { sender } = message;
  const attributes = sender?.customAttributes ?? sender?.custom_attributes;
  return (attributes?.kitaStaff ?? attributes?.kita_staff) === true;
};
