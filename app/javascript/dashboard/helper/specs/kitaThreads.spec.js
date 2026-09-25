import { describe, it, expect } from 'vitest';
import {
  defaultKitaChannelKey,
  firstLine,
  isBridgeConversation,
  isHiddenThreadReply,
  kitaComposerBlock,
  parseKitaChannels,
  threadFooterSummary,
  threadMessages,
  threadTitle,
} from '../kitaThreads';

const slack = {
  key: 'C1',
  platform: 'slack',
  label: '#kita-tala',
  sendable: true,
};
const teams = { key: 'T1', platform: 'teams', label: 'Tala', sendable: true };
const whatsapp = {
  key: 'W1',
  platform: 'whatsapp',
  label: '+63 917',
  sendable: false,
};
const bridgeChat = channels => ({
  custom_attributes: { kita_channels: JSON.stringify(channels) },
});

describe('parseKitaChannels', () => {
  it('parses the kita_channels JSON string', () => {
    expect(parseKitaChannels(bridgeChat([slack, whatsapp]))).toEqual([
      slack,
      whatsapp,
    ]);
  });

  it('returns no channels for non-bridge or malformed conversations', () => {
    expect(parseKitaChannels({ custom_attributes: {} })).toEqual([]);
    expect(parseKitaChannels(null)).toEqual([]);
    expect(
      parseKitaChannels({ custom_attributes: { kita_channels: 'nope' } })
    ).toEqual([]);
  });
});

describe('isBridgeConversation', () => {
  it('is true only when kita_channels is set', () => {
    expect(isBridgeConversation(bridgeChat([slack]))).toBe(true);
    expect(isBridgeConversation({ custom_attributes: {} })).toBe(false);
  });
});

describe('defaultKitaChannelKey', () => {
  it('picks the first sendable channel', () => {
    expect(defaultKitaChannelKey([whatsapp, teams, slack])).toBe('T1');
  });

  it('is null when nothing is sendable', () => {
    expect(defaultKitaChannelKey([whatsapp])).toBeNull();
  });
});

describe('isHiddenThreadReply', () => {
  const reply = { id: 2, contentAttributes: { inReplyTo: 1 } };
  const root = { id: 1, contentAttributes: {} };

  it('hides thread replies in bridge conversations', () => {
    expect(isHiddenThreadReply(reply, true)).toBe(true);
    expect(isHiddenThreadReply(root, true)).toBe(false);
  });

  it('keeps replies in other conversations', () => {
    expect(isHiddenThreadReply(reply, false)).toBe(false);
  });
});

describe('kitaComposerBlock', () => {
  it('gates on the selected channel platform', () => {
    const status = { slack: 'connected', teams: 'not_connected' };
    expect(kitaComposerBlock(status, [slack, teams], 'T1')).toEqual({
      platform: 'teams',
      reason: 'not_connected',
    });
    expect(kitaComposerBlock(status, [slack, teams], 'C1')).toEqual({
      platform: 'slack',
      reason: null,
    });
  });

  it('falls back to the first sendable channel for an unknown selection', () => {
    expect(
      kitaComposerBlock({ slack: 'not_connected' }, [whatsapp, slack], 'W1')
    ).toEqual({ platform: 'slack', reason: 'not_connected' });
  });

  it('shows the mirror notice when no channel is sendable', () => {
    expect(kitaComposerBlock({}, [whatsapp], null)).toEqual({
      platform: 'whatsapp',
      reason: 'mirror',
    });
  });
});

describe('threadTitle', () => {
  it('prefers the AI title', () => {
    expect(threadTitle({ title: 'Loan export failing' }, 'hi')).toBe(
      'Loan export failing'
    );
  });

  it('falls back to the first line of the root', () => {
    expect(threadTitle({ title: null }, '\n  Export broke  \nmore')).toBe(
      'Export broke'
    );
    expect(firstLine(null)).toBe('');
  });
});

describe('threadFooterSummary', () => {
  it('caps avatars at 3 and carries unread, title and ticket', () => {
    const participants = [1, 2, 3, 4].map(id => ({ id, type: 'contact' }));
    expect(
      threadFooterSummary({
        reply_count: 5,
        participants,
        last_reply_at: 100,
        unread: true,
        title: 'Export',
        ticket: { id: 'T-1', url: 'https://grip/t/1' },
      })
    ).toEqual({
      count: 5,
      avatars: participants.slice(0, 3),
      lastReplyAt: 100,
      unread: true,
      title: 'Export',
      ticket: { id: 'T-1', url: 'https://grip/t/1' },
    });
  });
});

describe('threadMessages', () => {
  it('returns the root and its replies, oldest first', () => {
    const messages = [
      { id: 3, createdAt: 30, contentAttributes: { inReplyTo: 1 } },
      { id: 1, createdAt: 10, contentAttributes: {} },
      { id: 4, createdAt: 40, contentAttributes: { inReplyTo: 9 } },
      { id: 2, createdAt: 20, contentAttributes: { inReplyTo: 1 } },
    ];
    expect(threadMessages(messages, 1).map(message => message.id)).toEqual([
      1, 2, 3,
    ]);
  });
});
