import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaCustomerHeader from '../KitaCustomerHeader.vue';

const push = vi.fn();
const act = vi.fn().mockResolvedValue(true);
const open = vi.fn();

vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: getter =>
    computed(() => (getter === 'getCurrentAccountId' ? 1 : () => null)),
}));
vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRoute: () => ({ query: { scope: 'all', c: '4' } }),
  useRouter: () => ({ push }),
}));
vi.mock('dashboard/composables/useKitaAccountActions', () => ({
  KITA_SNOOZE_OPTIONS: ['an_hour_from_now'],
  useKitaAccountActions: () => ({ act, snooze: vi.fn() }),
}));
vi.mock('dashboard/composables/useAdmin', () => ({
  useAdmin: () => ({ isAdmin: computed(() => true) }),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const tala = {
  id: '7',
  kind: 'customer',
  name: 'Tala',
  stage: 'Production',
  dri_name: 'Carmel',
  grip_account_id: '7',
  open_tickets: 2,
  conversations: [
    { id: 11, platform: 'slack', label: '#kita-tala', status: 'open' },
    {
      id: 12,
      platform: 'whatsapp',
      label: 'Jun Lim',
      status: 'open',
      unread_count: 1,
    },
    { id: 4, platform: 'slack', label: '#kita-tala', status: 'resolved' },
  ],
};

const mountHeader = (props = {}) =>
  mount(KitaCustomerHeader, {
    props: {
      customer: tala,
      customerId: '7',
      tab: 'slack',
      conversationId: 11,
      ...props,
    },
    global: {
      plugins: [i18n],
      stubs: {
        MoreActions: true,
        KitaLinkCustomerModal: true,
        ChannelIcon: true,
        Dialog: { template: '<div />', methods: { open, close: vi.fn() } },
      },
    },
  });

describe('KitaCustomerHeader', () => {
  beforeEach(() => {
    push.mockClear();
    act.mockClear();
    open.mockClear();
  });

  it('shows the customer, stage, owner and one logo tab per platform plus Tickets', () => {
    const wrapper = mountHeader();
    expect(wrapper.text()).toContain('Tala');
    expect(wrapper.text()).toContain('Production');
    expect(wrapper.text()).toContain('Owned by Carmel · 2 channels');
    const tabs = wrapper.findAll('[data-test="kita-conversation-tab"]');
    expect(tabs.map(tab => tab.text().replace(/\s+/g, ''))).toEqual([
      'Slack#kita-tala',
      'WhatsAppJunLim1',
    ]);
    expect(tabs[0].findComponent({ name: 'PlatformLogo' }).exists()).toBe(true);
    expect(wrapper.find('[data-test="kita-tickets-tab"]').text()).toContain(
      '2 open'
    );
    expect(wrapper.find('a').attributes('href')).toBe(
      'https://internal.kita.ai/crm/accounts/7'
    );
  });

  it('switches tabs keeping the list filters', async () => {
    const wrapper = mountHeader();
    await wrapper.find('[data-test="kita-tickets-tab"]').trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'kita_inbox_customer',
      params: { accountId: 1, customerId: '7', tab: 'tickets' },
      query: { scope: 'all' },
    });
  });

  it('asks before Resolve all closes open tickets', async () => {
    const wrapper = mountHeader();
    await wrapper.find('[data-test-id="kita-resolve-all"]').trigger('click');
    expect(open).toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();

    const calm = mountHeader({ customer: { ...tala, open_tickets: 0 } });
    await calm.find('[data-test-id="kita-resolve-all"]').trigger('click');
    expect(act).toHaveBeenCalledWith(['7'], 'resolve');
  });
});
