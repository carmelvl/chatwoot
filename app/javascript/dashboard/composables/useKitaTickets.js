import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import KitaInboxAPI from 'dashboard/api/kitaInbox';
import KitaThreadsAPI from 'dashboard/api/kitaThreads';
import { ticketsQuery } from 'dashboard/helper/kitaTickets';

/**
 * Kita tickets (GET /kita/tickets) for the Tickets page and a customer's
 * Tickets tab: loading, opening a ticket's thread, resolving/reopening.
 */
export const useKitaTickets = () => {
  const { t } = useI18n();
  const router = useRouter();
  const accountId = useMapGetter('getCurrentAccountId');
  const tickets = ref([]);
  const isFetching = ref(false);

  const fetchTickets = async filters => {
    isFetching.value = true;
    try {
      const { data } = await KitaInboxAPI.tickets(ticketsQuery(filters));
      tickets.value = data.payload;
    } catch {
      useAlert(t('KITA_TICKETS.FETCH_ERROR'));
    } finally {
      isFetching.value = false;
    }
  };

  // The customer view on the ticket's platform tab, with its thread open
  const openTicket = ticket =>
    router.push({
      name: 'kita_inbox_thread',
      params: {
        accountId: accountId.value,
        customerId: ticket.customer_id,
        tab: ticket.platform || 'conversation',
        threadId: String(ticket.root_message_id),
      },
      query: { c: String(ticket.conversation_id) },
    });

  const setTicketStatus = async (ticket, status) => {
    try {
      const { data } = await KitaThreadsAPI.updateStatus(
        ticket.conversation_id,
        ticket.root_message_id,
        status
      );
      if (data.ticket_synced === false) {
        useAlert(t('KITA_THREADS.TICKET_SYNC_ERROR'));
        return;
      }
      ticket.status = status;
    } catch {
      useAlert(t('KITA_THREADS.STATUS_ERROR'));
    }
  };

  return { tickets, isFetching, fetchTickets, openTicket, setTicketStatus };
};
