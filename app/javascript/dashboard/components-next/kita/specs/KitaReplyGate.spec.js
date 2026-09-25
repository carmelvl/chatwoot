import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import KitaReplyGate from '../KitaReplyGate.vue';
import settings from 'dashboard/i18n/locale/en/settings.json';
import { openKitaConnect } from 'dashboard/helper/kitaConnect';

vi.mock('dashboard/helper/kitaConnect', () => ({ openKitaConnect: vi.fn() }));

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: settings },
});

const mountGate = props =>
  mount(KitaReplyGate, {
    props,
    global: { plugins: [i18n], stubs: { PlatformLogo: true } },
  });

const connect = '[data-test-id="kita-connect"]';
const addNote = '[data-test-id="kita-add-private-note"]';

describe('KitaReplyGate', () => {
  it('asks to connect Slack and opens /kita/connect', async () => {
    const wrapper = mountGate({ platform: 'slack', reason: 'not_connected' });
    expect(wrapper.text()).toContain(
      'Connect your Slack account to reply here'
    );
    expect(wrapper.text()).toContain('Private notes still work.');
    await wrapper.find(connect).trigger('click');
    expect(openKitaConnect).toHaveBeenCalled();
  });

  it('names the platform of the conversation (Teams)', () => {
    const wrapper = mountGate({ platform: 'teams', reason: 'not_connected' });
    expect(wrapper.text()).toContain(
      'Connect your Microsoft Teams account to reply here'
    );
  });

  it('has no Connect button while the platform is not configured', () => {
    const wrapper = mountGate({ platform: 'teams', reason: 'unavailable' });
    expect(wrapper.text()).toContain(
      "Microsoft Teams replies aren't available yet"
    );
    expect(wrapper.find(connect).exists()).toBe(false);
  });

  it('shows the mirror bar naming the contact and the phone app', () => {
    const wrapper = mountGate({
      platform: 'whatsapp',
      reason: 'mirror',
      contactName: 'Jun',
    });
    expect(wrapper.text()).toContain(
      'Reply to Jun from WhatsApp Business on your phone'
    );
    expect(wrapper.text()).toContain('This chat is a mirror.');
    expect(wrapper.find(connect).exists()).toBe(false);
  });

  it('opens a private note from every gate', async () => {
    const wrapper = mountGate({ platform: 'viber', reason: 'mirror' });
    expect(wrapper.text()).toContain(
      'Reply in Viber yourself — this inbox is a mirror'
    );
    await wrapper.find(addNote).trigger('click');
    expect(wrapper.emitted('addPrivateNote')).toHaveLength(1);
  });
});
