import {
  MESSAGE_STATUS,
  MESSAGE_TYPES,
  MESSAGE_VARIANTS,
  ORIENTATION,
} from '../constants';
import { getMessageOrientation } from './messageSide';

// Consecutive messages from one sender within this window share one header
export const GROUP_WINDOW_SECONDS = 5 * 60;

const senderKey = message => {
  const type = message.senderType ?? message.sender?.type ?? '';
  return [
    type.toLowerCase(),
    message.senderId ?? message.sender?.id ?? null,
    // sender-less bridge messages (e.g. Slack) carry the name here
    message.additionalAttributes?.senderName ?? null,
  ].join('|');
};

/**
 * Whether a message continues the previous one's group: same sender, same
 * side, and sent within GROUP_WINDOW_SECONDS of it.
 */
export const groupsWithPrevious = (message, previous, currentUserId) => {
  if (!message || !previous) return false;
  if (message.status === MESSAGE_STATUS.FAILED) return false;

  const types = [message.messageType, previous.messageType];
  if (types.includes(MESSAGE_TYPES.ACTIVITY)) return false;
  if (types.every(type => type === MESSAGE_TYPES.TEMPLATE)) return false;
  if (message.messageType !== previous.messageType) return false;
  if (senderKey(message) !== senderKey(previous)) return false;

  const side = getMessageOrientation({ ...message, currentUserId });
  const previousSide = getMessageOrientation({ ...previous, currentUserId });
  if (side !== previousSide) return false;

  const gap = message.createdAt - previous.createdAt;
  return gap >= 0 && gap <= GROUP_WINDOW_SECONDS;
};

/**
 * Chat layout of one message. Left messages keep a fixed avatar column (the
 * avatar itself only on the first message of a group); every group opens
 * with a header line carrying the time. Email and activity keep their own
 * layout.
 */
export const getMessageLayout = ({
  orientation,
  variant,
  groupWithPrevious,
}) => {
  if (
    orientation === ORIENTATION.CENTER ||
    variant === MESSAGE_VARIANTS.EMAIL
  ) {
    return {
      avatarColumn: false,
      showAvatar: false,
      showHeader: false,
      timeInHeader: false,
    };
  }

  const isLeft = orientation === ORIENTATION.LEFT;
  return {
    avatarColumn: isLeft,
    showAvatar: isLeft && !groupWithPrevious,
    showHeader: !groupWithPrevious,
    timeInHeader: true,
  };
};
