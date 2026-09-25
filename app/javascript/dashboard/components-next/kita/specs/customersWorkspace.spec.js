import {
  conversationTab,
  customerPreview,
  firstName,
  gripAccountUrl,
} from '../customersHelper';

const platformName = platform =>
  ({ slack: 'Slack', whatsapp: 'WhatsApp' })[platform] || '';

describe('customers workspace helpers', () => {
  it('builds the preview line from the sender first name', () => {
    const customer = {
      last_message: {
        platform: 'slack',
        sender_name: 'Maria Reyes',
        content: 'batch 14 scores came back empty',
      },
    };
    const options = { you: 'You', currentUserName: 'Carmel' };
    expect(customerPreview(customer, options)).toBe(
      'Maria: batch 14 scores came back empty'
    );
    customer.last_message.sender_name = 'Carmel';
    expect(customerPreview(customer, options)).toBe(
      'You: batch 14 scores came back empty'
    );
    expect(customerPreview({ last_message: null }, options)).toBe('');
  });

  it('links the Grip account only when it is known', () => {
    expect(gripAccountUrl({ grip_account_id: 'abc' })).toBe(
      'https://internal.kita.ai/crm/accounts/abc'
    );
    expect(gripAccountUrl({ grip_account_id: null })).toBeNull();
  });

  it('labels a per-platform conversation tab', () => {
    expect(
      conversationTab(
        {
          id: 7,
          platform: 'whatsapp',
          label: 'Jun Lim',
          unread_count: 1,
          inbox_id: 3,
          channel_type: 'Channel::Api',
        },
        platformName
      )
    ).toEqual({
      id: 7,
      platform: 'whatsapp',
      inboxId: 3,
      channelType: 'Channel::Api',
      title: 'WhatsApp',
      detail: 'Jun Lim',
      unreadCount: 1,
    });
    expect(firstName('  Jun Lim ')).toBe('Jun');
  });
});
