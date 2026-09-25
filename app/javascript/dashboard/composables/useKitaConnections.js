import { ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import KitaConnectionsAPI from 'dashboard/api/kitaConnections';

// Shared across the connect prompt and every reply box
const status = ref(null);
let pending = null;

const fetchStatus = () => {
  pending ??= Promise.resolve()
    .then(() => KitaConnectionsAPI.get())
    .then(({ data }) => {
      status.value = data;
    })
    .catch(() => {
      status.value = null;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
};

/**
 * The current agent's Slack/Teams/WhatsApp/Viber connection status, refreshed
 * whenever the window regains focus (e.g. after connecting in another tab).
 */
export const useKitaConnections = () => {
  if (!status.value) fetchStatus();
  useEventListener(window, 'focus', fetchStatus);
  return { status, fetchStatus };
};
