<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Avatar from 'next/avatar/Avatar.vue';
import PlatformLogo from 'next/kita/PlatformLogo.vue';

const props = defineProps({
  name: { type: String, default: '' },
  src: { type: String, default: '' },
  iconName: { type: String, default: null },
  platform: { type: String, default: null },
  size: { type: Number, default: 32 },
});

const { t } = useI18n();

const platformLabel = computed(() => {
  const names = {
    slack: t('KITA_CONNECT.PLATFORMS.SLACK'),
    teams: t('KITA_CONNECT.PLATFORMS.TEAMS'),
    whatsapp: t('KITA_CONNECT.PLATFORMS.WHATSAPP'),
    viber: t('KITA_CONNECT.PLATFORMS.VIBER'),
  };
  if (!names[props.platform]) return '';
  return t('KITA_CONNECT.SENT_VIA', { platform: names[props.platform] });
});
</script>

<template>
  <div class="relative shrink-0">
    <Avatar
      :name="name"
      :src="src"
      :icon-name="iconName"
      :size="size"
      rounded-full
    />
    <span
      v-if="platform"
      :title="platformLabel"
      data-test="platform-badge"
      class="absolute -bottom-0.5 -end-0.5 flex items-center justify-center size-3.5 rounded-full bg-white ring-2 ring-white"
    >
      <PlatformLogo :platform="platform" class="size-2.5" />
    </span>
  </div>
</template>
