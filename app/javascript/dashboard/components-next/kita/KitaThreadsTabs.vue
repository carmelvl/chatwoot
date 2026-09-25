<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import TabBar from 'dashboard/components-next/tabbar/TabBar.vue';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';

const props = defineProps({
  conversationId: { type: Number, required: true },
});

const { t } = useI18n();
const { threadsByConversation, showThreadsTab } = useKitaThreads();

const tabs = computed(() => [
  { key: 'messages', label: t('KITA_THREADS.TAB_MESSAGES') },
  {
    key: 'threads',
    label: t('KITA_THREADS.TAB_THREADS'),
    count: (threadsByConversation[props.conversationId] || []).length,
  },
]);

const onTabChanged = tab => {
  showThreadsTab.value = tab.key === 'threads';
};
</script>

<template>
  <div class="px-4 py-2 border-b border-n-weak">
    <TabBar
      :tabs="tabs"
      :initial-active-tab="showThreadsTab ? 1 : 0"
      @tab-changed="onTabChanged"
    />
  </div>
</template>
