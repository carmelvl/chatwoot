import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaInboxRow from '../KitaInboxRow.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const now = Math.floor(Date.now() / 1000);
const unlinked = {
  id: 'unlinked-slack:#kita-test',
  kind: 'unlinked',
  unlinked: true,
  section: 'unlinked',
  name: '#kita-test',
  platforms: ['slack'],
  waiting_since: now - 18 * 3600,
  last_activity_at: now - 60,
  unread_count: 1,
  conversations: [{ id: 5, platform: 'slack', status: 'open' }],
  last_message: {
    content: 'is batch 14 in?',
    sender_name: 'Test User',
    platform: 'slack',
  },
};
const tala = {
  id: '7',
  kind: 'customer',
  section: 'needs_reply',
  name: 'Tala',
  dri_name: 'Rhea Malhotra',
  platforms: ['slack', 'whatsapp'],
  last_activity_at: now - 60,
  unread_count: 0,
  urgent_ticket: true,
  pressing_tickets: 2,
  top_ticket: { display_id: 'KT-41', priority: 'urgent', title: 'Webhook' },
  conversations: [],
  last_message: {
    content: 'batch 14 came back empty',
    sender_name: 'Maria Reyes',
    platform: 'whatsapp',
  },
};

const mountRow = (row, props = {}) =>
  mount(KitaInboxRow, {
    props: { row, ...props },
    global: { plugins: [i18n], stubs: { ChannelIcon: true } },
  });

const lines = wrapper =>
  wrapper
    .findAll('[data-test="kita-inbox-row"] > span')
    .map(line => line.text().replace(/\s+/g, ' ').trim());

describe('KitaInboxRow', () => {
  it('reads name + time, one logo + "Sender: preview", then a muted Not linked line', () => {
    const wrapper = mountRow(unlinked, { canLink: true });
    expect(wrapper.findAll('[data-test="kita-inbox-logo"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="kita-inbox-preview"]').text()).toBe(
      'Test: is batch 14 in?'
    );
    expect(wrapper.text()).not.toContain('Slack ·');
    expect(wrapper.text()).not.toContain('waiting');
    expect(wrapper.find('[data-test="kita-inbox-muted"]').text()).toBe(
      'Not linked'
    );
    expect(wrapper.find('[data-test="kita-inbox-unread"]').exists()).toBe(true);
    expect(lines(wrapper)).toHaveLength(3);
  });

  it('keeps Link to customer and Not a customer inside the row ⋯ menu', async () => {
    const wrapper = mountRow(unlinked, { canLink: true });
    expect(wrapper.text()).not.toContain('Link to customer');
    const menu = wrapper.find('[data-test="kita-inbox-row-menu"]');
    expect(
      wrapper
        .find('[data-test="kita-inbox-row"]')
        .element.contains(menu.element)
    ).toBe(true);
    await menu.trigger('click');
    const items = wrapper
      .findAll('[data-test="kita-inbox-row-actions"] button')
      .map(item => item.text());
    expect(items).toEqual(['Select', 'Link to customer', 'Not a customer']);
    await wrapper
      .findAll('[data-test="kita-inbox-row-actions"] button')[1]
      .trigger('click');
    expect(wrapper.emitted('action')[0]).toEqual(['link', unlinked]);
    expect(wrapper.emitted('open')).toBeUndefined();
  });

  it('shows a multi-platform customer as a logo strip and the urgent ticket in red', () => {
    const wrapper = mountRow(tala);
    expect(wrapper.findAll('[data-test="kita-inbox-logo"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="kita-inbox-preview"]').text()).toBe(
      'Maria: batch 14 came back empty'
    );
    expect(wrapper.find('[data-test="kita-inbox-urgent"]').text()).toBe(
      'Urgent ticket KT-41 · Webhook · +1 more'
    );
    expect(wrapper.find('[data-test="kita-inbox-muted"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="kita-inbox-unread"]').exists()).toBe(
      false
    );
  });

  it('shows the owner on line 3 and opens on click', async () => {
    const wrapper = mountRow({ ...tala, urgent_ticket: false });
    expect(wrapper.find('[data-test="kita-inbox-muted"]').text()).toBe('Rhea');
    await wrapper.find('[data-test="kita-inbox-row"]').trigger('click');
    expect(wrapper.emitted('open')).toHaveLength(1);
  });
});
