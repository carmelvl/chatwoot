import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaThreadPane from '../KitaThreadPane.vue';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';

const rootMessage = {
  id: 50,
  conversation_id: 3,
  content: 'The risk score for batch 14 came back empty',
  content_attributes: { external_source: 'slack' },
  created_at: 1_758_700_000,
};

vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: getter =>
    computed(() =>
      getter === 'getSelectedChat' ? { id: 3, messages: [rootMessage] } : 1
    ),
}));
vi.mock('vuex', async importOriginal => ({
  ...(await importOriginal()),
  useStore: () => ({ dispatch: vi.fn() }),
}));
vi.mock('dashboard/composables/useKitaConnections', async () => {
  const { ref } = await import('vue');
  return {
    useKitaConnections: () => ({ status: ref({ slack: 'connected' }) }),
  };
});
vi.mock('dashboard/api/kitaThreads', () => ({
  default: { get: vi.fn(), markRead: vi.fn(), updateStatus: vi.fn() },
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const { threadsByConversation } = useKitaThreads();

const mountPane = ticket => {
  threadsByConversation[3] = [
    {
      root_message_id: 50,
      title: 'Batch 14 scores missing',
      status: 'open',
      external_source: 'slack',
      external_channel: '#kita-tala',
      ticket,
    },
  ];
  return mount(KitaThreadPane, {
    props: { conversationId: 3, rootId: 50 },
    global: {
      plugins: [i18n],
      stubs: { Message: true, TextArea: true, KitaReplyGate: true },
    },
  });
};

describe('KitaThreadPane', () => {
  it('names the thread location and title', () => {
    const wrapper = mountPane(null);
    expect(wrapper.text()).toContain('Thread in Slack #kita-tala');
    expect(wrapper.text()).toContain('Batch 14 scores missing');
    expect(wrapper.find('[data-test="kita-ticket-card"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Resolve thread');
  });

  it('shows the ticket card with the fields Grip sent, SLA in red when close', () => {
    const wrapper = mountPane({
      id: 't-1',
      url: 'https://internal.kita.ai/tasks/t-1',
      display_id: 'KT-142',
      priority: 'urgent',
      status: 'open',
      owner: 'Carmel',
      sla_due_at: Math.floor(Date.now() / 1000) + 108 * 60 + 30,
    });
    const card = wrapper.find('[data-test="kita-ticket-card"]');
    expect(card.text()).toContain('Ticket KT-142');
    expect(card.text()).toContain('Urgent');
    expect(card.text()).toContain('Carmel');
    expect(card.text()).toContain('1h 48m left');
    expect(card.find('.text-n-ruby-11').exists()).toBe(true);
    expect(wrapper.text()).toContain('Resolve thread and ticket');
    expect(wrapper.text()).toContain('Open in Grip');
  });

  it('hides the ticket fields Grip did not send', () => {
    const wrapper = mountPane({ id: 't-1', url: 'https://x', priority: null });
    const card = wrapper.find('[data-test="kita-ticket-card"]');
    expect(card.text()).toBe('Ticket');
    expect(card.find('dl').exists()).toBe(false);
  });
});
