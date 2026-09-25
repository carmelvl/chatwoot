<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { useCamelCase } from 'dashboard/composables/useTransformKeys';
import { useKitaConnections } from 'dashboard/composables/useKitaConnections';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { kitaReplyBlock, KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import { threadMessages, threadTitle } from 'dashboard/helper/kitaThreads';
import Button from 'dashboard/components-next/button/Button.vue';
import TextArea from 'dashboard/components-next/textarea/TextArea.vue';
import Message from 'next/message/Message.vue';
import KitaReplyGate from './KitaReplyGate.vue';
import KitaTicketChip from './KitaTicketChip.vue';
import PlatformLogo from './PlatformLogo.vue';

const props = defineProps({
  conversationId: { type: Number, required: true },
  rootId: { type: Number, required: true },
});

const { t } = useI18n();
const store = useStore();
const currentChat = useMapGetter('getSelectedChat');
const currentUserId = useMapGetter('getCurrentUserID');
const { status: kitaConnections } = useKitaConnections();
const { findThread, closeThreadPane, setThreadStatus } = useKitaThreads();

const thread = computed(() => findThread(props.conversationId, props.rootId));

const messages = computed(() =>
  threadMessages(
    useCamelCase(currentChat.value?.messages || [], {
      deep: true,
      stopPaths: ['content_attributes.translations'],
    }),
    props.rootId
  )
);
const root = computed(() =>
  messages.value.find(message => message.id === props.rootId)
);

const title = computed(
  () =>
    threadTitle(thread.value, root.value?.content) ||
    t('KITA_THREADS.PANE_TITLE')
);

// The platform the thread lives on: replies go back into it
const platform = computed(() => {
  const source =
    root.value?.contentAttributes?.externalSource ??
    thread.value?.external_source;
  return KITA_PLATFORMS.includes(source) ? source : null;
});
const externalChannel = computed(
  () =>
    thread.value?.external_channel ??
    root.value?.contentAttributes?.externalChannel
);

const isResolved = computed(() => thread.value?.status === 'resolved');
const replyBlock = computed(() =>
  kitaReplyBlock(kitaConnections.value, platform.value)
);

const toggleStatus = async () => {
  try {
    await setThreadStatus(
      props.conversationId,
      props.rootId,
      isResolved.value ? 'open' : 'resolved'
    );
  } catch {
    useAlert(t('KITA_THREADS.STATUS_ERROR'));
  }
};

const reply = ref('');
const sendReply = async () => {
  const content = reply.value.trim();
  if (!content) return;
  try {
    await store.dispatch('createPendingMessageAndSend', {
      conversationId: props.conversationId,
      message: content,
      private: false,
      contentAttributes: { in_reply_to: props.rootId },
    });
    reply.value = '';
  } catch {
    useAlert(t('KITA_THREADS.SEND_ERROR'));
  }
};
</script>

<template>
  <div
    class="flex flex-col h-full overflow-hidden fixed top-0 z-40 w-full max-w-sm ltr:right-0 rtl:left-0 md:static md:w-[360px] md:min-w-[360px] ltr:border-l rtl:border-r border-n-weak bg-n-surface-2 shadow-lg md:shadow-none"
    data-test-id="kita-thread-pane"
  >
    <div class="flex flex-col gap-2 px-4 py-3 border-b border-n-weak">
      <div class="flex items-start gap-2">
        <span class="flex-1 min-w-0 text-sm font-medium text-n-slate-12">
          {{ title }}
        </span>
        <Button
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="slate"
          :title="t('KITA_THREADS.CLOSE')"
          @click="closeThreadPane"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs text-n-slate-11">
        <PlatformLogo v-if="platform" :platform="platform" class="size-3.5" />
        <span v-if="externalChannel" class="truncate">
          {{ externalChannel }}
        </span>
        <span
          class="px-1.5 py-0.5 rounded-md"
          :class="
            isResolved
              ? 'bg-n-teal-3 text-n-teal-11'
              : 'bg-n-blue-3 text-n-blue-11'
          "
        >
          {{ isResolved ? t('KITA_THREADS.RESOLVED') : t('KITA_THREADS.OPEN') }}
        </span>
        <KitaTicketChip v-if="thread?.ticket" :ticket="thread.ticket" />
        <Button
          v-if="thread"
          :label="
            isResolved ? t('KITA_THREADS.REOPEN') : t('KITA_THREADS.RESOLVE')
          "
          size="xs"
          variant="outline"
          color="slate"
          class="ltr:ml-auto rtl:mr-auto"
          @click="toggleStatus"
        />
      </div>
    </div>
    <ul class="flex-1 min-h-0 px-3 py-2 overflow-y-auto">
      <li v-if="!root" class="px-1 py-2 text-xs text-n-slate-11">
        {{ t('KITA_THREADS.NOT_LOADED') }}
      </li>
      <Message
        v-for="message in messages"
        :key="message.id"
        v-bind="message"
        :current-user-id="currentUserId"
        :conversation-channel="platform"
      />
    </ul>
    <KitaReplyGate
      v-if="replyBlock"
      :platform="platform"
      :reason="replyBlock"
    />
    <div v-else class="flex flex-col gap-2 p-3 border-t border-n-weak">
      <TextArea
        v-model="reply"
        :placeholder="t('KITA_THREADS.REPLY_PLACEHOLDER')"
        :max-length="10000"
        auto-height
        min-height="3rem"
        @keydown.meta.enter="sendReply"
        @keydown.ctrl.enter="sendReply"
      />
      <Button
        :label="t('KITA_THREADS.SEND')"
        size="sm"
        class="ltr:ml-auto rtl:mr-auto"
        :disabled="!reply.trim()"
        @click="sendReply"
      />
    </div>
  </div>
</template>
