import {
  bellItems,
  notificationKind,
  notificationRoute,
} from '../kitaNotifications';

describe('kitaNotifications', () => {
  const mention = {
    id: 1,
    notificationType: 'conversation_mention',
    primaryActor: { id: 42 },
    secondaryActor: { id: 900 },
  };
  const assignment = {
    id: 2,
    notificationType: 'conversation_assignment',
    primaryActor: { id: 43 },
    secondaryActor: { id: 5 },
  };

  it('classifies notifications', () => {
    expect(notificationKind('conversation_mention')).toBe('mention');
    expect(notificationKind('conversation_assignment')).toBe('assignment');
    expect(notificationKind('sla_missed_first_response')).toBe('other');
  });

  it('filters the bell to mentions', () => {
    expect(bellItems([mention, assignment]).map(item => item.kind)).toEqual([
      'mention',
      'assignment',
    ]);
    expect(
      bellItems([mention, assignment], { mentionsOnly: true }).map(
        item => item.id
      )
    ).toEqual([1]);
  });

  it('opens the conversation at the mentioning message', () => {
    const [item] = bellItems([mention]);
    expect(notificationRoute(item, 1)).toEqual({
      name: 'inbox_conversation',
      params: { accountId: 1, conversation_id: '42' },
      query: { messageId: '900' },
    });
    const [assigned] = bellItems([assignment]);
    expect(notificationRoute(assigned, 1).query).toEqual({});
  });
});
