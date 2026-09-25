import { describe, it, expect } from 'vitest';
import { shouldPromptKitaConnect } from '../kitaConnect';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-24T00:00:00Z').getTime();
const daysAgo = days => new Date(now - days * DAY).toISOString();

describe('shouldPromptKitaConnect', () => {
  it('does not prompt when the status call failed', () => {
    expect(shouldPromptKitaConnect(null, undefined, now)).toBe(false);
  });

  it('does not prompt when slack and teams are both unavailable', () => {
    const status = { slack: 'unavailable', teams: 'unavailable' };
    expect(shouldPromptKitaConnect(status, undefined, now)).toBe(false);
  });

  it('prompts when an available platform is not connected', () => {
    const status = { slack: 'not_connected', teams: 'unavailable' };
    expect(shouldPromptKitaConnect(status, undefined, now)).toBe(true);
  });

  it('does not prompt when every available platform is connected', () => {
    const status = { slack: 'connected', teams: 'unavailable' };
    expect(shouldPromptKitaConnect(status, undefined, now)).toBe(false);
  });

  it('prompts when one of two available platforms is still missing', () => {
    const status = { slack: 'connected', teams: 'not_connected' };
    expect(shouldPromptKitaConnect(status, undefined, now)).toBe(true);
  });

  it('stays quiet within 7 days of skipping', () => {
    const status = { slack: 'not_connected', teams: 'not_connected' };
    expect(shouldPromptKitaConnect(status, daysAgo(6), now)).toBe(false);
  });

  it('prompts again 7+ days after skipping when nothing is connected', () => {
    const status = { slack: 'not_connected', teams: 'not_connected' };
    expect(shouldPromptKitaConnect(status, daysAgo(7), now)).toBe(true);
  });

  it('never re-prompts after skipping once something is connected', () => {
    const status = { slack: 'connected', teams: 'not_connected' };
    expect(shouldPromptKitaConnect(status, daysAgo(30), now)).toBe(false);
  });
});
