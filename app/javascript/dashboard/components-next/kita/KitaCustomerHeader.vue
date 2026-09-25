<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { vOnClickOutside } from '@vueuse/components';
import { useMapGetter } from 'dashboard/composables/store';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import {
  KITA_SNOOZE_OPTIONS,
  useKitaAccountActions,
} from 'dashboard/composables/useKitaAccountActions';
import MoreActions from 'dashboard/components/widgets/conversation/MoreActions.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import Dialog from 'dashboard/components-next/dialog/Dialog.vue';
import DropdownMenu from 'dashboard/components-next/dropdown-menu/DropdownMenu.vue';
import ChannelIcon from 'next/icon/ChannelIcon.vue';
import { useAdmin } from 'dashboard/composables/useAdmin';
import KitaLinkCustomerModal from './KitaLinkCustomerModal.vue';
import PlatformLogo from './PlatformLogo.vue';
import { driLabel, gripAccountUrl } from './customersHelper';
import {
  TICKETS_TAB,
  listQuery,
  platformTabs,
} from 'dashboard/helper/kitaInbox';

const props = defineProps({
  customer: { type: Object, default: null },
  customerId: { type: String, required: true },
  tab: { type: String, default: '' },
  conversationId: { type: Number, default: 0 },
});

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const platformName = useKitaPlatformName();
const accountId = useMapGetter('getCurrentAccountId');
const inboxById = useMapGetter('inboxes/getInboxById');
const { act, snooze } = useKitaAccountActions();
const { isAdmin } = useAdmin();

const kind = computed(() => props.customer?.kind ?? 'customer');
const isUnlinked = computed(() => kind.value === 'unlinked');

const tabs = computed(() =>
  platformTabs(props.customer).map(tab => {
    const conversations = (props.customer?.conversations || []).filter(
      conversation => (conversation.platform || 'conversation') === tab.key
    );
    return {
      ...tab,
      title: platformName(tab.platform) || tab.conversation.label,
      detail: tab.platform ? tab.conversation.label : null,
      inbox: tab.platform ? null : inboxById.value(tab.conversation.inbox_id),
      unreadCount: conversations.reduce(
        (sum, conversation) => sum + (conversation.unread_count || 0),
        0
      ),
    };
  })
);

const subline = computed(() => {
  const customer = props.customer;
  if (!customer) return '';
  if (isUnlinked.value) {
    return [
      platformName(customer.platforms?.[0]),
      t('KITA_CUSTOMERS.UNLINKED_SUBLINE'),
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind.value === 'conversation') {
    return inboxById.value(customer.conversations?.[0]?.inbox_id)?.name || '';
  }
  const count = tabs.value.length;
  return [
    customer.dri_name || customer.dri_email
      ? t('KITA_CUSTOMERS.OWNED_BY', { name: driLabel(customer) })
      : null,
    t('KITA_CUSTOMERS.CHANNEL_COUNT', { count }, count),
  ]
    .filter(Boolean)
    .join(' · ');
});

const gripUrl = computed(() => gripAccountUrl(props.customer));
const openTickets = computed(() => props.customer?.open_tickets || 0);
const hasOpenConversation = computed(() =>
  (props.customer?.conversations || []).some(
    conversation => conversation.status !== 'resolved'
  )
);

const openTab = key => {
  if (key === props.tab) return;
  router.push({
    name: 'kita_inbox_customer',
    params: {
      accountId: accountId.value,
      customerId: props.customerId,
      tab: key,
    },
    query: listQuery(route.query),
  });
};

// Resolve all: asks first when it would close open tickets too
const resolveDialog = ref(null);
const ids = computed(() => [props.customerId]);
const resolveAll = () => {
  if (openTickets.value) {
    resolveDialog.value?.open();
    return;
  }
  act(ids.value, 'resolve');
};
const confirmResolveAll = async () => {
  resolveDialog.value?.close();
  await act(ids.value, 'resolve', { close_tickets: true });
};

const showSnooze = ref(false);
const snoozeItems = computed(() =>
  KITA_SNOOZE_OPTIONS.map(option => ({
    label: t(`KITA_INBOX.SNOOZE.${option}`),
    value: option,
    action: 'snooze',
  }))
);
const onSnooze = ({ value }) => {
  showSnooze.value = false;
  snooze(ids.value, value);
};

const linkModal = ref(null);
</script>

<template>
  <header
    class="px-10 pt-7 border-b border-n-weak"
    data-test-id="kita-customer-header"
  >
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0">
        <div class="flex items-center gap-3 min-w-0">
          <h2
            class="m-0 text-3xl font-bold truncate font-interDisplay text-n-slate-12"
          >
            {{ customer?.name || '' }}
          </h2>
          <span
            v-if="customer?.stage"
            class="px-2 py-0.5 text-xs font-medium rounded-full bg-woot-50 text-woot-700 dark:bg-n-alpha-2 dark:text-n-slate-12 shrink-0"
          >
            {{ customer.stage }}
          </span>
        </div>
        <p v-if="subline" class="mt-1 mb-0 text-sm text-n-slate-11">
          {{ subline }}
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <a
          v-if="gripUrl"
          :href="gripUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-sm font-medium text-n-slate-12 hover:underline"
        >
          {{ t('KITA_CUSTOMERS.OPEN_IN_GRIP') }}
        </a>
        <Button
          v-if="isUnlinked && isAdmin && conversationId"
          :label="t('KITA_CUSTOMERS.LINK_TO_CUSTOMER')"
          size="sm"
          data-test-id="kita-header-link-customer"
          @click="linkModal?.open()"
        />
        <div v-on-click-outside="() => (showSnooze = false)" class="relative">
          <Button
            :label="t('KITA_INBOX.SNOOZE_ALL')"
            size="sm"
            variant="outline"
            color="slate"
            icon="i-lucide-alarm-clock"
            data-test-id="kita-snooze-all"
            @click="showSnooze = !showSnooze"
          />
          <DropdownMenu
            v-if="showSnooze"
            :menu-items="snoozeItems"
            class="mt-1 top-full ltr:right-0 rtl:left-0 min-w-48"
            @action="onSnooze"
          />
        </div>
        <Button
          v-if="hasOpenConversation"
          :label="t('KITA_INBOX.RESOLVE_ALL')"
          size="sm"
          data-test-id="kita-resolve-all"
          @click="resolveAll"
        />
        <Button
          v-else
          :label="t('KITA_INBOX.REOPEN_ALL')"
          size="sm"
          variant="outline"
          color="slate"
          @click="act(ids, 'reopen')"
        />
        <MoreActions
          v-if="conversationId && tab !== TICKETS_TAB"
          :conversation-id="conversationId"
        />
      </div>
    </div>
    <nav class="flex gap-7 mt-5 -mb-px overflow-x-auto no-scrollbar">
      <button
        v-for="item in tabs"
        :key="item.key"
        type="button"
        data-test="kita-conversation-tab"
        class="flex items-center gap-1.5 pb-3 text-sm border-b-2 shrink-0"
        :class="
          item.key === tab
            ? 'font-medium text-n-slate-12 border-n-slate-12'
            : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
        "
        @click="openTab(item.key)"
      >
        <PlatformLogo
          v-if="item.platform"
          :platform="item.platform"
          class="size-4"
        />
        <ChannelIcon
          v-else-if="item.inbox"
          :inbox="item.inbox"
          class="size-4 text-n-slate-11"
        />
        <span>{{ item.title }}</span>
        <span v-if="item.detail" class="font-normal text-n-slate-11">
          {{ item.detail }}
        </span>
        <span
          v-if="item.unreadCount && item.key !== tab"
          :title="t('KITA_CUSTOMERS.UNREAD', { count: item.unreadCount })"
          class="grid px-1 text-xs font-medium text-white rounded-full min-w-4 h-4 place-content-center bg-n-brand"
        >
          {{ item.unreadCount }}
        </span>
      </button>
      <button
        type="button"
        data-test="kita-tickets-tab"
        class="flex items-center gap-1.5 pb-3 text-sm border-b-2 shrink-0"
        :class="
          tab === TICKETS_TAB
            ? 'font-medium text-n-slate-12 border-n-slate-12'
            : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
        "
        @click="openTab(TICKETS_TAB)"
      >
        <span class="i-lucide-ticket size-4" />
        <span>{{ t('KITA_CUSTOMERS.TICKETS_TAB') }}</span>
        <span class="font-normal text-n-slate-11">
          {{ t('KITA_CUSTOMERS.TICKETS_OPEN', { count: openTickets }) }}
        </span>
      </button>
    </nav>
    <KitaLinkCustomerModal
      v-if="isUnlinked && conversationId"
      ref="linkModal"
      :conversation-id="conversationId"
      :label="customer.name"
    />
    <Dialog
      ref="resolveDialog"
      type="alert"
      :title="t('KITA_INBOX.RESOLVE_ALL_CONFIRM.TITLE')"
      :description="
        t(
          'KITA_INBOX.RESOLVE_ALL_CONFIRM.DESCRIPTION',
          { count: openTickets },
          openTickets
        )
      "
      :confirm-button-label="t('KITA_INBOX.RESOLVE_ALL_CONFIRM.CONFIRM')"
      @confirm="confirmResolveAll"
    />
  </header>
</template>
