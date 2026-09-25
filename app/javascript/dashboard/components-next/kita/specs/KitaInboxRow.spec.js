import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaInboxRow from '../KitaInboxRow.vue';

vi.mock('dashboard/composables/store', async importOriginal => ({
  ...(await importOriginal()),
  useMapGetter: () =>
    computed(() => [{ id: 4, name: 'Rhea Malhotra', thumbnail: '' }]),
}));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const now = Math.floor(Date.now() / 1000);
const tala = {
  id: '7',
  kind: 'customer',
  section: 'needs_reply',
  name: 'Tala',
  stage: 'Production',
  dri_id: 4,
  dri_name: 'Rhea Malhotra',
  platforms: ['slack', 'whatsapp'],
  waiting_since: now - 3 * 3600,
  last_activity_at: now - 60,
  unread_count: 2,
  urgent_ticket: true,
  pressing_tickets: 2,
  top_ticket: {
    display_id: 'KT-41',
    priority: 'urgent',
    title: 'Failed disbursement webhook',
  },
  labels: ['billing', 'kyc', 'pilot', 'vip'],
  conversations: [
    { id: 11, platform: 'slack', status: 'resolved', unread_count: 0 },
    {
      id: 12,
      platform: 'whatsapp',
      status: 'open',
      needs_reply: true,
      unread_count: 2,
    },
  ],
  last_message: {
    content: 'batch 14 came back empty',
    sender_name: 'Maria Reyes',
    platform: 'whatsapp',
  },
};

const mountRow = (row, props = {}) =>
  mount(KitaInboxRow, {
    props: { row, ...props },
    global: {
      plugins: [i18n],
      stubs: { Avatar: true, ChannelIcon: true },
    },
  });

describe('KitaInboxRow', () => {
  it('shows the customer, stage, platforms, preview, ticket line and labels', () => {
    const wrapper = mountRow(tala);
    const text = wrapper.text();
    expect(text).toContain('Tala');
    expect(text).toContain('Production');
    expect(text).toContain('WhatsApp · Maria: batch 14 came back empty');
    expect(wrapper.find('[data-test="kita-inbox-ticket"]').text()).toMatch(
      /KT-41 · Urgent · Failed disbursement webhook\s+\+1 more/
    );
    expect(text).toContain('billing');
    expect(text).toContain('+1');
    expect(wrapper.findAll('[data-test="kita-inbox-platform"]')).toHaveLength(
      2
    );
  });

  it('shows the wait in red only with an open urgent ticket, and pins pressing rows', () => {
    const wrapper = mountRow(tala);
    const wait = wrapper.find('[data-test="kita-inbox-wait"]');
    expect(wait.text()).toBe('waiting 3h');
    expect(wait.classes()).toContain('text-n-ruby-11');
    expect(wrapper.find('[data-test="kita-inbox-pinned"]').exists()).toBe(true);

    const calm = mountRow({
      ...tala,
      urgent_ticket: false,
      pressing_tickets: 0,
      top_ticket: null,
    });
    expect(calm.find('[data-test="kita-inbox-wait"]').classes()).not.toContain(
      'text-n-ruby-11'
    );
    expect(calm.find('[data-test="kita-inbox-pinned"]').exists()).toBe(false);
  });

  it('tags unlinked channels and emits open and select', async () => {
    const wrapper = mountRow({
      ...tala,
      kind: 'unlinked',
      unlinked: true,
      section: 'unlinked',
      waiting_since: null,
    });
    expect(wrapper.text()).toContain('Not linked');
    await wrapper.find('[data-test="kita-inbox-row"]').trigger('click');
    expect(wrapper.emitted('open')[0][0].id).toBe('7');
    await wrapper.find('[data-test="kita-inbox-select"]').trigger('click');
    expect(wrapper.emitted('toggleSelect')).toHaveLength(1);
    expect(wrapper.emitted('open')).toHaveLength(1);
  });
});
