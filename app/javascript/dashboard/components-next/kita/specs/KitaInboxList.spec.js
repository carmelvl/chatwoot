import { mount } from '@vue/test-utils';
import { computed, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaInboxList from '../KitaInboxList.vue';

const dispatch = vi.fn().mockResolvedValue();
const commit = vi.fn();
const push = vi.fn();
const route = reactive({
  name: 'kita_inbox',
  params: { accountId: '1' },
  query: {},
});
const rows = [
  {
    id: '7',
    kind: 'customer',
    section: 'needs_reply',
    name: 'Tala',
    conversations: [{ id: 12, platform: 'whatsapp', status: 'open' }],
    waiting_platform: 'whatsapp',
  },
  {
    id: '9',
    kind: 'customer',
    section: 'active',
    name: 'Amartha',
    conversations: [{ id: 3, platform: 'teams', status: 'open' }],
  },
  {
    id: 'unlinked-slack:#kita-test',
    kind: 'unlinked',
    unlinked: true,
    section: 'unlinked',
    name: '#kita-test',
    conversations: [{ id: 5, platform: 'slack', status: 'open' }],
  },
];
const getters = {
  getCurrentAccountId: 1,
  getCurrentUser: { name: 'Carmel' },
  'kitaInbox/getRows': rows,
  'kitaInbox/getMeta': { count: 3, has_more: false },
  'kitaInbox/isFetching': false,
  'labels/getLabels': [{ id: 1, title: 'billing' }],
  'teams/getTeams': [],
  'agents/getAgents': [],
  'customViews/getConversationCustomViews': [{ id: 4, name: 'VIP' }],
  getAppliedConversationFiltersQuery: [],
  'inboxes/getInboxById': () => null,
};

vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: getter => computed(() => getters[getter]),
}));
vi.mock('vuex', async importOriginal => ({
  ...(await importOriginal()),
  useStore: () => ({ dispatch, commit }),
}));
vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRoute: () => route,
  useRouter: () => ({ push }),
}));
vi.mock('dashboard/composables/useAdmin', () => ({
  useAdmin: () => ({ isAdmin: computed(() => true) }),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const mountList = () =>
  mount(KitaInboxList, {
    props: { customerId: '' },
    global: {
      plugins: [i18n],
      stubs: {
        KitaInboxRow: {
          props: ['row'],
          template: '<div data-test="kita-inbox-row">{{ row.name }}</div>',
        },
        KitaLinkCustomerModal: true,
        ConversationFilter: true,
        SaveCustomView: true,
      },
    },
  });

describe('KitaInboxList', () => {
  beforeEach(() => {
    dispatch.mockClear();
    commit.mockClear();
    push.mockClear();
  });

  it('loads Mine / Open by default and lists rows by section, unlinked collapsed', () => {
    const wrapper = mountList();
    expect(commit).toHaveBeenCalledWith(
      'kitaInbox/SET_KITA_INBOX_FILTERS',
      expect.objectContaining({ scope: 'mine', status: 'open' })
    );
    expect(dispatch).toHaveBeenCalledWith('kitaInbox/fetch', { more: false });
    const sections = wrapper.findAll('[data-test="kita-inbox-section"]');
    expect(sections.map(section => section.find('button').text())).toEqual([
      'Needs reply 1',
      'Active 1',
      'Unlinked 1',
    ]);
    expect(
      wrapper.findAll('[data-test="kita-inbox-row"]').map(row => row.text())
    ).toEqual(['Tala', 'Amartha']);
  });

  it('opens a collapsed section with its Link and Not a customer actions', async () => {
    const wrapper = mountList();
    await wrapper
      .findAll('[data-test="kita-inbox-section"]')[2]
      .find('button')
      .trigger('click');
    expect(wrapper.text()).toContain('#kita-test');
    expect(wrapper.find('[data-test="kita-link-customer"]').exists()).toBe(
      true
    );
    expect(wrapper.find('[data-test="kita-not-customer"]').text()).toBe(
      'Not a customer'
    );
  });

  it('switches scope and saved views through the URL', async () => {
    const wrapper = mountList();
    const tabs = wrapper.findAll('[data-test="kita-inbox-scope"]');
    expect(tabs.map(tab => tab.text())).toEqual([
      'Mine',
      'Unassigned',
      'All',
      'VIP',
    ]);
    await tabs[2].trigger('click');
    expect(push).toHaveBeenLastCalledWith({
      name: 'kita_inbox',
      params: { accountId: '1' },
      query: { scope: 'all' },
    });
    await tabs[3].trigger('click');
    expect(push).toHaveBeenLastCalledWith({
      name: 'kita_inbox',
      params: { accountId: '1' },
      query: { scope: 'all', view: '4' },
    });
  });

  it('shows filters from a classic URL as a removable chip', async () => {
    route.query = { scope: 'all', status: 'all', type: 'mention' };
    const wrapper = mountList();
    const chip = wrapper
      .findAll('button')
      .find(button => button.text() === 'Mentions');
    expect(chip).toBeTruthy();
    await chip.trigger('click');
    expect(push).toHaveBeenLastCalledWith({
      name: 'kita_inbox',
      params: { accountId: '1' },
      query: { scope: 'all', status: 'all' },
    });
    route.query = {};
  });
});
