<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import PlatformLogo from './PlatformLogo.vue';

const props = defineProps({
  // Response of GET /api/v1/kita/connections; null when unavailable
  status: { type: Object, default: null },
});

const { t } = useI18n();

const linkStatusLabel = state => {
  const labels = {
    connected: t('KITA_CONNECT.STATUS.CONNECTED'),
    not_connected: t('KITA_CONNECT.STATUS.NOT_CONNECTED'),
  };
  return labels[state] || t('KITA_CONNECT.STATUS.UNAVAILABLE');
};

const whatsappNumber = computed(() => {
  const number = props.status?.whatsapp;
  return number && number !== 'none'
    ? number
    : t('KITA_CONNECT.WHATSAPP_NOT_LINKED');
});

const rows = computed(() => [
  {
    platform: 'slack',
    label: t('KITA_CONNECT.PLATFORMS.SLACK'),
    value: linkStatusLabel(props.status?.slack),
    isConnected: props.status?.slack === 'connected',
  },
  {
    platform: 'teams',
    label: t('KITA_CONNECT.PLATFORMS.TEAMS'),
    value: linkStatusLabel(props.status?.teams),
    isConnected: props.status?.teams === 'connected',
  },
  {
    platform: 'whatsapp',
    label: t('KITA_CONNECT.PLATFORMS.WHATSAPP'),
    description: t('KITA_CONNECT.WHATSAPP_DESCRIPTION'),
    value: whatsappNumber.value,
    isConnected: !!props.status?.whatsapp && props.status.whatsapp !== 'none',
  },
  {
    platform: 'viber',
    label: t('KITA_CONNECT.PLATFORMS.VIBER'),
    description: t('KITA_CONNECT.VIBER_DESCRIPTION'),
  },
]);
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="!status" class="mb-0 text-sm text-n-slate-11">
      {{ t('KITA_CONNECT.STATUS_UNAVAILABLE') }}
    </p>
    <ul v-else class="flex flex-col divide-y divide-n-weak">
      <li
        v-for="row in rows"
        :key="row.platform"
        class="flex items-start gap-3 py-3"
      >
        <PlatformLogo :platform="row.platform" class="mt-0.5 size-5 shrink-0" />
        <div class="flex flex-col flex-1 min-w-0 gap-0.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-medium text-n-slate-12">
              {{ row.label }}
            </span>
            <span
              v-if="row.value"
              class="text-xs truncate"
              :class="row.isConnected ? 'text-n-teal-11' : 'text-n-slate-11'"
            >
              {{ row.value }}
            </span>
          </div>
          <p v-if="row.description" class="mb-0 text-xs text-n-slate-11">
            {{ row.description }}
          </p>
        </div>
      </li>
    </ul>
  </div>
</template>
