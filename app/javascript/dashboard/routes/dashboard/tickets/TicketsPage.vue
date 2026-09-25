<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from 'vuex';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { useKitaTickets } from 'dashboard/composables/useKitaTickets';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import {
  DEFAULT_TICKET_FILTERS,
  TICKET_PRIORITIES,
  TICKET_SCOPES,
  TICKET_STATUSES,
} from 'dashboard/helper/kitaTickets';
import KitaFilterMenu from 'dashboard/components-next/kita/KitaFilterMenu.vue';
import KitaTicketsTable from 'dashboard/components-next/kita/KitaTicketsTable.vue';

// Kita: every Grip ticket across customers. A row opens the customer view with
// the ticket's thread; replies happen there.
const ANY = '__any__';

const { t } = useI18n();
const store = useStore();
const platformName = useKitaPlatformName();
const { tickets, isFetching, fetchTickets, openTicket, setTicketStatus } =
  useKitaTickets();

const filters = ref({ ...DEFAULT_TICKET_FILTERS });
const now = ref(Math.floor(Date.now() / 1000));
const customers = computed(() =>
  store.getters['kitaCustomers/getCustomers']('all').filter(
    customer => !customer.unlinked
  )
);

const load = () => {
  now.value = Math.floor(Date.now() / 1000);
  fetchTickets(filters.value);
};
watch(filters, load, { deep: true });
onMounted(() => {
  load();
  store.dispatch('kitaCustomers/get').catch(() => {});
});

const set = key => value => {
  filters.value = { ...filters.value, [key]: value === ANY ? null : value };
};
const anyItem = selected => ({
  label: t('KITA_INBOX.ANY'),
  value: ANY,
  isSelected: !selected,
});

const chips = computed(() => {
  const f = filters.value;
  const customer = customers.value.find(
    item => String(item.id) === f.customerId
  );
  return [
    {
      key: 'status',
      label: t(`KITA_TICKETS.STATUS.${f.status}`),
      active: f.status !== 'open',
      items: TICKET_STATUSES.map(status => ({
        label: t(`KITA_TICKETS.STATUS.${status}`),
        value: status,
        isSelected: status === f.status,
      })),
      select: set('status'),
    },
    {
      key: 'priority',
      label: f.priority
        ? t(`KITA_THREADS.PRIORITY.${f.priority}`)
        : t('KITA_INBOX.CHIPS.TICKET_PRIORITY'),
      active: !!f.priority,
      items: [
        anyItem(f.priority),
        ...TICKET_PRIORITIES.map(priority => ({
          label: t(`KITA_THREADS.PRIORITY.${priority}`),
          value: priority,
          isSelected: priority === f.priority,
        })),
      ],
      select: set('priority'),
    },
    {
      key: 'customer',
      label: customer?.name || t('KITA_TICKETS.CHIPS.CUSTOMER'),
      active: !!f.customerId,
      search: true,
      items: [
        anyItem(f.customerId),
        ...customers.value.map(item => ({
          label: item.name,
          value: String(item.id),
          isSelected: String(item.id) === f.customerId,
        })),
      ],
      select: set('customerId'),
    },
    {
      key: 'platform',
      label: f.platform
        ? platformName(f.platform)
        : t('KITA_INBOX.CHIPS.PLATFORM'),
      platform: f.platform,
      active: !!f.platform,
      items: [
        anyItem(f.platform),
        ...KITA_PLATFORMS.map(platform => ({
          label: platformName(platform),
          value: platform,
          platform,
          isSelected: platform === f.platform,
        })),
      ],
      select: set('platform'),
    },
  ];
});
</script>

<template>
  <section
    class="flex flex-col w-full h-full min-w-0 overflow-y-auto bg-n-surface-1"
    data-test-id="kita-tickets-page"
  >
    <header class="px-10 pt-8 pb-4">
      <div class="flex items-baseline justify-between">
        <h1 class="m-0 text-3xl font-bold font-interDisplay text-n-slate-12">
          {{ t('KITA_TICKETS.TITLE') }}
        </h1>
        <span class="text-sm text-n-slate-11">{{ tickets.length }}</span>
      </div>
      <p class="mt-1 mb-0 text-sm text-n-slate-11">
        {{ t('KITA_TICKETS.DESCRIPTION') }}
      </p>
      <nav class="flex gap-5 mt-5 border-b border-n-weak">
        <button
          v-for="scope in TICKET_SCOPES"
          :key="scope"
          type="button"
          data-test="kita-tickets-scope"
          class="pb-2 -mb-px text-sm border-b-2"
          :class="
            filters.scope === scope
              ? 'font-medium text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
          "
          @click="filters = { ...filters, scope }"
        >
          {{ t(`KITA_TICKETS.SCOPES.${scope}`) }}
        </button>
      </nav>
      <div class="flex flex-wrap items-center gap-1.5 pt-3">
        <KitaFilterMenu
          v-for="chip in chips"
          :key="chip.key"
          :label="chip.label"
          :items="chip.items"
          :active="chip.active"
          :platform="chip.platform"
          :show-search="chip.search"
          @select="chip.select"
        />
      </div>
    </header>
    <div class="px-10 pb-10">
      <p
        v-if="!isFetching && !tickets.length"
        class="py-10 text-sm text-center text-n-slate-11"
      >
        {{ t('KITA_TICKETS.EMPTY') }}
      </p>
      <KitaTicketsTable
        v-else
        :tickets="tickets"
        :now="now"
        @open="openTicket"
        @set-status="setTicketStatus"
      />
    </div>
  </section>
</template>
