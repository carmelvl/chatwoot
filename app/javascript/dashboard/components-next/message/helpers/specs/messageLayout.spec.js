import {
  GROUP_WINDOW_SECONDS,
  getMessageLayout,
  groupsWithPrevious,
} from '../messageLayout';
import {
  MESSAGE_STATUS,
  MESSAGE_TYPES,
  MESSAGE_VARIANTS,
  ORIENTATION,
} from '../../constants';

const currentUserId = 1;
const customer = { id: 7, type: 'contact' };
const teammate = { id: 2, type: 'user' };
const me = { id: 1, type: 'user' };

const message = (sender, createdAt, overrides = {}) => ({
  messageType:
    sender.type === 'contact' ? MESSAGE_TYPES.INCOMING : MESSAGE_TYPES.OUTGOING,
  status: MESSAGE_STATUS.SENT,
  sender,
  senderId: sender.id,
  senderType: sender.type,
  createdAt,
  ...overrides,
});

describe('groupsWithPrevious', () => {
  it('groups the same sender within 5 minutes', () => {
    const previous = message(customer, 1000);
    const current = message(customer, 1000 + GROUP_WINDOW_SECONDS);
    expect(groupsWithPrevious(current, previous, currentUserId)).toBe(true);
  });

  it('starts a new group after 5 minutes', () => {
    const previous = message(customer, 1000);
    const current = message(customer, 1001 + GROUP_WINDOW_SECONDS);
    expect(groupsWithPrevious(current, previous, currentUserId)).toBe(false);
  });

  it('starts a new group when the sender changes', () => {
    const previous = message(customer, 1000);
    const current = message(teammate, 1010);
    expect(groupsWithPrevious(current, previous, currentUserId)).toBe(false);
  });

  it('does not group sender-less messages from different Slack users', () => {
    const slack = name => ({
      messageType: MESSAGE_TYPES.INCOMING,
      status: MESSAGE_STATUS.SENT,
      createdAt: 1000,
      additionalAttributes: { senderName: name },
    });
    const ana = slack('Ana');
    expect(groupsWithPrevious(ana, slack('Ben'), currentUserId)).toBe(false);
    expect(groupsWithPrevious(ana, slack('Ana'), currentUserId)).toBe(true);
  });

  it('never groups the first message, activity or a failed message', () => {
    const previous = message(me, 1000);
    expect(groupsWithPrevious(previous, null, currentUserId)).toBe(false);
    const failed = message(me, 1010, { status: MESSAGE_STATUS.FAILED });
    expect(groupsWithPrevious(failed, previous, currentUserId)).toBe(false);
    const activity = message(me, 1010, {
      messageType: MESSAGE_TYPES.ACTIVITY,
    });
    expect(groupsWithPrevious(activity, previous, currentUserId)).toBe(false);
  });

  it('never groups a private note with a public reply', () => {
    const previous = message(me, 1000);
    const note = message(me, 1010, { private: true });
    expect(groupsWithPrevious(note, previous, currentUserId)).toBe(false);
    expect(groupsWithPrevious(previous, note, currentUserId)).toBe(false);
    const nextNote = message(me, 1020, { private: true });
    expect(groupsWithPrevious(nextNote, note, currentUserId)).toBe(true);
  });

  it('groups own consecutive messages on the right', () => {
    const previous = message(me, 1000);
    const current = message(me, 1060);
    expect(groupsWithPrevious(current, previous, currentUserId)).toBe(true);
  });
});

describe('getMessageLayout', () => {
  it('gives a left message an avatar column, avatar and header', () => {
    const layout = getMessageLayout({
      orientation: ORIENTATION.LEFT,
      variant: MESSAGE_VARIANTS.USER,
      groupWithPrevious: false,
    });
    expect(layout).toEqual({
      avatarColumn: true,
      showAvatar: true,
      showHeader: true,
      timeInHeader: true,
      followUpMeta: false,
    });
  });

  it('keeps the avatar column but hides avatar and header when grouped', () => {
    const layout = getMessageLayout({
      orientation: ORIENTATION.LEFT,
      variant: MESSAGE_VARIANTS.TEAMMATE,
      groupWithPrevious: true,
    });
    expect(layout).toEqual({
      avatarColumn: true,
      showAvatar: false,
      showHeader: false,
      timeInHeader: true,
      followUpMeta: true,
    });
  });

  it('never gives an own message an avatar', () => {
    const layout = getMessageLayout({
      orientation: ORIENTATION.RIGHT,
      variant: MESSAGE_VARIANTS.AGENT,
      groupWithPrevious: false,
    });
    expect(layout.avatarColumn).toBe(false);
    expect(layout.showAvatar).toBe(false);
    expect(layout.showHeader).toBe(true);
  });

  it('leaves email and activity messages on their own layout', () => {
    [
      { orientation: ORIENTATION.LEFT, variant: MESSAGE_VARIANTS.EMAIL },
      { orientation: ORIENTATION.CENTER, variant: MESSAGE_VARIANTS.ACTIVITY },
    ].forEach(input => {
      const layout = getMessageLayout({ ...input, groupWithPrevious: false });
      expect(layout).toMatchObject({ showHeader: false, timeInHeader: false });
    });
  });
});
