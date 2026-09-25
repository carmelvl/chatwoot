import { describe, it, expect } from 'vitest';
import { kitaReplyBlock, shouldPromptKitaConnect } from '../kitaConnect';

describe('shouldPromptKitaConnect', () => {
  it('does not prompt when the status call failed', () => {
    expect(shouldPromptKitaConnect(null)).toBe(false);
  });

  it('does not prompt when slack and teams are both unavailable', () => {
    expect(
      shouldPromptKitaConnect({ slack: 'unavailable', teams: 'unavailable' })
    ).toBe(false);
  });

  it('prompts (every login, not skippable) while a configured platform is not connected', () => {
    expect(
      shouldPromptKitaConnect({ slack: 'not_connected', teams: 'unavailable' })
    ).toBe(true);
    expect(
      shouldPromptKitaConnect({ slack: 'connected', teams: 'not_connected' })
    ).toBe(true);
  });

  it('stops prompting once every configured platform is connected', () => {
    expect(
      shouldPromptKitaConnect({ slack: 'connected', teams: 'unavailable' })
    ).toBe(false);
    expect(
      shouldPromptKitaConnect({ slack: 'connected', teams: 'connected' })
    ).toBe(false);
  });
});

describe('kitaReplyBlock (composer gate per platform)', () => {
  const status = {
    slack: 'not_connected',
    teams: 'connected',
    whatsapp: 'none',
    viber: 'not_applicable',
  };

  it('gates a Slack conversation until Slack is connected', () => {
    expect(kitaReplyBlock(status, 'slack')).toBe('not_connected');
    expect(kitaReplyBlock({ ...status, slack: 'connected' }, 'slack')).toBe(
      null
    );
  });

  it('gates Teams independently of Slack', () => {
    expect(kitaReplyBlock(status, 'teams')).toBe(null);
    expect(kitaReplyBlock({ ...status, teams: 'not_connected' }, 'teams')).toBe(
      'not_connected'
    );
  });

  it('gates a platform that is not configured yet', () => {
    expect(kitaReplyBlock({ ...status, teams: 'unavailable' }, 'teams')).toBe(
      'unavailable'
    );
  });

  it('never gates Viber, WhatsApp or non-bridge conversations', () => {
    expect(kitaReplyBlock(status, 'viber')).toBe(null);
    expect(kitaReplyBlock(status, 'whatsapp')).toBe(null);
    expect(kitaReplyBlock(status, undefined)).toBe(null);
  });

  it('does not gate when the status is unknown', () => {
    expect(kitaReplyBlock(null, 'slack')).toBe(null);
  });
});
