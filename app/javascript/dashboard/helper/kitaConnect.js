export const KITA_CONNECT_URL = '/kita/connect';
export const KITA_PLATFORMS = ['slack', 'teams', 'whatsapp', 'viber'];
// Platforms where agents can only reply as themselves (their own connected account)
export const KITA_PERSONAL_PLATFORMS = ['slack', 'teams'];
// Mirrors: the desk never sends there; people reply in the apps themselves
export const KITA_MIRROR_PLATFORMS = ['whatsapp', 'viber'];

export const openKitaConnect = () =>
  window.open(KITA_CONNECT_URL, '_blank', 'noopener');

/**
 * The "Connect your accounts" prompt shows on every login while any configured
 * platform (Slack, Teams) is not connected. It can be closed but not skipped.
 * @param {Object|null} status - Response of GET /api/v1/kita/connections
 * @returns {boolean}
 */
export const shouldPromptKitaConnect = status =>
  !!status &&
  KITA_PERSONAL_PLATFORMS.some(
    platform => status[platform] === 'not_connected'
  );

/**
 * Public replies are blocked in WhatsApp/Viber conversations (mirrors) and, in
 * Slack/Teams, until the agent has connected that platform (the bridge never
 * posts from a shared identity).
 * @param {Object|null} status - Response of GET /api/v1/kita/connections
 * @param {string|null} channel - Conversation custom_attributes.channel
 * @returns {'mirror'|'not_connected'|'unavailable'|null} Why replies are blocked
 */
export const kitaReplyBlock = (status, channel) => {
  if (KITA_MIRROR_PLATFORMS.includes(channel)) return 'mirror';
  if (!status || !KITA_PERSONAL_PLATFORMS.includes(channel)) return null;
  const state = status[channel];
  if (state === 'not_connected' || state === 'unavailable') return state;
  return null;
};

const RAW_CHANNEL_KEY = /^(slack|teams|whatsapp|viber):/;
// Older bridge contacts were named "Tala · Slack"; the platform is an icon now
const PLATFORM_SUFFIX = / · (Slack|Microsoft Teams|WhatsApp|Viber)$/;

/**
 * How a Kita customer conversation is named in lists: the customer ("Tala"),
 * else the channel's label; never a raw "platform:id" key.
 * @param {Object} chat - Conversation (snake_case, from the store)
 * @param {string} contactName - Name of the conversation's contact
 * @returns {{platform: string|null, title: string|null}} title null = use the platform fallback
 */
export const kitaConversationTitle = (chat, contactName) => {
  const attrs = chat?.custom_attributes || {};
  const platform = KITA_PLATFORMS.includes(attrs.channel)
    ? attrs.channel
    : null;
  if (!platform) return { platform: null, title: contactName };
  const candidates = [
    attrs.grip_account,
    attrs.channel_label,
    (contactName || '').replace(PLATFORM_SUFFIX, ''),
  ];
  const title = candidates.find(c => c && !RAW_CHANNEL_KEY.test(c)) ?? null;
  return { platform, title };
};
