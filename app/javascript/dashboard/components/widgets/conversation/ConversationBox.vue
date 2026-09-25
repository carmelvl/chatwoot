<script>
import { mapGetters } from 'vuex';
import ConversationHeader from './ConversationHeader.vue';
import DashboardAppFrame from '../DashboardApp/Frame.vue';
import MessagesView from './MessagesView.vue';
import KitaCustomerHeader from 'dashboard/components-next/kita/KitaCustomerHeader.vue';
import KitaAccountTickets from 'dashboard/components-next/kita/KitaAccountTickets.vue';
import KitaInboxEmpty from 'dashboard/components-next/kita/KitaInboxEmpty.vue';
import { TICKETS_TAB } from 'dashboard/helper/kitaInbox';

// Kita: every conversation opens under its customer's header (platform tabs
// plus Tickets); the Tickets tab lists the customer's tickets instead of the
// messages. With nothing open, a friendly Inbox-zero state. Chatwoot's
// notifications page (isInboxView) keeps the classic header.
export default {
  components: {
    ConversationHeader,
    DashboardAppFrame,
    MessagesView,
    KitaCustomerHeader,
    KitaAccountTickets,
    KitaInboxEmpty,
  },
  props: {
    customer: {
      type: Object,
      default: null,
    },
    customerId: {
      type: String,
      default: '',
    },
    tab: {
      type: String,
      default: '',
    },
    inboxId: {
      type: [Number, String],
      default: '',
      required: false,
    },
    isInboxView: {
      type: Boolean,
      default: false,
    },
    isContactPanelOpen: {
      type: Boolean,
      default: true,
    },
    isOnExpandedLayout: {
      type: Boolean,
      default: true,
    },
  },
  data() {
    return { activeIndex: 0 };
  },
  computed: {
    ...mapGetters({
      currentChat: 'getSelectedChat',
      dashboardApps: 'dashboardApps/getRecords',
    }),
    dashboardAppTabs() {
      return [
        {
          key: 'messages',
          index: 0,
          name: this.$t('CONVERSATION.DASHBOARD_APP_TAB_MESSAGES'),
        },
        ...this.dashboardApps.map((dashboardApp, index) => ({
          key: `dashboard-${dashboardApp.id}`,
          index: index + 1,
          name: dashboardApp.title,
        })),
      ];
    },
    isTicketsTab() {
      return this.tab === TICKETS_TAB;
    },
    showContactPanel() {
      return this.isContactPanelOpen && this.currentChat.id;
    },
  },
  watch: {
    'currentChat.inbox_id': {
      immediate: true,
      handler() {
        if (this.currentChat.inbox_id && this.currentChat.id) {
          this.$store.dispatch('inboxAssignableAgents/fetch', {
            inboxIds: [this.currentChat.inbox_id],
            includeAIAssignees: true,
          });
        }
      },
    },
    'currentChat.id'() {
      this.fetchLabels();
      this.activeIndex = 0;
    },
  },
  mounted() {
    this.fetchLabels();
    this.$store.dispatch('dashboardApps/get');
  },
  methods: {
    fetchLabels() {
      if (!this.currentChat.id) {
        return;
      }
      this.$store.dispatch('conversationLabels/get', this.currentChat.id);
    },
    onDashboardAppTabChange(index) {
      this.activeIndex = index;
    },
  },
};
</script>

<template>
  <div
    class="conversation-details-wrap flex flex-col min-w-0 w-full bg-n-surface-1 relative"
    :class="{
      'border-l rtl:border-l-0 rtl:border-r border-n-weak': !isOnExpandedLayout,
    }"
  >
    <KitaCustomerHeader
      v-if="customerId && !isInboxView"
      :customer="customer"
      :customer-id="customerId"
      :tab="tab"
      :conversation-id="currentChat.id || 0"
    />
    <ConversationHeader
      v-else-if="currentChat.id"
      :chat="currentChat"
      :class="{
        'border-b border-b-n-weak !pt-2': !dashboardApps.length,
      }"
    />
    <woot-tabs
      v-if="dashboardApps.length && currentChat.id && !isTicketsTab"
      :index="activeIndex"
      class="h-10"
      @change="onDashboardAppTabChange"
    >
      <woot-tabs-item
        v-for="appTab in dashboardAppTabs"
        :key="appTab.key"
        :index="appTab.index"
        :name="appTab.name"
        :show-badge="false"
        is-compact
      />
    </woot-tabs>
    <div v-show="!activeIndex" class="flex h-full min-h-0 m-0">
      <KitaAccountTickets
        v-if="isTicketsTab && customerId"
        :customer-id="customerId"
      />
      <MessagesView
        v-else-if="currentChat.id && (!customerId || customer)"
        :inbox-id="inboxId"
        :is-inbox-view="isInboxView"
      />
      <KitaInboxEmpty v-else-if="!customerId && !isInboxView" />
      <slot />
    </div>
    <DashboardAppFrame
      v-for="(dashboardApp, index) in dashboardApps"
      v-show="activeIndex - 1 === index"
      :key="currentChat.id + '-' + dashboardApp.id"
      :is-visible="activeIndex - 1 === index"
      :config="dashboardApps[index].content"
      :position="index"
      :current-chat="currentChat"
    />
  </div>
</template>
