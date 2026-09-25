<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KitaTicketChip from './KitaTicketChip.vue';
import { dynamicTime, shortTimestamp } from 'shared/helpers/timeHelper';
import { threadFooterSummary } from 'dashboard/helper/kitaThreads';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';

const props = defineProps({
  thread: { type: Object, required: true },
  conversationId: { type: Number, required: true },
});

const { t } = useI18n();
const { openThreadPane } = useKitaThreads();

const summary = computed(() => threadFooterSummary(props.thread));

const open = () =>
  openThreadPane(props.conversationId, props.thread.root_message_id);
</script>

<template>
  <div class="flex flex-wrap items-center max-w-full gap-3 text-sm">
    <button
      type="button"
      class="flex items-center min-w-0 gap-3 text-n-slate-11 hover:underline"
      data-test-id="kita-thread-footer"
      @click="open"
    >
      <span v-if="summary.unread" class="rounded-full size-2 bg-n-brand" />
      <span class="font-medium text-n-blue-11 shrink-0">
        {{
          t('KITA_THREADS.REPLY_COUNT', { count: summary.count }, summary.count)
        }}
      </span>
      <span v-if="summary.lastReplyAt" class="shrink-0">
        {{
          t('KITA_THREADS.LAST_REPLY', {
            time: shortTimestamp(dynamicTime(summary.lastReplyAt), true),
          })
        }}
      </span>
    </button>
    <KitaTicketChip v-if="summary.ticket" :ticket="summary.ticket" />
  </div>
</template>
