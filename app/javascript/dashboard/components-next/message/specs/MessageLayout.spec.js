import { mount } from '@vue/test-utils';
import Message from '../Message.vue';
import { MESSAGE_STATUS, MESSAGE_TYPES } from '../constants';

vi.mock('dashboard/composables/store', async importOriginal => {
  const { computed } = await import('vue');
  return {
    ...(await importOriginal()),
    useMapGetter: () => computed(() => () => ({})),
    useStoreGetters: () => ({}),
    useStore: () => ({ getters: {}, dispatch: () => {} }),
  };
});

vi.mock('vue-router', async importOriginal => ({
  ...(await importOriginal()),
  useRoute: () => ({ query: {} }),
}));

vi.mock(
  'dashboard/modules/conversations/components/MessageContextMenu.vue',
  () => ({ default: { template: '<div />' } })
);

const currentUserId = 1;

const baseProps = {
  id: 10,
  conversationId: 3,
  status: MESSAGE_STATUS.SENT,
  content: 'Hello there',
  createdAt: 1_758_710_460,
  currentUserId,
};

const customerProps = {
  ...baseProps,
  messageType: MESSAGE_TYPES.INCOMING,
  senderType: 'Contact',
  senderId: 7,
  sender: { id: 7, type: 'contact', name: 'Maria Santos', thumbnail: '' },
};

const ownProps = {
  ...baseProps,
  messageType: MESSAGE_TYPES.OUTGOING,
  senderType: 'User',
  senderId: currentUserId,
  sender: { id: currentUserId, type: 'user', name: 'Carmel' },
};

const mountMessage = props =>
  mount(Message, {
    props,
    global: {
      mocks: {
        $store: {
          getters: new Proxy({}, { get: () => () => ({}) }),
          dispatch: vi.fn(),
        },
      },
      directives: { tooltip: {}, dompurifyHtml: {} },
      stubs: {
        MessageSenderAvatar: {
          props: ['name'],
          template: '<span data-test="avatar">{{ name }}</span>',
        },
        MessageMeta: {
          props: { compact: Boolean, hoverTime: Boolean },
          template:
            '<time data-test="meta" :data-compact="compact" :data-hover-time="hoverTime" />',
        },
        FormattedContent: {
          props: ['content'],
          template: '<span>{{ content }}</span>',
        },
        AttachmentChips: true,
        TranslationToggle: true,
      },
    },
  });

describe('Message layout', () => {
  it('puts a left message avatar in its own column beside the bubble', () => {
    const wrapper = mountMessage(customerProps);
    const avatarColumn = wrapper.find('[data-test="message-avatar-column"]');
    const column = wrapper.find('[data-test="message-column"]');

    const avatar = avatarColumn.find('[data-test="avatar"]');

    expect(avatarColumn.classes()).toContain('w-8');
    expect(avatar.text()).toBe('Maria Santos');
    expect(column.find('[data-test="avatar"]').exists()).toBe(false);
    expect(column.classes()).toContain('max-w-[70%]');
    expect(column.classes()).toContain('items-start');
  });

  it('shows the name and time in the header, not inside the bubble', () => {
    const wrapper = mountMessage(customerProps);
    const header = wrapper.find('[data-test="message-header"]');
    const bubble = wrapper.find('[data-test="message-bubble"]');
    const headerMeta = header.find('[data-test="meta"]');

    expect(header.text()).toContain('Maria Santos');
    expect(headerMeta.attributes('data-compact')).toBe('true');
    expect(bubble.text()).toContain('Hello there');
    expect(bubble.find('[data-test="meta"]').exists()).toBe(false);
  });

  it('hides avatar and header on a grouped follow-up message', () => {
    const wrapper = mountMessage({ ...customerProps, groupWithPrevious: true });
    const avatarColumn = wrapper.find('[data-test="message-avatar-column"]');

    expect(avatarColumn.exists()).toBe(true);
    expect(wrapper.find('[data-test="avatar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="message-header"]').exists()).toBe(false);
  });

  it('gives a grouped follow-up its own meta with the time on hover', () => {
    const wrapper = mountMessage({ ...ownProps, groupWithPrevious: true });
    const bubble = wrapper.find('[data-test="message-bubble"]');
    const meta = bubble.find('[data-test="message-follow-up-meta"]');

    const row = wrapper.find('[data-test="message-row"]');
    expect(row.classes()).toContain('group/message');
    expect(meta.exists()).toBe(true);
    expect(meta.attributes('data-hover-time')).toBe('true');
    expect(meta.classes()).toContain('order-first');
  });

  it('puts no follow-up meta on the first message of a group', () => {
    const wrapper = mountMessage(customerProps);
    const meta = wrapper.find('[data-test="message-follow-up-meta"]');
    expect(meta.exists()).toBe(false);
  });

  it('gives an own message no avatar, only the time above the bubble', () => {
    const wrapper = mountMessage(ownProps);
    const header = wrapper.find('[data-test="message-header"]');
    const avatarColumn = wrapper.find('[data-test="message-avatar-column"]');
    const column = wrapper.find('[data-test="message-column"]');

    expect(avatarColumn.exists()).toBe(false);
    expect(header.text()).not.toContain('Carmel');
    expect(header.find('[data-test="meta"]').exists()).toBe(true);
    expect(column.classes()).toContain('items-end');
  });

  it.each(['slack', 'teams', 'whatsapp', 'viber'])(
    'puts your own %s message on the right in a signal-green bubble',
    channel => {
      const wrapper = mountMessage({
        ...ownProps,
        conversationChannel: channel,
      });
      expect(wrapper.find('[data-test="message-row"]').classes()).toContain(
        'justify-end'
      );
      expect(wrapper.find('[data-test="message-avatar-column"]').exists()).toBe(
        false
      );
      const bubble = wrapper.find('[data-bubble-name="text"]');
      expect(bubble.classes()).toContain('bg-n-brand');
      expect(bubble.classes()).toContain('text-white');
    }
  );

  it('signs your own Slack message "You · time" on the right', () => {
    const wrapper = mountMessage({ ...ownProps, conversationChannel: 'slack' });
    const header = wrapper.find('[data-test="message-header"]');
    expect(header.classes()).toContain('justify-end');
    expect(header.find('[data-test="message-sender-name"]').text()).toBe(
      'CONVERSATION.KITA_YOU ·'
    );
    expect(header.find('[data-test="meta"]').exists()).toBe(true);
  });

  it('keeps others flush on the left in Slack, with avatar and name', () => {
    const wrapper = mountMessage({
      ...customerProps,
      conversationChannel: 'slack',
    });
    expect(wrapper.find('[data-test="message-avatar-column"]').exists()).toBe(
      true
    );
    expect(wrapper.find('[data-test="message-sender-name"]').text()).toBe(
      'Maria Santos'
    );
    expect(wrapper.find('[data-test="message-column"]').classes()).toContain(
      'flex-1'
    );
    expect(wrapper.find('[data-bubble-name="text"]').classes()).not.toContain(
      'bg-n-brand'
    );
  });

  it('tags external people and Kita teammates, on the left in grey and light green', () => {
    const external = mountMessage({
      ...customerProps,
      conversationChannel: 'slack',
      sender: { ...customerProps.sender, name: 'Carmel' },
    });
    expect(external.find('[data-test="message-external-tag"]').text()).toBe(
      'CONVERSATION.KITA_EXTERNAL_TAG'
    );
    expect(external.find('[data-test="message-teammate-tag"]').exists()).toBe(
      false
    );
    expect(external.find('[data-bubble-name="text"]').classes()).toContain(
      'kita-bubble-external'
    );

    const teammate = mountMessage({
      ...ownProps,
      senderId: 2,
      sender: { id: 2, type: 'user', name: 'Rhea' },
      conversationChannel: 'teams',
    });
    expect(teammate.find('[data-test="message-teammate-tag"]').exists()).toBe(
      true
    );
    expect(teammate.find('[data-test="message-external-tag"]').exists()).toBe(
      false
    );
    expect(teammate.find('[data-test="message-row"]').classes()).toContain(
      'justify-start'
    );
    expect(teammate.find('[data-bubble-name="text"]').classes()).toContain(
      'kita-bubble-teammate'
    );
  });

  it('names an external sender in the mirror footer', () => {
    const wrapper = mountMessage({
      ...customerProps,
      conversationChannel: 'whatsapp',
    });
    expect(wrapper.find('[data-test="message-footer"]').text()).toMatch(
      /^Maria · CONVERSATION.KITA_EXTERNAL_TAG · /
    );
  });

  it('shows a failed send as a full-width strip with Retry and Connect', async () => {
    const wrapper = mountMessage({
      ...ownProps,
      conversationChannel: 'slack',
      status: MESSAGE_STATUS.FAILED,
      createdAt: Math.floor(Date.now() / 1000),
      contentAttributes: { externalError: 'not_connected' },
    });
    const strip = wrapper.find('[data-test="message-strip"]');
    expect(strip.exists()).toBe(true);
    expect(strip.attributes('data-tone')).toBe('error');
    // a sibling of the message row, spanning the pane
    expect(strip.element.parentElement).toBe(wrapper.element);
    expect(strip.classes()).toContain('w-full');
    expect(strip.find('[data-test="message-strip-text"]').text()).toBe(
      'CONVERSATION.KITA_STRIP.NOT_SENT'
    );
    expect(strip.find('[data-test="message-strip-connect"]').exists()).toBe(
      true
    );
    await strip.find('[data-test="message-strip-retry"]').trigger('click');
    expect(wrapper.emitted('retry')).toHaveLength(1);
  });

  it('renders the bridge "not sent" note as a strip, not a bubble', () => {
    const wrapper = mountMessage({
      ...ownProps,
      private: true,
      conversationChannel: 'slack',
      content: 'Not sent — connect your Slack account first.',
      contentAttributes: {
        kitaNotice: 'not_sent',
        kitaNoticeReason: 'not_connected',
        externalSource: 'slack',
      },
    });
    expect(wrapper.find('[data-test="message-row"]').exists()).toBe(false);
    const strip = wrapper.find('[data-test="message-strip"]');
    expect(strip.attributes('data-tone')).toBe('error');
    expect(strip.find('[data-test="message-strip-connect"]').exists()).toBe(
      true
    );
    expect(strip.find('[data-test="message-strip-retry"]').exists()).toBe(
      false
    );
  });

  it('renders the mirror reminder as a subtle strip', () => {
    const wrapper = mountMessage({
      ...ownProps,
      private: true,
      conversationChannel: 'whatsapp',
      content:
        'Reply in WhatsApp yourself — this inbox is a mirror. Nothing typed here is sent to the customer.',
    });
    expect(
      wrapper.find('[data-test="message-strip"]').attributes('data-tone')
    ).toBe('info');
  });

  it('closes a WhatsApp mirror group with a footer, not a header', () => {
    const wrapper = mountMessage({
      ...customerProps,
      conversationChannel: 'whatsapp',
    });

    expect(wrapper.find('[data-test="message-avatar-column"]').exists()).toBe(
      false
    );
    expect(wrapper.find('[data-test="message-header"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="message-footer"]').text()).toMatch(
      /^Maria · /
    );
  });

  it('signs your own mirror message as sent from your phone', () => {
    const wrapper = mountMessage({
      ...ownProps,
      conversationChannel: 'whatsapp',
    });
    const footer = wrapper.find('[data-test="message-footer"]').text();

    expect(footer).toMatch(
      /^CONVERSATION.KITA_YOU · CONVERSATION.KITA_FROM_PHONE · /
    );
  });
});
