import {
  isSameDay,
  isToday,
  isYesterday,
  format,
  fromUnixTime,
} from 'date-fns';

/**
 * The day divider above a message (Paper S03: "TODAY" between hairlines), or
 * null when it's on the same day as the previous message.
 * @param {Object} message - { createdAt } in unix seconds
 * @param {Object|undefined} previous
 * @returns {{ key: 'today'|'yesterday'|'date', date: string }|null}
 */
export const dayDivider = (message, previous) => {
  if (!message?.createdAt) return null;
  const day = fromUnixTime(message.createdAt);
  if (previous?.createdAt && isSameDay(day, fromUnixTime(previous.createdAt)))
    return null;
  if (isToday(day)) return { key: 'today', date: '' };
  if (isYesterday(day)) return { key: 'yesterday', date: '' };
  return { key: 'date', date: format(day, 'EEEE, MMM d') };
};
