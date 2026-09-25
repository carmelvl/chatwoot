<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Avatar from 'next/avatar/Avatar.vue';
import KitaTicketChip from './KitaTicketChip.vue';
import { dynamicTime } from 'shared/helpers/timeHelper';
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
  <div class="flex items-center gap-2 max-w-full">
    <button
      type="button"
      class="flex items-center min-w-0 gap-2 px-2 py-1 text-xs rounded-md text-n-slate-11 bg-n-alpha-1 hover:bg-n-alpha-2"
      data-test-id="kita-thread-footer"
      @click="open"
    >
      <span v-if="summary.unread" class="rounded-full size-2 bg-n-brand" />
      <span class="flex -space-x-1">
        <Avatar
          v-for="participant in summary.avatars"
          :key="`${participant.type}-${participant.id}`"
          :name="participant.name"
          :src="participant.thumbnail"
          :size="16"
          rounded-full
        />
      </span>
      <span class="font-medium text-n-blue-11 shrink-0">
        {{
          t('KITA_THREADS.REPLY_COUNT', { count: summary.count }, summary.count)
        }}
      </span>
      <span v-if="summary.lastReplyAt" class="shrink-0">
        {{
          t('KITA_THREADS.LAST_REPLY', {
            time: dynamicTime(summary.lastReplyAt),
          })
        }}
      </span>
      <span v-if="summary.title" class="truncate text-n-slate-12">
        {{ summary.title }}
      </span>
    </button>
    <KitaTicketChip v-if="summary.ticket" :ticket="summary.ticket" />
  </div>
</template>
