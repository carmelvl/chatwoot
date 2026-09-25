import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import { DEFAULT_INBOX_FILTERS } from 'dashboard/helper/kitaInbox';
import KitaInboxFilterBar from '../KitaInboxFilterBar.vue';

const getters = {
  'labels/getLabels': [{ id: 1, title: 'billing' }],
  'teams/getTeams': [{ id: 2, name: 'Support' }],
  'agents/getAgents': [{ id: 3, name: 'Rhea', email: 'rhea@kita.ai' }],
  'inboxes/getInboxById': () => null,
  'customViews/getConversationCustomViews': [],
};
vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: getter => computed(() => getters[getter]),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const mountBar = filters =>
  mount(KitaInboxFilterBar, {
    props: { filters: { ...DEFAULT_INBOX_FILTERS, ...filters } },
    global: { plugins: [i18n] },
  });

describe('KitaInboxFilterBar', () => {
  it('is one compact row: status segments, a Filter button and a sort button; no chips by default', () => {
    const wrapper = mountBar();
    expect(
      wrapper
        .findAll('[data-test="kita-status-segments"] button')
        .map(b => b.text())
    ).toEqual(['Needs reply', 'Open', 'Resolved']);
    expect(wrapper.find('[data-test="kita-filter-button"]').exists()).toBe(
      true
    );
    expect(wrapper.find('[data-test="kita-sort-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="kita-filter-chips"]').exists()).toBe(
      false
    );
    expect(wrapper.find('[data-test="kita-filter-popover"]').exists()).toBe(
      false
    );
    expect(wrapper.findAll('[data-test="kita-filter-menu"]')).toHaveLength(0);
  });

  it('switches status from the segments', async () => {
    const wrapper = mountBar();
    await wrapper
      .findAll('[data-test="kita-status-segments"] button')[0]
      .trigger('click');
    expect(wrapper.emitted('update')[0]).toEqual([{ status: 'needs_reply' }]);
  });

  it('keeps every other filter in the Filter popover, with Advanced filters', async () => {
    const wrapper = mountBar();
    await wrapper.find('[data-test="kita-filter-button"]').trigger('click');
    const popover = wrapper.find('[data-test="kita-filter-popover"]');
    const text = popover.text();
    [
      'Status',
      'Platform',
      'Owner',
      'Label',
      'Team',
      'Ticket priority',
      'Ticket status',
      'Stage',
    ].forEach(label => expect(text).toContain(label));
    await popover.find('[data-test="kita-advanced-filters"]').trigger('click');
    expect(wrapper.emitted('advanced')).toHaveLength(1);
  });

  it('shows a removable chip only for each set filter', async () => {
    const wrapper = mountBar({ platform: 'slack', label: 'billing' });
    const chips = wrapper.findAll('[data-test="kita-filter-chip"]');
    expect(chips.map(chip => chip.text())).toEqual([
      'Platform: Slack',
      'Label: billing',
    ]);
    await chips[0].trigger('click');
    expect(wrapper.emitted('update')[0]).toEqual([{ platform: null }]);
  });
});
