<script>
import { mapGetters } from 'vuex';
import ConversationHeader from './ConversationHeader.vue';
import DashboardAppFrame from '../DashboardApp/Frame.vue';
import EmptyState from './EmptyState/EmptyState.vue';
import MessagesView from './MessagesView.vue';
import KitaThreadsTabs from 'dashboard/components-next/kita/KitaThreadsTabs.vue';
import KitaThreadsList from 'dashboard/components-next/kita/KitaThreadsList.vue';
import KitaCustomerHeader from 'dashboard/components-next/kita/KitaCustomerHeader.vue';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { isBridgeConversation } from 'dashboard/helper/kitaThreads';

export default {
  components: {
    ConversationHeader,
    DashboardAppFrame,
    EmptyState,
    MessagesView,
    KitaThreadsTabs,
    KitaThreadsList,
    KitaCustomerHeader,
  },
  props: {
    // Kita: the Customers workspace swaps the conversation header for the customer header
    customerId: {
      type: String,
      default: null,
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
  setup() {
    const { showThreadsTab } = useKitaThreads();
    return { showThreadsTab };
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
    isKitaBridge() {
      return !!this.currentChat.id && isBridgeConversation(this.currentChat);
    },
    isCustomerView() {
      return !!this.customerId && !!this.currentChat.id;
    },
    showKitaThreads() {
      return (this.isKitaBridge || this.isCustomerView) && this.showThreadsTab;
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
      v-if="isCustomerView"
      :customer-id="customerId"
      :conversation-id="currentChat.id"
    />
    <ConversationHeader
      v-else-if="currentChat.id"
      :chat="currentChat"
      :show-back-button="isOnExpandedLayout && !isInboxView"
      :class="{
        'border-b border-b-n-weak !pt-2': !dashboardApps.length,
      }"
    />
    <KitaThreadsTabs
      v-if="isKitaBridge && !isCustomerView && !activeIndex"
      :conversation-id="currentChat.id"
    />
    <woot-tabs
      v-if="dashboardApps.length && currentChat.id"
      :index="activeIndex"
      class="h-10"
      @change="onDashboardAppTabChange"
    >
      <woot-tabs-item
        v-for="tab in dashboardAppTabs"
        :key="tab.key"
        :index="tab.index"
        :name="tab.name"
        :show-badge="false"
        is-compact
      />
    </woot-tabs>
    <div v-show="!activeIndex" class="flex h-full min-h-0 m-0">
      <KitaThreadsList
        v-if="showKitaThreads"
        :conversation-id="currentChat.id"
        :tickets-only="isCustomerView"
      />
      <MessagesView
        v-if="currentChat.id"
        v-show="!showKitaThreads"
        :inbox-id="inboxId"
        :is-inbox-view="isInboxView"
      />
      <EmptyState
        v-if="!currentChat.id && !isInboxView"
        :is-on-expanded-layout="isOnExpandedLayout"
      />
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
