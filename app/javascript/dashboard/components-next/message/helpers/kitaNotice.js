import { MESSAGE_STATUS } from '../constants';

// Bridge notes from before notices were tagged (content_attributes.kita_notice)
const LEGACY_NOT_SENT = /^Not sent — (connect your|you're not in this)/;
const LEGACY_MIRROR =
  /^Reply in (WhatsApp|Viber) yourself — this inbox is a mirror/;
const PLATFORM_BY_NAME = { WhatsApp: 'whatsapp', Viber: 'viber' };

/**
 * A Kita bridge notice rendered as a full-width strip instead of a bubble:
 * a reply that was not sent (not_sent: not_connected | not_member) or the
 * mirror reminder. Reads the tagged note, else recognises older notes.
 * @param {Object} message - camelCased message props
 * @returns {{kind: 'not_sent'|'mirror', reason?: string, platform?: string, connectUrl?: string}|null}
 */
export const kitaNotice = message => {
  if (!message.private) return null;
  const attrs = message.contentAttributes || {};
  if (attrs.kitaNotice) {
    return {
      kind: attrs.kitaNotice,
      reason: attrs.kitaNoticeReason,
      platform: attrs.externalSource,
      connectUrl: attrs.kitaConnectUrl,
    };
  }
  const content = message.content || '';
  if (LEGACY_NOT_SENT.test(content)) {
    return {
      kind: 'not_sent',
      reason: content.includes('connect your') ? 'not_connected' : 'not_member',
      platform: message.conversationChannel,
    };
  }
  const mirror = content.match(LEGACY_MIRROR);
  if (mirror) return { kind: 'mirror', platform: PLATFORM_BY_NAME[mirror[1]] };
  return null;
};

/**
 * Plain-English reason of a failed send (content_attributes.external_error),
 * and whether connecting the platform account fixes it.
 */
export const failedSendReason = error => {
  const text = String(error || '');
  if (/not[_ ]connected|not_authed|invalid_auth|token/i.test(text)) {
    return { reason: 'not_connected', text: null };
  }
  if (/not[_ ]in[_ ]channel|not_member|channel_not_found/i.test(text)) {
    return { reason: 'not_member', text: null };
  }
  return { reason: 'other', text };
};

/** A failed message can be retried for a day, if it has something to send. */
export const canRetryFailed = (
  { status, content, attachments },
  oneDayPassed
) =>
  status === MESSAGE_STATUS.FAILED &&
  !oneDayPassed &&
  (content !== null || !!attachments?.length);
