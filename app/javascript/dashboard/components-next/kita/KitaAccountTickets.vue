<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKitaTickets } from 'dashboard/composables/useKitaTickets';
import { DEFAULT_TICKET_FILTERS } from 'dashboard/helper/kitaTickets';
import KitaTicketsTable from './KitaTicketsTable.vue';

// A customer's Tickets tab: every ticket across its platforms, open first
const props = defineProps({
  customerId: { type: String, required: true },
});

const { t } = useI18n();
const { tickets, isFetching, fetchTickets, openTicket, setTicketStatus } =
  useKitaTickets();
const now = ref(Math.floor(Date.now() / 1000));

const load = () =>
  fetchTickets({
    ...DEFAULT_TICKET_FILTERS,
    status: 'all',
    customerId: props.customerId,
  });

onMounted(load);
watch(() => props.customerId, load);
</script>

<template>
  <section
    class="flex-1 min-h-0 px-10 py-6 overflow-y-auto"
    data-test-id="kita-account-tickets"
  >
    <p
      v-if="!isFetching && !tickets.length"
      class="py-10 text-sm text-center text-n-slate-11"
    >
      {{ t('KITA_TICKETS.EMPTY_CUSTOMER') }}
    </p>
    <KitaTicketsTable
      v-else
      :tickets="tickets"
      :show-customer="false"
      :now="now"
      @open="openTicket"
      @set-status="setTicketStatus"
    />
  </section>
</template>
