<script setup>
import { useI18n } from 'vue-i18n';
import { emitter } from 'shared/helpers/mitt';
import { BUS_EVENTS } from 'shared/constants/busEvents';

const props = defineProps({
  count: { type: Number, required: true },
  firstReplyId: { type: Number, required: true },
});

const { t } = useI18n();

const scrollToFirstReply = () => {
  emitter.emit(BUS_EVENTS.SCROLL_TO_MESSAGE, {
    messageId: props.firstReplyId,
  });
};
</script>

<template>
  <button
    type="button"
    class="flex items-center gap-1 px-2 py-0.5 text-xs rounded-md text-n-slate-11 bg-n-alpha-1 hover:bg-n-alpha-2"
    @click="scrollToFirstReply"
  >
    <span class="i-lucide-messages-square size-3.5" />
    {{ t('CONVERSATION.THREAD_REPLIES', { count }, count) }}
  </button>
</template>
