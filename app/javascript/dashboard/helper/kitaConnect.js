export const KITA_CONNECT_URL = '/kita/connect';
export const KITA_CONNECT_SKIP_KEY = 'kita_connect_prompt_skipped_at';
export const KITA_PLATFORMS = ['slack', 'teams', 'whatsapp', 'viber'];

const REPROMPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const LINKABLE_STATES = ['connected', 'not_connected'];

export const openKitaConnect = () =>
  window.open(KITA_CONNECT_URL, '_blank', 'noopener');

/**
 * Decides whether the one-time "Connect your accounts" prompt should show.
 * @param {Object|null} status - Response of GET /api/v1/kita/connections
 * @param {string|undefined} skippedAt - ISO timestamp from ui_settings
 * @param {number} now - Current time in ms
 * @returns {boolean}
 */
export const shouldPromptKitaConnect = (status, skippedAt, now = Date.now()) => {
  if (!status) return false;

  const linkable = [status.slack, status.teams].filter(state =>
    LINKABLE_STATES.includes(state)
  );
  if (!linkable.includes('not_connected')) return false;
  if (!skippedAt) return true;
  if (linkable.includes('connected')) return false;

  return now - new Date(skippedAt).getTime() >= REPROMPT_AFTER_MS;
};
