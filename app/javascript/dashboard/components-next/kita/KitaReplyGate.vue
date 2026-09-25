<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'dashboard/components-next/button/Button.vue';
import PlatformLogo from './PlatformLogo.vue';
import { openKitaConnect } from 'dashboard/helper/kitaConnect';

const props = defineProps({
  platform: { type: String, required: true },
  reason: { type: String, required: true },
});

const { t } = useI18n();

const title = computed(() => {
  const names = {
    slack: t('KITA_CONNECT.PLATFORMS.SLACK'),
    teams: t('KITA_CONNECT.PLATFORMS.TEAMS'),
  };
  const platform = names[props.platform];
  return props.reason === 'unavailable'
    ? t('KITA_CONNECT.REPLY_GATE.UNAVAILABLE', { platform })
    : t('KITA_CONNECT.REPLY_GATE.TITLE', { platform });
});
</script>

<template>
  <div
    class="flex items-center gap-3 px-4 py-4 m-3 rounded-lg bg-n-alpha-1 outline outline-1 outline-n-weak"
    data-test-id="kita-reply-gate"
  >
    <PlatformLogo :platform="platform" class="size-6 shrink-0" />
    <div class="flex flex-col flex-1 min-w-0 gap-0.5">
      <span class="text-sm font-medium text-n-slate-12">{{ title }}</span>
      <span class="text-xs text-n-slate-11">
        {{ t('KITA_CONNECT.REPLY_GATE.DESCRIPTION') }}
      </span>
    </div>
    <Button
      v-if="reason === 'not_connected'"
      :label="t('KITA_CONNECT.CONNECT')"
      size="sm"
      @click="openKitaConnect"
    />
  </div>
</template>
