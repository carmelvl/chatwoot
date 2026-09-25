<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { useAdmin } from 'dashboard/composables/useAdmin';
import KitaLinkCustomerModal from './KitaLinkCustomerModal.vue';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { shortTimestamp, dynamicTime } from 'shared/helpers/timeHelper';
import {
  customerLabel,
  customerPreview,
  firstName,
  sectionCustomers,
} from './customersHelper';

defineProps({
  customerId: { type: String, default: '' },
});

const REFRESH_MS = 30_000;

const { t } = useI18n();
const store = useStore();
const router = useRouter();
const platformName = useKitaPlatformName();
const currentUser = useMapGetter('getCurrentUser');
const accountId = useMapGetter('getCurrentAccountId');

const scope = ref('mine');
const customers = computed(() =>
  store.getters['kitaCustomers/getCustomers'](scope.value)
);
const sections = computed(() => sectionCustomers(customers.value));

const fetchCustomers = async () => {
  try {
    await store.dispatch('kitaCustomers/get', { mine: scope.value === 'mine' });
  } catch {
    useAlert(t('KITA_CUSTOMERS.FETCH_ERROR'));
  }
};

const setScope = value => {
  if (scope.value === value) return;
  scope.value = value;
  fetchCustomers();
};

let timer;
onMounted(() => {
  fetchCustomers();
  timer = setInterval(fetchCustomers, REFRESH_MS);
});
onUnmounted(() => clearInterval(timer));

const preview = customer =>
  customerPreview(customer, {
    platformName,
    you: t('KITA_CUSTOMERS.YOU'),
    currentUserName: currentUser.value?.name,
  });

// Muted line: "Slack · Rhea" (the platform of the latest message and the DRI)
const detail = customer =>
  [
    platformName(customer.last_message?.platform || customer.platforms[0]),
    firstName(customer.dri_name),
  ]
    .filter(Boolean)
    .join(' · ');

const relativeTime = customer =>
  customer.last_activity_at
    ? shortTimestamp(dynamicTime(customer.last_activity_at))
    : '';

// "Link to customer" on an unlinked channel (admins: Grip only lets admins link)
const { isAdmin } = useAdmin();
const linkTarget = ref(null);
const linkModal = ref(null);
const startLink = async customer => {
  linkTarget.value = customer;
  await nextTick();
  linkModal.value?.open();
};

const openCustomer = customer => {
  const [latest] = customer.conversations || [];
  router.push(
    latest
      ? {
          name: 'kita_customer_conversation',
          params: {
            accountId: accountId.value,
            customerId: customer.id,
            conversation_id: latest.id,
          },
        }
      : {
          name: 'kita_customer',
          params: { accountId: accountId.value, customerId: customer.id },
        }
  );
};
</script>

<template>
  <section
    class="flex flex-col h-full min-h-0 w-[320px] min-w-[320px] ltr:border-r rtl:border-l border-n-weak bg-n-surface-1"
    data-test-id="kita-customers-list"
  >
    <header class="px-6 pt-7">
      <div class="flex items-baseline justify-between">
        <h1 class="m-0 text-2xl font-bold font-interDisplay text-n-slate-12">
          {{ t('KITA_CUSTOMERS.TITLE') }}
        </h1>
        <span class="text-sm text-n-slate-11">{{ customers.length }}</span>
      </div>
      <div class="flex gap-5 mt-4 border-b border-n-weak">
        <button
          v-for="tab in ['mine', 'all']"
          :key="tab"
          type="button"
          class="pb-2 -mb-px text-sm border-b-2"
          :class="
            scope === tab
              ? 'font-medium text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent'
          "
          @click="setScope(tab)"
        >
          {{
            tab === 'mine'
              ? t('KITA_CUSTOMERS.MINE_TAB')
              : t('KITA_CUSTOMERS.ALL_TAB')
          }}
        </button>
      </div>
    </header>
    <div class="flex-1 min-h-0 px-3 pb-4 overflow-y-auto">
      <p
        v-if="!customers.length"
        class="px-3 py-6 text-sm text-center text-n-slate-11"
      >
        {{ t('KITA_CUSTOMERS.EMPTY') }}
      </p>
      <template v-for="section in sections" :key="section.key">
        <p
          class="px-3 pt-6 pb-2 m-0 text-xs font-medium tracking-widest uppercase text-n-slate-11"
        >
          {{ t(`KITA_CUSTOMERS.SECTIONS.${section.key}`) }}
        </p>
        <div
          v-for="customer in section.customers"
          :key="customer.id"
          class="flex flex-col"
        >
          <button
            type="button"
            data-test="kita-customer-row"
            class="flex flex-col w-full gap-1 px-3 py-3 text-start rounded-xl"
            :class="
              String(customer.id) === customerId
                ? 'bg-n-blue-2 outline outline-1 outline-n-blue-4'
                : 'hover:bg-n-alpha-1'
            "
            @click="openCustomer(customer)"
          >
            <span class="flex items-baseline justify-between gap-2">
              <span class="text-sm font-semibold truncate text-n-slate-12">
                {{ customerLabel(customer, t('KITA_CUSTOMERS.UNLINKED')) }}
              </span>
              <span class="text-xs text-n-slate-11 shrink-0">
                {{ relativeTime(customer) }}
              </span>
            </span>
            <span
              v-if="preview(customer)"
              class="text-sm text-n-slate-11 line-clamp-2"
            >
              {{ preview(customer) }}
            </span>
            <span
              v-if="customer.urgent_ticket"
              class="text-xs font-medium text-n-ruby-11"
            >
              {{ t('KITA_CUSTOMERS.URGENT_TICKET') }}
            </span>
            <span v-else-if="detail(customer)" class="text-xs text-n-slate-11">
              {{ detail(customer) }}
            </span>
          </button>
          <button
            v-if="customer.unlinked && isAdmin"
            type="button"
            data-test="kita-link-customer"
            class="self-start px-3 pb-2 -mt-1 text-xs font-medium text-n-blue-11 hover:underline"
            @click="startLink(customer)"
          >
            {{ t('KITA_CUSTOMERS.LINK_TO_CUSTOMER') }}
          </button>
        </div>
      </template>
    </div>
    <KitaLinkCustomerModal
      v-if="linkTarget"
      ref="linkModal"
      :conversation-id="linkTarget.conversations[0].id"
      :label="linkTarget.name"
    />
  </section>
</template>
