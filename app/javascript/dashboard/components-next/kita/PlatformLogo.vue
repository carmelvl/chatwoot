<script setup>
import viberLogo from 'dashboard/assets/images/kita/viber.svg';

defineProps({
  platform: {
    type: String,
    required: true,
    validator: value => ['slack', 'teams', 'whatsapp', 'viber'].includes(value),
  },
});

const ICONS = {
  slack: 'i-logos-slack-icon',
  teams: 'i-logos-microsoft-teams',
  whatsapp: 'i-logos-whatsapp-icon',
};
</script>

<template>
  <img v-if="platform === 'viber'" :src="viberLogo" alt="" />
  <span v-else :class="ICONS[platform]" />
</template>
