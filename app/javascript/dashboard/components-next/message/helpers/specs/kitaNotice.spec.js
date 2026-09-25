import { canRetryFailed, failedSendReason, kitaNotice } from '../kitaNotice';
import { MESSAGE_STATUS } from '../../constants';

describe('kitaNotice', () => {
  it('reads a tagged bridge note', () => {
    expect(
      kitaNotice({
        private: true,
        contentAttributes: {
          kitaNotice: 'not_sent',
          kitaNoticeReason: 'not_member',
          externalSource: 'teams',
        },
      })
    ).toEqual({
      kind: 'not_sent',
      reason: 'not_member',
      platform: 'teams',
      connectUrl: undefined,
    });
  });

  it('recognises older untagged notes, and never public messages', () => {
    expect(
      kitaNotice({
        private: true,
        content: 'Not sent — connect your Slack account first.',
        conversationChannel: 'slack',
      })
    ).toMatchObject({ kind: 'not_sent', reason: 'not_connected' });
    expect(
      kitaNotice({
        private: true,
        content: 'Reply in Viber yourself — this inbox is a mirror. Nothing…',
      })
    ).toEqual({ kind: 'mirror', platform: 'viber' });
    expect(
      kitaNotice({ private: false, content: 'Not sent — connect your Slack' })
    ).toBeNull();
    expect(kitaNotice({ private: true, content: 'Heads up' })).toBeNull();
  });

  it('explains failed sends in plain English', () => {
    expect(failedSendReason('not_connected').reason).toBe('not_connected');
    expect(failedSendReason('channel_not_found').reason).toBe('not_member');
    expect(failedSendReason('rate limited')).toEqual({
      reason: 'other',
      text: 'rate limited',
    });
  });

  it('retries failed messages with something to send, within a day', () => {
    const failed = { status: MESSAGE_STATUS.FAILED, content: 'hi' };
    expect(canRetryFailed(failed, false)).toBe(true);
    expect(canRetryFailed(failed, true)).toBe(false);
    expect(
      canRetryFailed({ ...failed, status: MESSAGE_STATUS.SENT }, false)
    ).toBe(false);
  });
});
