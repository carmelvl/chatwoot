<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMapGetter } from 'dashboard/composables/store';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import { threadTitle } from 'dashboard/helper/kitaThreads';
import { dynamicTime } from 'shared/helpers/timeHelper';
import PlatformLogo from './PlatformLogo.vue';

const props = defineProps({
  conversationId: { type: Number, required: true },
});

const { t } = useI18n();
const currentChat = useMapGetter('getSelectedChat');
const { threadsByConversation, openThreadPane } = useKitaThreads();

// The API returns threads sorted by last activity, newest first
const threads = computed(() => {
  const loaded = currentChat.value?.messages || [];
  return (threadsByConversation[props.conversationId] || []).map(thread => ({
    ...thread,
    displayTitle: threadTitle(
      thread,
      loaded.find(message => message.id === thread.root_message_id)?.content
    ),
    meta: [
      thread.external_channel,
      t(
        'KITA_THREADS.REPLY_COUNT',
        { count: thread.reply_count },
        thread.reply_count
      ),
      thread.last_reply_at && dynamicTime(thread.last_reply_at),
    ]
      .filter(Boolean)
      .join(' · '),
    platform: KITA_PLATFORMS.includes(thread.external_source)
      ? thread.external_source
      : null,
  }));
});
</script>

<template>
  <div class="flex-1 min-h-0 overflow-y-auto bg-n-surface-1">
    <p v-if="!threads.length" class="p-6 text-sm text-center text-n-slate-11">
      {{ t('KITA_THREADS.EMPTY') }}
    </p>
    <button
      v-for="thread in threads"
      :key="thread.root_message_id"
      type="button"
      class="flex items-center w-full gap-3 px-4 py-3 text-start border-b border-n-weak hover:bg-n-alpha-1"
      @click="openThreadPane(conversationId, thread.root_message_id)"
    >
      <span
        class="rounded-full size-2 shrink-0"
        :class="thread.unread ? 'bg-n-brand' : 'bg-transparent'"
      />
      <PlatformLogo
        v-if="thread.platform"
        :platform="thread.platform"
        class="size-4 shrink-0"
      />
      <span class="flex flex-col flex-1 min-w-0 gap-0.5">
        <span
          class="text-sm truncate text-n-slate-12"
          :class="{ 'font-medium': thread.unread }"
        >
          {{ thread.displayTitle }}
        </span>
        <span class="text-xs truncate text-n-slate-11">
          {{ thread.meta }}
        </span>
      </span>
      <span
        class="px-1.5 py-0.5 text-xs rounded-md shrink-0"
        :class="
          thread.status === 'resolved'
            ? 'bg-n-teal-3 text-n-teal-11'
            : 'bg-n-blue-3 text-n-blue-11'
        "
      >
        {{
          thread.status === 'resolved'
            ? t('KITA_THREADS.RESOLVED')
            : t('KITA_THREADS.OPEN')
        }}
      </span>
    </button>
  </div>
</template>
