<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import {
  useCamelCase,
  useSnakeCase,
} from 'dashboard/composables/useTransformKeys';
import { useKitaConnections } from 'dashboard/composables/useKitaConnections';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { kitaReplyBlock, KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import {
  isPressingTicket,
  slaStatus,
  threadMessages,
  threadTitle,
} from 'dashboard/helper/kitaThreads';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import Button from 'dashboard/components-next/button/Button.vue';
import TextArea from 'dashboard/components-next/textarea/TextArea.vue';
import Message from 'next/message/Message.vue';
import KitaReplyGate from './KitaReplyGate.vue';

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

const platformName = useKitaPlatformName();
// "Thread in Slack #kita-tala"
const location = computed(() =>
  t('KITA_THREADS.THREAD_IN', {
    channel: [platformName(platform.value), externalChannel.value]
      .filter(Boolean)
      .join(' '),
  })
);

const replies = computed(() =>
  messages.value.filter(message => message.id !== props.rootId)
);

const ticket = computed(() => thread.value?.ticket || null);
const sla = computed(() => slaStatus(ticket.value?.sla_due_at));
const ticketFields = computed(() =>
  [
    ticket.value?.status && {
      key: 'STATUS',
      value: t(`KITA_THREADS.TICKET_STATUS.${ticket.value.status}`),
    },
    ticket.value?.owner && { key: 'OWNER', value: ticket.value.owner },
    sla.value && {
      key: 'SLA',
      value: sla.value.breached
        ? t('KITA_THREADS.SLA.BREACHED')
        : t('KITA_THREADS.SLA.LEFT', { time: sla.value.duration }),
      pressing: sla.value.pressing,
    },
  ].filter(Boolean)
);

const isResolved = computed(() => thread.value?.status === 'resolved');
const statusActionLabel = computed(() => {
  if (ticket.value) {
    return isResolved.value
      ? t('KITA_THREADS.REOPEN_WITH_TICKET')
      : t('KITA_THREADS.RESOLVE_WITH_TICKET');
  }
  return isResolved.value
    ? t('KITA_THREADS.REOPEN')
    : t('KITA_THREADS.RESOLVE');
});
const replyBlock = computed(() =>
  kitaReplyBlock(kitaConnections.value, platform.value)
);

const toggleStatus = async () => {
  try {
    const ticketSynced = await setThreadStatus(
      props.conversationId,
      props.rootId,
      isResolved.value ? 'open' : 'resolved'
    );
    if (ticketSynced === false) useAlert(t('KITA_THREADS.TICKET_SYNC_ERROR'));
  } catch {
    useAlert(t('KITA_THREADS.STATUS_ERROR'));
  }
};

// Failed thread replies retry the same way as in the main stream
const retryMessage = message =>
  store.dispatch('sendMessageWithData', useSnakeCase(message));

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
    class="flex flex-col h-full overflow-hidden fixed top-0 z-40 w-full max-w-sm ltr:right-0 rtl:left-0 md:static md:max-w-none md:w-[400px] md:min-w-[400px] ltr:border-l rtl:border-r border-n-weak bg-n-surface-2 shadow-lg md:shadow-none"
    data-test-id="kita-thread-pane"
  >
    <div class="flex flex-col gap-4 px-7 pt-7 pb-6 border-b border-n-weak">
      <div class="flex items-start gap-2">
        <div class="flex flex-col flex-1 min-w-0 gap-3">
          <span class="text-sm truncate text-n-slate-11">{{ location }}</span>
          <h3 class="m-0 text-2xl font-bold font-interDisplay text-n-slate-12">
            {{ title }}
          </h3>
        </div>
        <Button
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="slate"
          :title="t('KITA_THREADS.CLOSE')"
          @click="closeThreadPane"
        />
      </div>
      <div
        v-if="ticket"
        data-test="kita-ticket-card"
        class="flex flex-col gap-3 px-4 py-3 rounded-lg border-s-4 bg-n-surface-1 shadow-sm"
        :class="
          isPressingTicket(ticket) ? 'border-n-ruby-9' : 'border-n-amber-9'
        "
      >
        <div class="flex items-center justify-between gap-2 text-sm">
          <span class="font-medium text-n-slate-12">
            {{
              ticket.display_id
                ? t('KITA_THREADS.TICKET_WITH_ID', { id: ticket.display_id })
                : t('KITA_THREADS.TICKET_CARD.TITLE')
            }}
          </span>
          <span
            v-if="ticket.priority"
            class="font-medium"
            :class="
              isPressingTicket(ticket) ? 'text-n-ruby-11' : 'text-n-amber-11'
            "
          >
            {{ t(`KITA_THREADS.PRIORITY.${ticket.priority}`) }}
          </span>
        </div>
        <dl v-if="ticketFields.length" class="flex gap-6 m-0 text-sm">
          <div v-for="field in ticketFields" :key="field.key">
            <dt class="text-xs text-n-slate-11">
              {{ t(`KITA_THREADS.TICKET_CARD.${field.key}`) }}
            </dt>
            <dd
              class="m-0 mt-1"
              :class="field.pressing ? 'text-n-ruby-11' : 'text-n-slate-12'"
            >
              {{ field.value }}
            </dd>
          </div>
        </dl>
      </div>
    </div>
    <ul class="flex-1 min-h-0 px-7 py-5 m-0 overflow-y-auto">
      <li v-if="!root" class="py-2 text-xs text-n-slate-11">
        {{ t('KITA_THREADS.NOT_LOADED') }}
      </li>
      <Message
        v-if="root"
        v-bind="root"
        :current-user-id="currentUserId"
        :conversation-channel="platform"
        @retry="retryMessage(root)"
      />
      <li
        v-if="replies.length"
        class="flex items-center gap-3 mb-4 text-xs text-n-slate-11"
      >
        {{
          t(
            'KITA_THREADS.REPLIES_DIVIDER',
            { count: replies.length },
            replies.length
          )
        }}
        <span class="flex-1 h-px bg-n-weak" />
      </li>
      <Message
        v-for="message in replies"
        :key="message.id"
        v-bind="message"
        :current-user-id="currentUserId"
        :conversation-channel="platform"
        @retry="retryMessage(message)"
      />
    </ul>
    <KitaReplyGate
      v-if="replyBlock"
      :platform="platform"
      :reason="replyBlock"
      :show-note-action="false"
    />
    <div v-else class="px-7 pt-3">
      <div
        class="flex items-end gap-2 p-2 rounded-xl outline outline-1 outline-n-weak bg-n-surface-1"
      >
        <TextArea
          v-model="reply"
          class="flex-1"
          :placeholder="t('KITA_THREADS.REPLY_PLACEHOLDER')"
          :max-length="10000"
          auto-height
          min-height="2rem"
          @keydown.meta.enter="sendReply"
          @keydown.ctrl.enter="sendReply"
        />
        <Button
          :label="t('KITA_THREADS.SEND')"
          size="sm"
          :disabled="!reply.trim()"
          @click="sendReply"
        />
      </div>
    </div>
    <div class="flex items-center justify-between gap-2 px-7 pt-3 pb-5 text-sm">
      <button
        v-if="thread"
        type="button"
        data-test="kita-thread-status-action"
        class="font-medium text-n-blue-11 hover:underline"
        @click="toggleStatus"
      >
        {{ statusActionLabel }}
      </button>
      <a
        v-if="ticket?.url"
        :href="ticket.url"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-1 ms-auto text-n-slate-12 hover:underline"
      >
        {{ t('KITA_THREADS.OPEN_IN_GRIP') }}
        <span class="i-lucide-arrow-up-right size-3.5" />
      </a>
    </div>
  </div>
</template>
