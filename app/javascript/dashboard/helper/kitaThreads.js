import { kitaReplyBlock, KITA_MIRROR_PLATFORMS } from './kitaConnect';

/**
 * Bridge ("Customers" inbox) conversations carry custom_attributes.kita_channels,
 * a JSON string of [{ key, platform, label, sendable }], most recently active first.
 * @param {Object|null} chat - Conversation from the store
 * @returns {Array<{key: string, platform: string, label: string, sendable: boolean}>}
 */
export const parseKitaChannels = chat => {
  const raw = chat?.custom_attributes?.kita_channels;
  if (!raw) return [];
  try {
    const channels = JSON.parse(raw);
    return Array.isArray(channels) ? channels : [];
  } catch {
    return [];
  }
};

export const isBridgeConversation = chat =>
  !!chat?.custom_attributes?.kita_channels;

export const sendableKitaChannels = channels =>
  channels.filter(channel => channel.sendable);

/** Key of the channel the composer replies in by default (first sendable). */
export const defaultKitaChannelKey = channels =>
  sendableKitaChannels(channels)[0]?.key ?? null;

/**
 * Thread replies live in the thread pane, not the main stream.
 * @param {Object} message - camelCased message
 * @param {boolean} isBridge - Whether the conversation is a bridge conversation
 */
export const isHiddenThreadReply = (message, isBridge) =>
  isBridge && !!message.contentAttributes?.inReplyTo;

/**
 * Why the composer can't send a public reply in a bridge conversation.
 * Gates on the selected channel's platform; with no sendable channel the
 * conversation is a mirror (WhatsApp/Viber).
 * @param {Object|null} status - Response of GET /api/v1/kita/connections
 * @param {Array} channels - Parsed kita_channels
 * @param {string|null} selectedKey - Channel picked in the composer
 * @returns {{platform: string|null, reason: string|null}}
 */
export const kitaComposerBlock = (status, channels, selectedKey) => {
  const sendable = sendableKitaChannels(channels);
  if (!sendable.length) {
    const mirror = channels.find(channel =>
      KITA_MIRROR_PLATFORMS.includes(channel.platform)
    );
    return mirror
      ? { platform: mirror.platform, reason: 'mirror' }
      : { platform: null, reason: null };
  }
  const selected =
    sendable.find(channel => channel.key === selectedKey) ?? sendable[0];
  return {
    platform: selected.platform,
    reason: kitaReplyBlock(status, selected.platform),
  };
};

/** First non-empty line of the root message, used when the AI has no title. */
export const firstLine = content =>
  (content || '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? '';

export const threadTitle = (thread, rootContent) =>
  thread?.title || firstLine(rootContent);

/**
 * Compact footer summary for a thread root.
 * @param {Object} thread - Entry of the threads API payload
 */
export const threadFooterSummary = thread => ({
  count: thread.reply_count,
  avatars: (thread.participants || []).slice(0, 3),
  lastReplyAt: thread.last_reply_at,
  unread: !!thread.unread,
  title: thread.title || null,
  ticket: thread.ticket || null,
});

/** Root + replies of a thread, oldest first (loaded camelCased messages). */
export const threadMessages = (messages, rootId) =>
  messages
    .filter(
      message =>
        message.id === rootId || message.contentAttributes?.inReplyTo === rootId
    )
    .sort((a, b) => a.createdAt - b.createdAt);

// Grip ticket statuses that are finished
const CLOSED_TICKET_STATUSES = ['resolved', 'dismissed'];

export const isOpenTicket = ticket =>
  !!ticket && !CLOSED_TICKET_STATUSES.includes(ticket.status);

/** Threads with a ticket (the Tickets tab), open ones first, API order kept. */
export const ticketThreads = threads => {
  const withTicket = threads.filter(thread => thread.ticket);
  return [
    ...withTicket.filter(thread => isOpenTicket(thread.ticket)),
    ...withTicket.filter(thread => !isOpenTicket(thread.ticket)),
  ];
};

export const openTicketCount = threads =>
  threads.filter(thread => isOpenTicket(thread.ticket)).length;

/** Urgent and high tickets are flagged red in the desk. */
export const isPressingTicket = ticket =>
  ['urgent', 'high'].includes(ticket?.priority);

// SLA shows red when this close to due (or past it)
export const SLA_WARNING_MINUTES = 2 * 60;

/** "1h 48m", "48m", "2d 3h" for a number of minutes. */
export const slaDuration = minutes => {
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
};

/**
 * Time left on a ticket's SLA.
 * @param {number|null} dueAt - SLA due time (unix seconds); null when Grip sent none
 * @param {number} [now=Date.now()] - Current time in ms
 * @returns {{duration: string, breached: boolean, pressing: boolean}|null}
 */
export const slaStatus = (dueAt, now = Date.now()) => {
  if (!dueAt) return null;
  const minutes = Math.floor((dueAt * 1000 - now) / 60000);
  const breached = minutes < 0;
  return {
    duration: breached ? '' : slaDuration(minutes),
    breached,
    pressing: breached || minutes <= SLA_WARNING_MINUTES,
  };
};
