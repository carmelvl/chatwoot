<script setup>
import { useI18n } from 'vue-i18n';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { isOpenTicket, isPressingTicket } from 'dashboard/helper/kitaThreads';
import { ticketLabel } from 'dashboard/helper/kitaTickets';
import { shortDuration } from 'dashboard/helper/kitaInbox';
import PlatformLogo from './PlatformLogo.vue';

// Grip tickets (GET /kita/tickets rows): the Tickets page and a customer's
// Tickets tab. A row opens its thread; Resolve/Reopen moves the ticket too.
defineProps({
  tickets: { type: Array, required: true },
  showCustomer: { type: Boolean, default: true },
  now: { type: Number, required: true },
});

const emit = defineEmits(['open', 'setStatus']);

const { t } = useI18n();
const platformName = useKitaPlatformName();

const statusLabel = status =>
  t(`KITA_THREADS.TICKET_STATUS.${status}`) || status;
</script>

<template>
  <table class="w-full text-sm table-fixed" data-test-id="kita-tickets-table">
    <thead>
      <tr class="text-xs font-medium tracking-wide uppercase text-n-slate-11">
        <th class="w-24 py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.ID') }}
        </th>
        <th class="py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.TITLE') }}
        </th>
        <th v-if="showCustomer" class="w-44 py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.CUSTOMER') }}
        </th>
        <th class="w-24 py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.PRIORITY') }}
        </th>
        <th class="py-2 font-medium w-36 text-start">
          {{ t('KITA_TICKETS.COLUMNS.STATUS') }}
        </th>
        <th class="w-32 py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.OWNER') }}
        </th>
        <th class="w-16 py-2 font-medium text-start">
          {{ t('KITA_TICKETS.COLUMNS.AGE') }}
        </th>
        <th class="py-2 font-medium w-44 text-end" />
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="ticket in tickets"
        :key="ticket.id"
        data-test="kita-ticket-row"
        class="border-t cursor-pointer border-n-weak hover:bg-n-alpha-1"
        @click="emit('open', ticket)"
      >
        <td class="py-3 font-medium truncate text-n-slate-12">
          {{ ticketLabel(ticket) }}
        </td>
        <td class="py-3 pe-4">
          <span class="flex items-center min-w-0 gap-2">
            <PlatformLogo
              v-if="ticket.platform"
              :platform="ticket.platform"
              :title="platformName(ticket.platform)"
              class="size-4 shrink-0"
            />
            <span class="truncate text-n-slate-12">{{ ticket.title }}</span>
          </span>
        </td>
        <td v-if="showCustomer" class="py-3 truncate pe-4 text-n-slate-12">
          {{ ticket.customer_name }}
        </td>
        <td class="py-3">
          <span
            v-if="ticket.priority"
            class="px-2 py-0.5 text-xs font-medium rounded-md"
            :class="
              isPressingTicket(ticket)
                ? 'bg-n-ruby-3 text-n-ruby-11'
                : 'bg-n-alpha-2 text-n-slate-11'
            "
          >
            {{ t(`KITA_THREADS.PRIORITY.${ticket.priority}`) }}
          </span>
        </td>
        <td class="py-3 truncate text-n-slate-11">
          {{ statusLabel(ticket.status) }}
        </td>
        <td class="py-3 truncate text-n-slate-11">
          {{ ticket.owner || t('KITA_TICKETS.UNOWNED') }}
        </td>
        <td class="py-3 text-n-slate-11">
          {{ shortDuration(Math.max(0, now - ticket.created_at)) }}
        </td>
        <td class="py-3 text-end" @click.stop>
          <span class="inline-flex items-center gap-3">
            <button
              type="button"
              class="text-xs font-medium text-n-slate-11 hover:text-n-slate-12"
              data-test="kita-ticket-status"
              @click="
                emit(
                  'setStatus',
                  ticket,
                  isOpenTicket(ticket) ? 'resolved' : 'open'
                )
              "
            >
              {{
                isOpenTicket(ticket)
                  ? t('KITA_TICKETS.RESOLVE')
                  : t('KITA_TICKETS.REOPEN')
              }}
            </button>
            <a
              v-if="ticket.url"
              :href="ticket.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs font-medium text-n-slate-12 hover:underline"
            >
              {{ t('KITA_CUSTOMERS.OPEN_IN_GRIP') }}
            </a>
          </span>
        </td>
      </tr>
    </tbody>
  </table>
</template>
