<script setup>
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { useMapGetter } from 'dashboard/composables/store';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import MoreActions from 'dashboard/components/widgets/conversation/MoreActions.vue';
import {
  conversationTab,
  customerLabel,
  driLabel,
  gripAccountUrl,
} from './customersHelper';
import { openTicketCount } from 'dashboard/helper/kitaThreads';

const props = defineProps({
  customerId: { type: String, required: true },
  conversationId: { type: Number, required: true },
});

const { t } = useI18n();
const store = useStore();
const router = useRouter();
const platformName = useKitaPlatformName();
const accountId = useMapGetter('getCurrentAccountId');
const { threadsByConversation, showThreadsTab } = useKitaThreads();

const customer = computed(() =>
  store.getters['kitaCustomers/getCustomer'](props.customerId)
);

// Opened from a link to a customer outside "Mine": load everyone
watch(
  () => props.customerId,
  () => {
    if (!customer.value) store.dispatch('kitaCustomers/get').catch(() => {});
  },
  { immediate: true }
);

const tabs = computed(() =>
  (customer.value?.conversations || []).map(conversation =>
    conversationTab(conversation, platformName)
  )
);

const ticketCount = computed(() =>
  openTicketCount(threadsByConversation[props.conversationId] || [])
);

const subline = computed(() => {
  if (!customer.value) return '';
  const count = customer.value.conversations?.length || 0;
  return [
    customer.value.dri_name || customer.value.dri_email
      ? t('KITA_CUSTOMERS.OWNED_BY', { name: driLabel(customer.value) })
      : null,
    t('KITA_CUSTOMERS.CHANNEL_COUNT', { count }, count),
  ]
    .filter(Boolean)
    .join(' · ');
});

const gripUrl = computed(() => gripAccountUrl(customer.value));

const openConversation = id => {
  showThreadsTab.value = false;
  if (id === props.conversationId) return;
  router.push({
    name: 'kita_customer_conversation',
    params: {
      accountId: accountId.value,
      customerId: props.customerId,
      conversation_id: id,
    },
  });
};

const openTickets = () => {
  showThreadsTab.value = true;
};
</script>

<template>
  <header
    class="px-10 pt-7 border-b border-n-weak"
    data-test-id="kita-customer-header"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <h2
          class="m-0 text-3xl font-bold truncate font-interDisplay text-n-slate-12"
        >
          {{
            customer
              ? customerLabel(customer, t('KITA_CUSTOMERS.UNLINKED'))
              : ''
          }}
        </h2>
        <p v-if="subline" class="mt-1 mb-0 text-sm text-n-slate-11">
          {{ subline }}
        </p>
      </div>
      <div class="flex items-center gap-4 shrink-0">
        <a
          v-if="gripUrl"
          :href="gripUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm font-medium text-n-slate-12 hover:underline"
        >
          {{ t('KITA_CUSTOMERS.OPEN_IN_GRIP') }}
        </a>
        <MoreActions :conversation-id="conversationId" />
      </div>
    </div>
    <nav class="flex gap-7 mt-5 -mb-px">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        data-test="kita-conversation-tab"
        class="flex items-center gap-1.5 pb-3 text-sm border-b-2"
        :class="
          tab.id === conversationId && !showThreadsTab
            ? 'font-medium text-n-slate-12 border-n-slate-12'
            : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
        "
        @click="openConversation(tab.id)"
      >
        <span>{{ tab.title }}</span>
        <span v-if="tab.detail" class="font-normal text-n-slate-11">
          {{ tab.detail }}
        </span>
        <span
          v-if="tab.unreadCount && tab.id !== conversationId"
          :title="t('KITA_CUSTOMERS.UNREAD', { count: tab.unreadCount })"
          class="grid px-1 text-xs font-medium text-white rounded-full min-w-4 h-4 place-content-center bg-n-blue-9"
        >
          {{ tab.unreadCount }}
        </span>
      </button>
      <button
        type="button"
        data-test="kita-tickets-tab"
        class="flex items-center gap-1.5 pb-3 text-sm border-b-2"
        :class="
          showThreadsTab
            ? 'font-medium text-n-slate-12 border-n-slate-12'
            : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
        "
        @click="openTickets"
      >
        <span>{{ t('KITA_CUSTOMERS.TICKETS_TAB') }}</span>
        <span class="font-normal text-n-slate-11">
          {{ t('KITA_CUSTOMERS.TICKETS_OPEN', { count: ticketCount }) }}
        </span>
      </button>
    </nav>
  </header>
</template>
