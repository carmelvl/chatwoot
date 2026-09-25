import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaNotificationBell from '../KitaNotificationBell.vue';

const dispatch = vi.fn().mockResolvedValue();
const push = vi.fn();
const notifications = [
  {
    id: 1,
    notificationType: 'conversation_mention',
    pushMessageTitle: 'Carmel mentioned you in Tala',
    primaryActorId: 30,
    primaryActorType: 'Conversation',
    primaryActor: { id: 42 },
    secondaryActor: { id: 900 },
    readAt: null,
    lastActivityAt: 1_758_700_000,
  },
  {
    id: 2,
    notificationType: 'conversation_assignment',
    pushMessageTitle: 'Amartha was assigned to you',
    primaryActorId: 31,
    primaryActorType: 'Conversation',
    primaryActor: { id: 43 },
    readAt: 1_758_700_100,
    lastActivityAt: 1_758_700_000,
  },
];
const getters = {
  getCurrentAccountId: 1,
  'notifications/getUnreadCount': 3,
  'notifications/getMeta': { unreadCount: 3 },
  'notifications/getFilteredNotificationsV4': () => notifications,
  'notifications/getUIFlags': { isFetching: false },
};

vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: getter => computed(() => getters[getter]),
}));
vi.mock('vuex', async importOriginal => ({
  ...(await importOriginal()),
  useStore: () => ({ dispatch }),
}));
vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRouter: () => ({ push }),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const mountBell = () =>
  mount(KitaNotificationBell, {
    global: { plugins: [i18n], stubs: { RouterLink: true } },
  });

describe('KitaNotificationBell', () => {
  beforeEach(() => {
    dispatch.mockClear();
    push.mockClear();
  });

  it('shows the unread count and lists notifications when opened', async () => {
    const wrapper = mountBell();
    expect(wrapper.find('[data-test="kita-bell-count"]').text()).toBe('3');
    await wrapper.find('button').trigger('click');
    expect(dispatch).toHaveBeenCalledWith('notifications/index', {
      page: 1,
      sortOrder: 'desc',
    });
    expect(wrapper.findAll('[data-test="kita-bell-item"]')).toHaveLength(2);
    expect(wrapper.text()).toContain('Mentioned you');
  });

  it('filters to mentions', async () => {
    const wrapper = mountBell();
    await wrapper.find('button').trigger('click');
    const tabs = wrapper.findAll('[data-test-id="kita-bell-panel"] button');
    await tabs.find(tab => tab.text() === 'Mentions').trigger('click');
    expect(wrapper.findAll('[data-test="kita-bell-item"]')).toHaveLength(1);
  });

  it('marks a mention read and opens its conversation at the message', async () => {
    const wrapper = mountBell();
    await wrapper.find('button').trigger('click');
    await wrapper.find('[data-test="kita-bell-item"]').trigger('click');
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith('notifications/read', {
      id: 1,
      primaryActorId: 30,
      primaryActorType: 'Conversation',
      unreadCount: 3,
    });
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith({
        name: 'inbox_conversation',
        params: { accountId: 1, conversation_id: '42' },
        query: { messageId: '900' },
      })
    );
  });
});
