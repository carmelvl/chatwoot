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

  it('lays a Slack message out flat, own message on the left as You', () => {
    const wrapper = mountMessage({ ...ownProps, conversationChannel: 'slack' });
    const avatarColumn = wrapper.find('[data-test="message-avatar-column"]');

    expect(avatarColumn.exists()).toBe(true);
    const name = wrapper.find('[data-test="message-sender-name"]');
    expect(name.text()).toBe('CONVERSATION.KITA_YOU');
    expect(wrapper.find('[data-test="message-column"]').classes()).toContain(
      'flex-1'
    );
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
