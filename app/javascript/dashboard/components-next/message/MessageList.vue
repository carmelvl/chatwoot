<script setup>
import { computed, reactive, watch } from 'vue';
import Message from './Message.vue';
import { useI18n } from 'vue-i18n';
import { groupsWithPrevious } from './helpers/messageLayout';
import { dayDivider } from './helpers/dayDivider';
import { useCamelCase } from 'dashboard/composables/useTransformKeys';
import { useMapGetter } from 'dashboard/composables/store.js';
import MessageApi from 'dashboard/api/inbox/message.js';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import {
  isBridgeConversation,
  isHiddenThreadReply,
} from 'dashboard/helper/kitaThreads';

/**
 * Props definition for the component
 * @typedef {Object} Props
 * @property {Array} readMessages - Array of read messages
 * @property {Array} unReadMessages - Array of unread messages
 * @property {Number} currentUserId - ID of the current user
 * @property {Boolean} isAnEmailChannel - Whether this is an email channel
 * @property {Object} inboxSupportsReplyTo - Inbox reply support configuration
 * @property {Array} messages - Array of all messages [These are not in camelcase]
 */
const props = defineProps({
  currentUserId: {
    type: Number,
    required: true,
  },
  firstUnreadId: {
    type: Number,
    default: null,
  },
  isAnEmailChannel: {
    type: Boolean,
    default: false,
  },
  inboxSupportsReplyTo: {
    type: Object,
    default: () => ({ incoming: false, outgoing: false }),
  },
  messages: {
    type: Array,
    default: () => [],
  },
});

const emit = defineEmits(['retry']);

const currentChat = useMapGetter('getSelectedChat');
const { t } = useI18n();
const dayLabel = divider =>
  divider.key === 'date'
    ? divider.date
    : t(`CONVERSATION.KITA_DAY.${divider.key.toUpperCase()}`);

const conversationChannel = computed(
  () => currentChat.value?.custom_attributes?.channel ?? null
);
const isBridge = computed(() => isBridgeConversation(currentChat.value));

// Bridge conversations show only top-level messages; replies live in threads
const allMessages = computed(() => {
  const messages = useCamelCase(props.messages, {
    deep: true,
    stopPaths: [
      'content_attributes.translations',
      'content_attributes.whatsapp_flow_response.response_json',
    ],
  });
  return messages.filter(
    message => !isHiddenThreadReply(message, isBridge.value)
  );
});

const { threadsByConversation, fetchThreads } = useKitaThreads();

// Thread metadata keyed by root message id
const threadsByRoot = computed(() => {
  const threads = threadsByConversation[currentChat.value?.id] || [];
  return Object.fromEntries(
    threads.map(thread => [thread.root_message_id, thread])
  );
});

// Refetch when the conversation changes or a message arrives
watch(
  () => [currentChat.value?.id, currentChat.value?.messages?.length],
  ([conversationId]) => {
    // Any Kita customer conversation has threads (and their Grip tickets),
    // including ones merged before kita_channels was recorded
    if (conversationId && (isBridge.value || conversationChannel.value))
      fetchThreads(conversationId);
  },
  { immediate: true }
);

// Cache for fetched reply messages to avoid duplicate API calls
const fetchedReplyMessages = reactive(new Map());

/**
 * Fetches a specific message from the API by trying to get messages around it
 * @param {number} messageId - The ID of the message to fetch
 * @param {number} conversationId - The ID of the conversation
 * @returns {Promise<Object|null>} - The fetched message or null if not found/error
 */
const fetchReplyMessage = async (messageId, conversationId) => {
  // Return cached result if already fetched
  if (fetchedReplyMessages.has(messageId)) {
    return fetchedReplyMessages.get(messageId);
  }

  try {
    const response = await MessageApi.getPreviousMessages({
      conversationId,
      before: messageId + 100,
      after: messageId - 100,
    });

    const messages = response.data?.payload || [];
    const targetMessage = messages.find(msg => msg.id === messageId);

    if (targetMessage) {
      const camelCaseMessage = useCamelCase(targetMessage);
      fetchedReplyMessages.set(messageId, camelCaseMessage);
      return camelCaseMessage;
    }

    // Cache null result to avoid repeated API calls
    fetchedReplyMessages.set(messageId, null);
    return null;
  } catch (error) {
    fetchedReplyMessages.set(messageId, null);
    return null;
  }
};

/**
 * Gets the message that was replied to
 * @param {Object} parentMessage - The message containing the reply reference
 * @returns {Object|null} - The message being replied to, or null if not found
 */
const getInReplyToMessage = parentMessage => {
  if (!parentMessage) return null;

  const inReplyToMessageId =
    parentMessage.contentAttributes?.inReplyTo ??
    parentMessage.content_attributes?.in_reply_to;

  if (!inReplyToMessageId) return null;

  // Try to find in current messages first
  let replyMessage = props.messages?.find(msg => msg.id === inReplyToMessageId);

  // Then try store messages
  if (!replyMessage && currentChat.value?.messages) {
    replyMessage = currentChat.value.messages.find(
      msg => msg.id === inReplyToMessageId
    );
  }

  // Then check fetch cache
  if (!replyMessage && fetchedReplyMessages.has(inReplyToMessageId)) {
    replyMessage = fetchedReplyMessages.get(inReplyToMessageId);
  }

  // If still not found and we have conversation context, fetch it
  if (!replyMessage && currentChat.value?.id) {
    fetchReplyMessage(inReplyToMessageId, currentChat.value.id);
    return null; // Let UI handle loading state
  }

  return replyMessage ? useCamelCase(replyMessage) : null;
};
</script>

<template>
  <ul
    class="bg-n-surface-1"
    :class="conversationChannel ? 'px-10 py-7' : 'px-4'"
  >
    <slot name="beforeAll" />
    <template v-for="(message, index) in allMessages" :key="message.id">
      <li
        v-if="
          conversationChannel && dayDivider(message, allMessages[index - 1])
        "
        data-test="message-day-divider"
        class="flex items-center gap-3 mb-7 list-none"
      >
        <span class="flex-1 h-px bg-n-weak" />
        <span
          class="text-[0.6875rem] leading-[0.875rem] font-bold tracking-[0.12em] uppercase text-n-slate-11"
        >
          {{ dayLabel(dayDivider(message, allMessages[index - 1])) }}
        </span>
        <span class="flex-1 h-px bg-n-weak" />
      </li>
      <slot
        v-if="firstUnreadId && message.id === firstUnreadId"
        name="unreadBadge"
      />
      <Message
        v-bind="message"
        :is-email-inbox="isAnEmailChannel"
        :in-reply-to="getInReplyToMessage(message)"
        :group-with-next="
          groupsWithPrevious(allMessages[index + 1], message, currentUserId)
        "
        :group-with-previous="
          groupsWithPrevious(message, allMessages[index - 1], currentUserId)
        "
        :conversation-channel="conversationChannel"
        :kita-thread="threadsByRoot[message.id]"
        :inbox-supports-reply-to="inboxSupportsReplyTo"
        :current-user-id="currentUserId"
        data-clarity-mask="True"
        @retry="emit('retry', message)"
      />
    </template>
    <slot name="after" />
  </ul>
</template>
