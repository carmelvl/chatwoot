import {
  conversationTab,
  customerPreview,
  firstName,
  gripAccountUrl,
  sectionCustomers,
} from '../customersHelper';

const platformName = platform =>
  ({ slack: 'Slack', whatsapp: 'WhatsApp' })[platform] || '';

describe('customers workspace helpers', () => {
  it('splits customers into NEEDS REPLY, ACTIVE, then UNLINKED channels, dropping empty sections', () => {
    const tala = { id: '1', waiting_on_us: true };
    const n90 = { id: '2', waiting_on_us: false };
    const teams = { id: 'unlinked-7', waiting_on_us: true, unlinked: true };
    expect(sectionCustomers([teams, n90, tala])).toEqual([
      { key: 'NEEDS_REPLY', customers: [tala] },
      { key: 'ACTIVE', customers: [n90] },
      { key: 'UNLINKED', customers: [teams] },
    ]);
    expect(sectionCustomers([n90]).map(section => section.key)).toEqual([
      'ACTIVE',
    ]);
  });

  it('builds the preview line with platform and sender first name', () => {
    const customer = {
      last_message: {
        platform: 'slack',
        sender_name: 'Maria Reyes',
        content: 'batch 14 scores came back empty',
      },
    };
    const options = { platformName, you: 'You', currentUserName: 'Carmel' };
    expect(customerPreview(customer, options)).toBe(
      'Slack · Maria: batch 14 scores came back empty'
    );
    customer.last_message.sender_name = 'Carmel';
    expect(customerPreview(customer, options)).toBe(
      'Slack · You: batch 14 scores came back empty'
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
        { id: 7, platform: 'whatsapp', label: 'Jun Lim', unread_count: 1 },
        platformName
      )
    ).toEqual({
      id: 7,
      platform: 'whatsapp',
      title: 'WhatsApp',
      detail: 'Jun Lim',
      unreadCount: 1,
    });
    expect(firstName('  Jun Lim ')).toBe('Jun');
  });
});
