<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEventListener } from '@vueuse/core';
import Dialog from 'dashboard/components-next/dialog/Dialog.vue';
import ConnectAccounts from './ConnectAccounts.vue';
import KitaConnectionsAPI from 'dashboard/api/kitaConnections';
import { useUISettings } from 'dashboard/composables/useUISettings';
import { useEmitter } from 'dashboard/composables/emitter';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import {
  KITA_CONNECT_SKIP_KEY,
  openKitaConnect,
  shouldPromptKitaConnect,
} from 'dashboard/helper/kitaConnect';

const { t } = useI18n();
const { uiSettings, updateUISettings } = useUISettings();

const dialogRef = ref(null);
const status = ref(null);
const isOpen = ref(false);
// true when shown as the one-time login prompt, false when opened from the menu
const isPrompt = ref(false);

const fetchStatus = async () => {
  try {
    const { data } = await KitaConnectionsAPI.get();
    status.value = data;
  } catch {
    status.value = null;
  }
};

const openDialog = prompt => {
  isPrompt.value = prompt;
  isOpen.value = true;
  dialogRef.value?.open();
};

const openFromMenu = async () => {
  openDialog(false);
  await fetchStatus();
};

const onClose = () => {
  if (isPrompt.value) {
    updateUISettings({ [KITA_CONNECT_SKIP_KEY]: new Date().toISOString() });
  }
  isOpen.value = false;
  isPrompt.value = false;
};

useEmitter(BUS_EVENTS.OPEN_KITA_CONNECT, openFromMenu);

useEventListener(window, 'focus', () => {
  if (isOpen.value) fetchStatus();
});

onMounted(async () => {
  await fetchStatus();
  const skippedAt = uiSettings.value?.[KITA_CONNECT_SKIP_KEY];
  if (!isOpen.value && shouldPromptKitaConnect(status.value, skippedAt)) {
    openDialog(true);
  }
});
</script>

<template>
  <Dialog
    ref="dialogRef"
    :title="t('KITA_CONNECT.TITLE')"
    :description="t('KITA_CONNECT.DESCRIPTION')"
    :confirm-button-label="t('KITA_CONNECT.CONNECT')"
    :cancel-button-label="
      isPrompt ? t('KITA_CONNECT.SKIP') : t('KITA_CONNECT.CLOSE')
    "
    width="md"
    @confirm="openKitaConnect"
    @close="onClose"
  >
    <ConnectAccounts :status="status" />
  </Dialog>
</template>
