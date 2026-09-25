import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import settings from 'dashboard/i18n/locale/en/settings.json';
import KitaTicketChip from '../KitaTicketChip.vue';
import KitaThreadFooter from '../KitaThreadFooter.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const ticket = {
  id: 'T1',
  url: 'https://internal.kita.ai/t/1',
  display_id: 'KT-142',
  priority: 'urgent',
  status: 'open',
};

describe('KitaTicketChip', () => {
  it('reads "Urgent ticket KT-142 · title" in red and links to Grip', () => {
    const wrapper = mount(KitaTicketChip, {
      props: { ticket, title: 'AI underwriter stopped working' },
      global: { plugins: [i18n] },
    });
    expect(wrapper.findAll('span').map(span => span.text())).toEqual([
      '',
      'Urgent ticket KT-142',
      '·',
      'AI underwriter stopped working',
    ]);
    expect(wrapper.classes()).toContain('bg-n-ruby-3');
    expect(wrapper.attributes('href')).toBe(ticket.url);
  });

  it('shows on a thread root footer, with the thread title', () => {
    const wrapper = mount(KitaThreadFooter, {
      props: {
        conversationId: 9,
        thread: {
          root_message_id: 50,
          reply_count: 0,
          title: 'AI underwriter stopped working',
          ticket,
        },
      },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="kita-ticket-chip"]').text()).toContain(
      'AI underwriter stopped working'
    );
  });
});
