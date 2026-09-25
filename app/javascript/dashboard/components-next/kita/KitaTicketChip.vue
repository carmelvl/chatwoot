<script setup>
import { useI18n } from 'vue-i18n';

defineProps({
  ticket: { type: Object, required: true },
});

const { t } = useI18n();
</script>

<template>
  <a
    :href="ticket.url"
    target="_blank"
    rel="noopener noreferrer"
    class="flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md shrink-0 bg-n-amber-3 text-n-amber-11 hover:bg-n-amber-4"
  >
    <span class="i-lucide-ticket size-3" />
    {{ t('KITA_THREADS.TICKET') }}
  </a>
</template>
