<script>
import { provide } from 'vue';
import { mapGetters } from 'vuex';
import { useUISettings } from 'dashboard/composables/useUISettings';
import {
  CONTACT_CONVERSATION_NAVIGATION,
  useContactConversationNavigation,
} from 'dashboard/composables/useContactConversationNavigation';
import { useAccount } from 'dashboard/composables/useAccount';
import ConversationBox from '../../../components/widgets/conversation/ConversationBox.vue';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import CmdBarConversationSnooze from 'dashboard/routes/dashboard/commands/CmdBarConversationSnooze.vue';
import { emitter } from 'shared/helpers/mitt';
import SidepanelSwitch from 'dashboard/components-next/Conversation/SidepanelSwitch.vue';
import ConversationSidebar from 'dashboard/components/widgets/conversation/ConversationSidebar.vue';
import KitaThreadPane from 'dashboard/components-next/kita/KitaThreadPane.vue';
import KitaInboxList from 'dashboard/components-next/kita/KitaInboxList.vue';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import {
  TICKETS_TAB,
  defaultTab,
  tabConversation,
} from 'dashboard/helper/kitaInbox';

// Kita: the one conversation view. The Inbox list on the left; a customer row
// opens with the customer header, a tab per platform (plus Tickets), the
// Slack-style list or WhatsApp/Viber mirror, and the thread pane or the
// conversation sidebar on the right. Classic conversations use the same shell.
export default {
  components: {
    ConversationBox,
    CmdBarConversationSnooze,
    SidepanelSwitch,
    ConversationSidebar,
    KitaThreadPane,
    KitaInboxList,
  },
  beforeRouteLeave(to, from, next) {
    if (this.conversationId) {
      this.$store.dispatch('clearSelectedState');
    }
    next();
  },
  props: {
    // An Inbox row id ('' = no row open)
    customerId: {
      type: String,
      default: '',
    },
    // A platform, 'conversation' (a non-bridge conversation) or 'tickets'
    tab: {
      type: String,
      default: '',
    },
    // Root message of the thread to open in the right pane
    threadId: {
      type: Number,
      default: 0,
    },
  },
  setup() {
    const { uiSettings } = useUISettings();
    const { accountId } = useAccount();
    const { openThread, openThreadPane, closeThreadPane } = useKitaThreads();
    provide(
      CONTACT_CONVERSATION_NAVIGATION,
      useContactConversationNavigation()
    );

    return {
      uiSettings,
      accountId,
      openThread,
      openThreadPane,
      closeThreadPane,
    };
  },
  computed: {
    ...mapGetters({
      chatList: 'getAllConversations',
      currentChat: 'getSelectedChat',
    }),
    customer() {
      return this.customerId
        ? this.$store.getters['kitaCustomers/getCustomer'](this.customerId)
        : null;
    },
    isTicketsTab() {
      return this.tab === TICKETS_TAB;
    },
    // The conversation on screen: the tab's (or the pinned ?c=) conversation;
    // the Tickets tab keeps the customer's default conversation for context
    conversationId() {
      if (!this.customer) return 0;
      const tab = this.isTicketsTab ? defaultTab(this.customer) : this.tab;
      return tabConversation(this.customer, tab, this.$route.query.c)?.id ?? 0;
    },
    // An open thread takes the contact sidebar's place
    kitaOpenThread() {
      const thread = this.openThread;
      return thread && thread.conversationId === this.currentChat.id
        ? thread
        : null;
    },
    shouldShowSidebar() {
      return !!this.currentChat.id && this.uiSettings.is_contact_sidebar_open;
    },
  },
  watch: {
    customerId: {
      handler(id) {
        if (id) this.fetchCustomer();
      },
      immediate: true,
    },
    customer: 'openDefaultTab',
    tab: 'openDefaultTab',
    conversationId: {
      handler() {
        this.fetchConversationIfUnavailable();
        this.setActiveChat();
      },
    },
    threadId: 'openRouteThread',
    'currentChat.id': 'openRouteThread',
    // The contact/copilot toggles bring the sidebar back over a thread
    'uiSettings.is_contact_sidebar_open': 'closeThreadPane',
    'uiSettings.is_copilot_panel_open': 'closeThreadPane',
  },

  created() {
    if (!this.customerId) {
      this.$store.dispatch('clearSelectedState');
    }
  },

  mounted() {
    this.$store.dispatch('agents/get');
    this.$store.dispatch('setActiveInbox', 0);
    this.$watch('chatList.length', () => this.setActiveChat());
    this.fetchConversationIfUnavailable();
    this.setActiveChat();
  },

  methods: {
    // The full row (every conversation of the customer, not just the ones the
    // list's filters matched)
    async fetchCustomer() {
      try {
        await this.$store.dispatch('kitaCustomers/show', this.customerId);
      } catch {
        this.$router.replace({
          name: 'kita_inbox',
          params: { accountId: this.accountId },
          query: this.$route.query,
        });
      }
    },
    // A row opened without a tab lands where the customer is waiting
    openDefaultTab() {
      if (!this.customer || this.tab) return;
      const pinned = (this.customer.conversations || []).find(
        conversation => String(conversation.id) === String(this.$route.query.c)
      );
      const tab = pinned
        ? pinned.platform || 'conversation'
        : defaultTab(this.customer);
      if (!tab) return;
      this.$router.replace({
        name: 'kita_inbox_customer',
        params: { ...this.$route.params, tab },
        query: this.$route.query,
      });
    },
    openRouteThread() {
      if (this.threadId && this.currentChat.id === this.conversationId) {
        this.openThreadPane(this.conversationId, this.threadId);
      } else if (!this.threadId) {
        this.closeThreadPane();
      }
    },
    fetchConversationIfUnavailable() {
      if (!this.conversationId || this.findConversation()) return;
      this.$store.dispatch('getConversation', this.conversationId);
    },
    findConversation() {
      return this.chatList.find(chat => chat.id === this.conversationId);
    },
    setActiveChat() {
      if (!this.conversationId) {
        if (!this.customerId) this.$store.dispatch('clearSelectedState');
        return;
      }
      const selected = this.findConversation();
      if (!selected || selected.id === this.currentChat.id) return;
      const { messageId } = this.$route.query;
      this.$store
        .dispatch('setActiveChat', { data: selected, after: messageId })
        .then(() => {
          emitter.emit(BUS_EVENTS.SCROLL_TO_MESSAGE, { messageId });
        });
    },
  },
};
</script>

<template>
  <section class="flex w-full h-full min-w-0">
    <KitaInboxList :customer-id="customerId" />
    <ConversationBox
      :customer="customer"
      :customer-id="customerId"
      :tab="tab"
      :is-on-expanded-layout="false"
    >
      <SidepanelSwitch v-if="currentChat.id && !isTicketsTab" />
    </ConversationBox>
    <KitaThreadPane
      v-if="kitaOpenThread"
      :key="kitaOpenThread.rootId"
      :conversation-id="kitaOpenThread.conversationId"
      :root-id="kitaOpenThread.rootId"
    />
    <ConversationSidebar
      v-else-if="shouldShowSidebar && !isTicketsTab"
      :current-chat="currentChat"
    />
    <CmdBarConversationSnooze />
  </section>
</template>
