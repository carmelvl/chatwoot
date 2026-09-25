<script setup>
import { ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from 'dashboard/components-next/dialog/Dialog.vue';
import ConnectAccounts from './ConnectAccounts.vue';
import { useKitaConnections } from 'dashboard/composables/useKitaConnections';
import { useEmitter } from 'dashboard/composables/emitter';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import {
  openKitaConnect,
  shouldPromptKitaConnect,
} from 'dashboard/helper/kitaConnect';

const { t } = useI18n();
const { status, fetchStatus } = useKitaConnections();

const dialogRef = ref(null);
// Shown automatically once per session (every login) while a configured platform is not connected;
// closing it doesn't skip anything: the reply box stays gated until the agent connects.
const prompted = ref(false);

const openFromMenu = async () => {
  dialogRef.value?.open();
  await fetchStatus();
};

useEmitter(BUS_EVENTS.OPEN_KITA_CONNECT, openFromMenu);

const maybePrompt = () => {
  if (prompted.value || !shouldPromptKitaConnect(status.value)) return;
  prompted.value = true;
  dialogRef.value?.open();
};

watch(status, maybePrompt);
onMounted(maybePrompt);
</script>

<template>
  <Dialog
    ref="dialogRef"
    :title="t('KITA_CONNECT.TITLE')"
    :description="t('KITA_CONNECT.DESCRIPTION')"
    :confirm-button-label="t('KITA_CONNECT.CONNECT')"
    :cancel-button-label="t('KITA_CONNECT.CLOSE')"
    width="md"
    @confirm="openKitaConnect"
  >
    <ConnectAccounts :status="status" />
  </Dialog>
</template>
