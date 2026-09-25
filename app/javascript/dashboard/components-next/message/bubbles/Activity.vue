<script setup>
import { computed } from 'vue';
import { messageTimestamp } from 'shared/helpers/timeHelper';
import { useMessageContext } from '../provider.js';

const { content, createdAt } = useMessageContext();

const readableTime = computed(() =>
  messageTimestamp(createdAt.value, 'LLL d, h:mm a')
);
</script>

<template>
  <!-- A full-width, centred divider line: "Conversation was marked resolved…" -->
  <div
    v-tooltip.top="readableTime"
    class="flex items-center w-full min-w-0 gap-3 text-xs text-n-slate-11"
    data-bubble-name="activity"
  >
    <span class="flex-1 h-px bg-n-weak" />
    <span class="max-w-[80%] text-center truncate" :title="content">
      {{ content }}
    </span>
    <span class="flex-1 h-px bg-n-weak" />
  </div>
</template>
