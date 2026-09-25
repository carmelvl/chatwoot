import {
  conversationRowRoute,
  redirectConversationToInbox,
  redirectListToInbox,
} from '../kitaRedirects';

describe('kitaRedirects', () => {
  it('opens classic list URLs as Inbox filters', () => {
    const route = (name, params = {}) =>
      redirectListToInbox({ name, params: { accountId: '1', ...params } });
    expect(route('home')).toEqual({
      name: 'kita_inbox',
      params: { accountId: '1' },
      query: {},
    });
    expect(route('label_conversations', { label: 'billing' }).query).toEqual({
      scope: 'all',
      label: 'billing',
    });
    expect(route('team_conversations', { teamId: '4' }).query).toEqual({
      scope: 'all',
      team: '4',
    });
    expect(route('inbox_dashboard', { inbox_id: '2' }).query).toEqual({
      scope: 'all',
      inbox: '2',
    });
    expect(route('folder_conversations', { id: '9' }).query).toEqual({
      scope: 'all',
      view: '9',
    });
    expect(route('conversation_mentions').query).toEqual({
      scope: 'all',
      status: 'all',
      type: 'mention',
    });
  });

  it('opens a conversation URL on its customer and platform tab', () => {
    const row = {
      id: '7',
      conversations: [
        { id: 12, platform: 'whatsapp' },
        { id: 11, platform: 'slack' },
      ],
    };
    const to = {
      params: { accountId: '1', conversation_id: '11' },
      query: { messageId: '40' },
    };
    expect(conversationRowRoute(row, '11', to)).toEqual({
      name: 'kita_inbox_customer',
      params: { accountId: '1', customerId: '7', tab: 'slack' },
      query: { c: '11', messageId: '40' },
    });
    expect(
      conversationRowRoute(
        { id: 'conversation-5', conversations: [{ id: 5, platform: null }] },
        '5',
        { params: { accountId: '1' } }
      ).params.tab
    ).toBe('conversation');
  });

  it('resolves through the lookup, falling back to the Inbox', async () => {
    const lookup = vi.fn().mockResolvedValue({
      id: '7',
      conversations: [{ id: 3, platform: 'teams' }],
    });
    const to = { params: { accountId: '1', conversationId: '3' }, query: {} };
    expect(await redirectConversationToInbox(lookup)(to)).toMatchObject({
      params: { customerId: '7', tab: 'teams' },
    });
    expect(lookup).toHaveBeenCalledWith('3');

    const failing = vi.fn().mockRejectedValue(new Error('404'));
    expect(await redirectConversationToInbox(failing)(to)).toEqual({
      name: 'kita_inbox',
      params: { accountId: '1' },
    });
  });
});
