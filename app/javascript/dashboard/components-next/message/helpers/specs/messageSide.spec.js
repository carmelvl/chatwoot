import { getMessageOrientation, isKitaTeammate } from '../messageSide';
import { MESSAGE_STATUS, MESSAGE_TYPES, ORIENTATION } from '../../constants';

const currentUserId = 1;

describe('messageSide', () => {
  it('puts the current user own message on the right', () => {
    const message = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.SENT,
      sender: { id: 1, type: 'user' },
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.RIGHT);
    expect(isKitaTeammate(message)).toBe(false);
  });

  it('puts every message on the left in a flat (Slack/Teams) layout', () => {
    const own = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.SENT,
      sender: { id: 1, type: 'user' },
      currentUserId,
      flat: true,
    };
    expect(getMessageOrientation(own)).toBe(ORIENTATION.LEFT);
    expect(
      getMessageOrientation({ ...own, messageType: MESSAGE_TYPES.ACTIVITY })
    ).toBe(ORIENTATION.CENTER);
  });

  it('puts an in-progress outgoing message on the right', () => {
    const message = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.PROGRESS,
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.RIGHT);
  });

  it('puts another teammate on the left as a Kita teammate', () => {
    const message = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.SENT,
      senderType: 'User',
      senderId: 2,
      sender: { id: 2, type: 'user' },
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.LEFT);
    expect(isKitaTeammate(message)).toBe(true);
  });

  it('puts a customer on the left and not as a teammate', () => {
    const message = {
      messageType: MESSAGE_TYPES.INCOMING,
      status: MESSAGE_STATUS.SENT,
      sender: { id: 1, type: 'contact', customAttributes: {} },
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.LEFT);
    expect(isKitaTeammate(message)).toBe(false);
  });

  it('treats a kita_staff contact on an outgoing message as a teammate', () => {
    const camelized = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.SENT,
      sender: { id: 9, type: 'contact', customAttributes: { kitaStaff: true } },
      currentUserId,
    };
    const raw = {
      ...camelized,
      sender: {
        id: 9,
        type: 'contact',
        custom_attributes: { kita_staff: true },
      },
    };
    expect(getMessageOrientation(camelized)).toBe(ORIENTATION.LEFT);
    expect(isKitaTeammate(camelized)).toBe(true);
    expect(isKitaTeammate(raw)).toBe(true);
  });

  it('puts bot and sender-less messages on the left', () => {
    const message = {
      messageType: MESSAGE_TYPES.OUTGOING,
      status: MESSAGE_STATUS.SENT,
      sender: null,
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.LEFT);
    expect(isKitaTeammate(message)).toBe(false);
  });

  it('centers activity messages', () => {
    const message = {
      messageType: MESSAGE_TYPES.ACTIVITY,
      status: MESSAGE_STATUS.SENT,
      currentUserId,
    };
    expect(getMessageOrientation(message)).toBe(ORIENTATION.CENTER);
  });
});
