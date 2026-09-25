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
  // a private note never joins a public reply's group (or vice versa)
  if (!!message.private !== !!previous.private) return false;
  if (senderKey(message) !== senderKey(previous)) return false;

  const side = getMessageOrientation({ ...message, currentUserId });
  const previousSide = getMessageOrientation({ ...previous, currentUserId });
  if (side !== previousSide) return false;

  const gap = message.createdAt - previous.createdAt;
  return gap >= 0 && gap <= GROUP_WINDOW_SECONDS;
};

/**
 * How a conversation's messages are laid out, from its Kita bridge platform:
 * Slack/Teams read as a flat channel (others flush on the left with avatar
 * and name; your own in a green bubble on the right),
 * WhatsApp/Viber mirrors as phone chat bubbles, everything else as chat.
 */
export const LAYOUT_STYLES = { CHAT: 'chat', FLAT: 'flat', MIRROR: 'mirror' };

export const layoutStyleFor = channel => {
  if (['slack', 'teams'].includes(channel)) return LAYOUT_STYLES.FLAT;
  if (['whatsapp', 'viber'].includes(channel)) return LAYOUT_STYLES.MIRROR;
  return LAYOUT_STYLES.CHAT;
};

/**
 * Layout of one message.
 * - chat: left messages keep a fixed avatar column (the avatar only on the
 *   first message of a group); every group opens with a header line
 *   carrying the time.
 * - flat: like chat (others on the left with an avatar, yours on the right).
 * - mirror: no avatars or header; the group closes with a footer line
 *   ("Jun · 11:40 AM").
 * Grouped follow-ups have no header, so in chat and flat they carry a
 * compact meta of their own: delivery status always, time on hover.
 * Email and activity keep their own layout.
 */
/**
 * Bubble of a Kita layout message (Slack/Teams flat, WhatsApp/Viber mirror):
 * yours are a signal-green bubble with white text on the right; Kita
 * teammates a light-green bubble on the left; external people a neutral grey
 * bubble on the left. null = Chatwoot's bubble (private notes, activity,
 * email and classic chat).
 */
export const kitaBubbleClass = ({ style, orientation, variant }) => {
  const own = [
    MESSAGE_VARIANTS.PRIVATE,
    MESSAGE_VARIANTS.ACTIVITY,
    MESSAGE_VARIANTS.EMAIL,
  ];
  if (own.includes(variant)) return null;
  if (![LAYOUT_STYLES.FLAT, LAYOUT_STYLES.MIRROR].includes(style)) return null;
  const isRight = orientation === ORIENTATION.RIGHT;
  if (isRight) {
    return 'kita-bubble-own right-bubble !text-[0.9375rem] !leading-[1.375rem] px-3.5 py-2.5 rounded-[1.125rem] ltr:rounded-br-md rtl:rounded-bl-md bg-n-brand text-white [&_.prose]:!text-white [&_a]:!text-white';
  }
  const tone =
    variant === MESSAGE_VARIANTS.TEAMMATE
      ? 'kita-bubble-teammate bg-woot-50 dark:bg-woot-800/60'
      : 'kita-bubble-external bg-n-slate-3';
  return `left-bubble !text-[0.9375rem] !leading-[1.375rem] px-3.5 py-2.5 rounded-[1.125rem] ltr:rounded-bl-md rtl:rounded-br-md text-n-slate-12 ${tone}`;
};

export const getMessageLayout = ({
  orientation,
  variant,
  groupWithPrevious,
  groupWithNext = false,
  style = LAYOUT_STYLES.CHAT,
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
      followUpMeta: false,
      showFooter: false,
    };
  }

  if (style === LAYOUT_STYLES.MIRROR) {
    return {
      avatarColumn: false,
      showAvatar: false,
      showHeader: false,
      timeInHeader: true,
      followUpMeta: false,
      showFooter: !groupWithNext,
    };
  }

  const isLeft = orientation === ORIENTATION.LEFT;
  return {
    avatarColumn: isLeft,
    showAvatar: isLeft && !groupWithPrevious,
    showHeader: !groupWithPrevious,
    timeInHeader: true,
    followUpMeta: !!groupWithPrevious,
    showFooter: false,
  };
};
