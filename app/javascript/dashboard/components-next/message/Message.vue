<script setup>
import { onMounted, computed, ref, toRefs } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import { provideMessageContext } from './provider.js';
import { useTrack } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { emitter } from 'shared/helpers/mitt';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { LocalStorage } from 'shared/helpers/localStorage';
import { ACCOUNT_EVENTS } from 'dashboard/helper/AnalyticsHelper/events';
import { LOCAL_STORAGE_KEYS } from 'dashboard/constants/localStorage';
import { getInboxIconByType } from 'dashboard/helper/inbox';
import { BUS_EVENTS } from 'shared/constants/busEvents';
import {
  MESSAGE_TYPES,
  ATTACHMENT_TYPES,
  MESSAGE_VARIANTS,
  SENDER_TYPES,
  ORIENTATION,
  MESSAGE_STATUS,
  CONTENT_TYPES,
} from './constants';

import MessageSenderAvatar from './MessageSenderAvatar.vue';
import MessageMeta from './MessageMeta.vue';
import {
  getMessageOrientation,
  isExternalSender,
  isKitaTeammate,
  isOwnMessage,
} from './helpers/messageSide';
import {
  LAYOUT_STYLES,
  getMessageLayout,
  layoutStyleFor,
} from './helpers/messageLayout';
import { messageStamp } from 'shared/helpers/timeHelper';
import { useKitaThreads } from 'dashboard/composables/useKitaThreads';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';

import TextBubble from './bubbles/Text/Index.vue';
import ActivityBubble from './bubbles/Activity.vue';
import ImageBubble from './bubbles/Image.vue';
import FileBubble from './bubbles/File.vue';
import AudioBubble from './bubbles/Audio.vue';
import VideoBubble from './bubbles/Video.vue';
import EmbedBubble from './bubbles/Embed.vue';
import FallbackBubble from './bubbles/Fallback.vue';
import InstagramStoryBubble from './bubbles/InstagramStory.vue';
import EmailBubble from './bubbles/Email/Index.vue';
import UnsupportedBubble from './bubbles/Unsupported.vue';
import ContactBubble from './bubbles/Contact.vue';
import DyteBubble from './bubbles/Dyte.vue';
import LocationBubble from './bubbles/Location.vue';
import CSATBubble from './bubbles/CSAT.vue';
import FormBubble from './bubbles/Form.vue';
import VoiceCallBubble from './bubbles/VoiceCall.vue';
import WhatsappFlowResponseBubble from './bubbles/WhatsappFlowResponse.vue';
import WhatsappReferral from './bubbles/Text/WhatsappReferral.vue';

import MessageStrip from './MessageStrip.vue';
import {
  canRetryFailed,
  failedSendReason,
  kitaNotice,
} from './helpers/kitaNotice';
import { hasOneDayPassed } from 'shared/helpers/timeHelper';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import KitaThreadFooter from 'next/kita/KitaThreadFooter.vue';
import ContextMenu from 'dashboard/modules/conversations/components/MessageContextMenu.vue';
import { useBranding } from 'shared/composables/useBranding';

/**
 * @typedef {Object} Attachment
 * @property {number} id - Unique identifier for the attachment
 * @property {number} messageId - ID of the associated message
 * @property {'image'|'audio'|'video'|'file'|'location'|'fallback'|'share'|'story_mention'|'contact'|'ig_reel'} fileType - Type of the attachment (file or image)
 * @property {number} accountId - ID of the associated account
 * @property {string|null} extension - File extension
 * @property {string} dataUrl - URL to access the full attachment data
 * @property {string} thumbUrl - URL to access the thumbnail version
 * @property {number} fileSize - Size of the file in bytes
 * @property {number|null} width - Width of the image if applicable
 * @property {number|null} height - Height of the image if applicable
 */

/**
 * @typedef {Object} Sender
 * @property {Object} additional_attributes - Additional attributes of the sender
 * @property {Object} custom_attributes - Custom attributes of the sender
 * @property {string} email - Email of the sender
 * @property {number} id - ID of the sender
 * @property {string|null} identifier - Identifier of the sender
 * @property {string} name - Name of the sender
 * @property {string|null} phone_number - Phone number of the sender
 * @property {string} thumbnail - Thumbnail URL of the sender
 * @property {string} type - Type of sender
 */

/**
 * @typedef {Object} ContentAttributes
 * @property {string} externalError - an error message to be shown if the message failed to send
 */

/**
 * @typedef {Object} Props
 * @property {('sent'|'delivered'|'read'|'failed'|'progress')} status - The delivery status of the message
 * @property {ContentAttributes} [contentAttributes={}] - Additional attributes of the message content
 * @property {Attachment[]} [attachments=[]] - The attachments associated with the message
 * @property {Sender|null} [sender=null] - The sender information
 * @property {boolean} [private=false] - Whether the message is private
 * @property {number|null} [senderId=null] - The ID of the sender
 * @property {number} createdAt - Timestamp when the message was created
 * @property {number} currentUserId - The ID of the current user
 * @property {number} id - The unique identifier for the message
 * @property {number} messageType - The type of message (must be one of MESSAGE_TYPES)
 * @property {string|null} [error=null] - Error message if the message failed to send
 * @property {string|null} [senderType=null] - The type of the sender
 * @property {string} content - The message content
 * @property {boolean} [groupWithNext=false] - Whether the message should be grouped with the next message
 * @property {boolean} [groupWithPrevious=false] - Whether the message is grouped with the previous message
 * @property {Object|null} [kitaThread=null] - Kita thread this message is the root of (threads API entry)
 * @property {string|null} [conversationChannel=null] - Kita bridge channel of the conversation (slack/teams/whatsapp/viber)
 * @property {Object|null} [inReplyTo=null] - The message to which this message is a reply
 * @property {boolean} [isEmailInbox=false] - Whether the message is from an email inbox
 * @property {number} conversationId - The ID of the conversation to which the message belongs
 * @property {number} inboxId - The ID of the inbox to which the message belongs
 */

// eslint-disable-next-line vue/define-macros-order
const props = defineProps({
  id: { type: Number, required: true },
  messageType: {
    type: Number,
    required: true,
    validator: value => Object.values(MESSAGE_TYPES).includes(value),
  },
  status: {
    type: String,
    required: true,
    validator: value => Object.values(MESSAGE_STATUS).includes(value),
  },
  attachments: { type: Array, default: () => [] },
  call: { type: Object, default: null }, // eslint-disable-line vue/no-unused-properties
  content: { type: String, default: null },
  contentAttributes: { type: Object, default: () => ({}) },
  contentType: {
    type: String,
    default: 'text',
    validator: value => Object.values(CONTENT_TYPES).includes(value),
  },
  conversationId: { type: Number, required: true },
  createdAt: { type: Number, required: true }, // eslint-disable-line vue/no-unused-properties
  currentUserId: { type: Number, required: true }, // eslint-disable-line vue/no-unused-properties
  groupWithNext: { type: Boolean, default: false },
  groupWithPrevious: { type: Boolean, default: false },
  conversationChannel: { type: String, default: null },
  kitaThread: { type: Object, default: null },
  inboxId: { type: Number, default: null }, // eslint-disable-line vue/no-unused-properties
  inboxSupportsReplyTo: { type: Object, default: () => ({}) },
  inReplyTo: { type: Object, default: null }, // eslint-disable-line vue/no-unused-properties
  isEmailInbox: { type: Boolean, default: false },
  private: { type: Boolean, default: false },
  additionalAttributes: { type: Object, default: () => ({}) }, // eslint-disable-line vue/no-unused-properties
  sender: { type: Object, default: null },
  senderId: { type: Number, default: null }, // eslint-disable-line vue/no-unused-properties
  senderType: { type: String, default: null },
  sourceId: { type: String, default: '' }, // eslint-disable-line vue/no-unused-properties
});

const emit = defineEmits(['retry']);

const contextMenuPosition = ref({});
const showBackgroundHighlight = ref(false);
const showContextMenu = ref(false);
const { t } = useI18n();
const route = useRoute();
const inboxGetter = useMapGetter('inboxes/getInbox');
const inbox = computed(() => inboxGetter.value(props.inboxId) || {});
const isOnChatwootCloud = useMapGetter('globalConfig/isOnChatwootCloud');
const { replaceInstallationName } = useBranding();

const isCaptainMessage = computed(() => {
  const senderType = props.sender?.type ?? props.senderType;
  return senderType === SENDER_TYPES.CAPTAIN_ASSISTANT;
});

const isTeammateMessage = computed(() => isKitaTeammate(props));
const isExternalMessage = computed(() => isExternalSender(props));

/**
 * Computes the message variant based on props
 * @type {import('vue').ComputedRef<'user'|'agent'|'activity'|'private'|'bot'|'template'|'teammate'>}
 */
const variant = computed(() => {
  if (props.private) return MESSAGE_VARIANTS.PRIVATE;

  if (props.isEmailInbox) {
    const emailInboxTypes = [MESSAGE_TYPES.INCOMING, MESSAGE_TYPES.OUTGOING];
    if (emailInboxTypes.includes(props.messageType)) {
      return MESSAGE_VARIANTS.EMAIL;
    }
  }

  if (props.contentType === CONTENT_TYPES.INCOMING_EMAIL) {
    return MESSAGE_VARIANTS.EMAIL;
  }

  if (props.status === MESSAGE_STATUS.FAILED) return MESSAGE_VARIANTS.ERROR;
  if (props.contentAttributes?.isUnsupported)
    return MESSAGE_VARIANTS.UNSUPPORTED;

  if (props.contentAttributes?.externalEcho) {
    return MESSAGE_VARIANTS.AGENT;
  }

  if (isTeammateMessage.value) return MESSAGE_VARIANTS.TEAMMATE;

  const isBot =
    props.sender?.type === SENDER_TYPES.AGENT_BOT ||
    props.senderType === SENDER_TYPES.AGENT_BOT ||
    (!props.sender && !props.additionalAttributes?.senderName);
  if (isBot && props.messageType === MESSAGE_TYPES.OUTGOING) {
    return MESSAGE_VARIANTS.BOT;
  }

  const variants = {
    [MESSAGE_TYPES.INCOMING]: MESSAGE_VARIANTS.USER,
    [MESSAGE_TYPES.ACTIVITY]: MESSAGE_VARIANTS.ACTIVITY,
    [MESSAGE_TYPES.OUTGOING]: MESSAGE_VARIANTS.AGENT,
    [MESSAGE_TYPES.TEMPLATE]: MESSAGE_VARIANTS.TEMPLATE,
  };

  return variants[props.messageType] || MESSAGE_VARIANTS.USER;
});

/**
 * Chat-app alignment: only the current user's own messages sit on the right
 * @returns {import('vue').ComputedRef<'left'|'right'|'center'>} The computed orientation
 */
const layoutStyle = computed(() =>
  props.isEmailInbox
    ? LAYOUT_STYLES.CHAT
    : layoutStyleFor(props.conversationChannel)
);
const isFlat = computed(() => layoutStyle.value === LAYOUT_STYLES.FLAT);

const orientation = computed(() => getMessageOrientation(props));

const isOwn = computed(() => isOwnMessage(props));

// A thread root is highlighted while its thread is open in the pane
const { openThread } = useKitaThreads();
const isOpenThreadRoot = computed(
  () =>
    !!props.kitaThread &&
    openThread.value?.conversationId === props.conversationId &&
    openThread.value?.rootId === props.id
);

const isBotOrAgentMessage = computed(
  () => orientation.value === ORIENTATION.RIGHT
);

const flexOrientationClass = computed(() => {
  const map = {
    [ORIENTATION.LEFT]: 'justify-start',
    [ORIENTATION.RIGHT]: 'justify-end',
    [ORIENTATION.CENTER]: 'justify-center',
  };

  return map[orientation.value];
});

/**
 * Platform a Kita bridge message came from (or went out to). Bridge messages
 * carry externalSource; desk replies fall back to the conversation channel.
 */
const sourcePlatform = computed(() => {
  if (props.private || props.isEmailInbox) return null;
  const { externalSource, externalEcho } = props.contentAttributes || {};
  if (KITA_PLATFORMS.includes(externalSource)) return externalSource;
  if (externalEcho || variant.value === MESSAGE_VARIANTS.BOT) return null;

  const isPublicMessage = [MESSAGE_TYPES.INCOMING, MESSAGE_TYPES.OUTGOING];
  if (!isPublicMessage.includes(props.messageType)) return null;
  return KITA_PLATFORMS.includes(props.conversationChannel)
    ? props.conversationChannel
    : null;
});

const shouldGroupWithNext = computed(() => {
  if (props.status === MESSAGE_STATUS.FAILED) return false;

  return props.groupWithNext;
});

const layout = computed(() =>
  getMessageLayout({
    orientation: orientation.value,
    variant: variant.value,
    groupWithPrevious: props.groupWithPrevious,
    groupWithNext: shouldGroupWithNext.value,
    style: layoutStyle.value,
  })
);

const columnClass = computed(() => {
  if (variant.value === MESSAGE_VARIANTS.EMAIL) return 'w-full';
  // Slack/Teams: others read flush across the pane, yours as a bubble
  if (isFlat.value && orientation.value === ORIENTATION.LEFT)
    return 'flex-1 items-start';
  return orientation.value === ORIENTATION.RIGHT
    ? 'max-w-[70%] items-end'
    : 'max-w-[70%] items-start';
});

const componentToRender = computed(() => {
  if (props.isEmailInbox && !props.private) {
    const emailInboxTypes = [MESSAGE_TYPES.INCOMING, MESSAGE_TYPES.OUTGOING];
    if (emailInboxTypes.includes(props.messageType)) return EmailBubble;
  }

  if (props.contentAttributes?.whatsappFlowResponse) {
    return WhatsappFlowResponseBubble;
  }

  if (props.contentType === CONTENT_TYPES.INPUT_CSAT) {
    return CSATBubble;
  }

  if (
    [CONTENT_TYPES.INPUT_SELECT, CONTENT_TYPES.FORM].includes(props.contentType)
  ) {
    return FormBubble;
  }

  if (props.contentType === CONTENT_TYPES.VOICE_CALL) {
    return VoiceCallBubble;
  }

  if (props.contentType === CONTENT_TYPES.INCOMING_EMAIL) {
    return EmailBubble;
  }

  if (props.contentAttributes?.isUnsupported) {
    return UnsupportedBubble;
  }

  if (props.contentAttributes.type === 'dyte') {
    return DyteBubble;
  }

  const instagramSharedTypes = [
    ATTACHMENT_TYPES.STORY_MENTION,
    ATTACHMENT_TYPES.IG_STORY,
    ATTACHMENT_TYPES.IG_STORY_REPLY,
    ATTACHMENT_TYPES.IG_POST,
  ];
  if (instagramSharedTypes.includes(props.contentAttributes.imageType)) {
    return InstagramStoryBubble;
  }

  if (Array.isArray(props.attachments) && props.attachments.length === 1) {
    const fileType = props.attachments[0].fileType;

    if (fileType === ATTACHMENT_TYPES.FALLBACK) return FallbackBubble;

    if (!props.content) {
      if (fileType === ATTACHMENT_TYPES.IMAGE) return ImageBubble;
      if (fileType === ATTACHMENT_TYPES.FILE) return FileBubble;
      if (fileType === ATTACHMENT_TYPES.AUDIO) return AudioBubble;
      if (fileType === ATTACHMENT_TYPES.VIDEO) return VideoBubble;
      if (fileType === ATTACHMENT_TYPES.IG_REEL) return VideoBubble;
      if (fileType === ATTACHMENT_TYPES.EMBED) return EmbedBubble;
      if (fileType === ATTACHMENT_TYPES.LOCATION) return LocationBubble;
    }
    // Attachment content is the name of the contact
    if (fileType === ATTACHMENT_TYPES.CONTACT) return ContactBubble;
  }

  return TextBubble;
});

const shouldShowContextMenu = computed(() => {
  return !props.contentAttributes?.isUnsupported;
});

const isBubble = computed(() => {
  return props.messageType !== MESSAGE_TYPES.ACTIVITY;
});

const isMessageDeleted = computed(() => {
  return props.contentAttributes?.deleted;
});

const shouldShowWhatsappReferral = computed(
  () =>
    variant.value === MESSAGE_VARIANTS.USER &&
    !!props.contentAttributes?.referral
);

const payloadForContextMenu = computed(() => {
  return {
    id: props.id,
    content_attributes: props.contentAttributes,
    content: props.content,
    conversation_id: props.conversationId,
  };
});

const contextMenuEnabledOptions = computed(() => {
  const hasText = !!props.content;
  const hasAttachments = !!(props.attachments && props.attachments.length > 0);

  const isOutgoing = props.messageType === MESSAGE_TYPES.OUTGOING;
  const isFailedOrProcessing =
    props.status === MESSAGE_STATUS.FAILED ||
    props.status === MESSAGE_STATUS.PROGRESS;

  return {
    copy: hasText,
    delete:
      (hasText || hasAttachments) &&
      !isFailedOrProcessing &&
      !isMessageDeleted.value,
    cannedResponse: isOutgoing && hasText && !isMessageDeleted.value,
    copyLink: !isFailedOrProcessing,
    translate: !isFailedOrProcessing && !isMessageDeleted.value && hasText,
    replyTo:
      !props.private &&
      props.inboxSupportsReplyTo.outgoing &&
      !isFailedOrProcessing,
    report:
      isOnChatwootCloud.value &&
      isCaptainMessage.value &&
      !isMessageDeleted.value,
  };
});

const shouldRenderMessage = computed(() => {
  const hasAttachments = !!(props.attachments && props.attachments.length > 0);
  const isEmailContentType = props.contentType === CONTENT_TYPES.INCOMING_EMAIL;
  const isUnsupported = props.contentAttributes?.isUnsupported;
  const isAnIntegrationMessage =
    props.contentType === CONTENT_TYPES.INTEGRATIONS;
  const hasWhatsappFlowResponse =
    !!props.contentAttributes?.whatsappFlowResponse;
  const isFailedMessage = props.status === MESSAGE_STATUS.FAILED;
  const hasExternalError = !!props.contentAttributes?.externalError;

  return (
    hasAttachments ||
    props.content ||
    isEmailContentType ||
    isUnsupported ||
    isAnIntegrationMessage ||
    hasWhatsappFlowResponse ||
    shouldShowWhatsappReferral.value ||
    isFailedMessage ||
    hasExternalError
  );
});

function openContextMenu(e) {
  const shouldSkipContextMenu =
    e.target?.classList.contains('skip-context-menu') ||
    ['a', 'img'].includes(e.target?.tagName.toLowerCase());
  if (shouldSkipContextMenu || getSelection().toString()) {
    return;
  }

  e.preventDefault();
  if (e.type === 'contextmenu') {
    useTrack(ACCOUNT_EVENTS.OPEN_MESSAGE_CONTEXT_MENU);
  }
  contextMenuPosition.value = {
    x: e.pageX || e.clientX,
    y: e.pageY || e.clientY,
  };
  showContextMenu.value = true;
}

function closeContextMenu() {
  showContextMenu.value = false;
  contextMenuPosition.value = { x: null, y: null };
}

function handleReplyTo() {
  const replyStorageKey = LOCAL_STORAGE_KEYS.MESSAGE_REPLY_TO;
  const { conversationId, id: replyTo } = props;

  LocalStorage.updateJsonStore(replyStorageKey, conversationId, replyTo);
  emitter.emit(BUS_EVENTS.TOGGLE_REPLY_TO_MESSAGE, props);
}

const avatarInfo = computed(() => {
  if (props.contentAttributes?.externalEcho) {
    const { name, avatar_url, channel_type, medium, voice_enabled } =
      inbox.value;
    const iconName = avatar_url
      ? null
      : getInboxIconByType(channel_type, medium, 'fill', voice_enabled);
    return {
      name: iconName ? '' : name || t('CONVERSATION.NATIVE_APP'),
      src: avatar_url || '',
      iconName,
    };
  }

  // If no sender, check for Slack (or other integration) sender info
  if (!props.sender) {
    const { senderName, senderAvatarUrl } = props.additionalAttributes || {};
    if (senderName) {
      return { name: senderName, src: senderAvatarUrl ?? '' };
    }
    return { name: t('CONVERSATION.BOT'), src: '' };
  }

  const { sender } = props;
  const { name, type, avatarUrl, thumbnail } = sender || {};

  // If sender type is agent bot, use avatarUrl
  if ([SENDER_TYPES.AGENT_BOT, SENDER_TYPES.CAPTAIN_ASSISTANT].includes(type)) {
    return {
      name: name ?? '',
      src: avatarUrl ?? '',
    };
  }

  // For all other senders, use thumbnail
  return {
    name: name ?? '',
    src: thumbnail ?? '',
  };
});

const avatarTooltip = computed(() => {
  if (props.contentAttributes?.externalEcho) {
    return replaceInstallationName(t('CONVERSATION.NATIVE_APP_ADVISORY'));
  }
  if (avatarInfo.value.name === '') return '';
  return `${t('CONVERSATION.SENT_BY')} ${avatarInfo.value.name}`;
});

const setupHighlightTimer = () => {
  if (Number(route.query.messageId) !== Number(props.id)) {
    return;
  }

  showBackgroundHighlight.value = true;
  const HIGHLIGHT_TIMER = 1000;
  useTimeoutFn(() => {
    showBackgroundHighlight.value = false;
  }, HIGHLIGHT_TIMER);
};

onMounted(setupHighlightTimer);

// Flat layout names you "You"; mirror footers read "Jun · 11:40 AM"
const displayName = computed(() =>
  isOwn.value && isFlat.value
    ? t('CONVERSATION.KITA_YOU')
    : avatarInfo.value.name
);

const mirrorFooter = computed(() => {
  const time = messageStamp(props.createdAt);
  if (orientation.value === ORIENTATION.RIGHT) {
    return [
      t('CONVERSATION.KITA_YOU'),
      t('CONVERSATION.KITA_FROM_PHONE'),
      time,
    ].join(' · ');
  }
  const [first] = (avatarInfo.value.name || '').split(' ');
  const tag = isExternalMessage.value
    ? t('CONVERSATION.KITA_EXTERNAL_TAG')
    : isTeammateMessage.value && t('CONVERSATION.KITA_TEAMMATE_TAG');
  return [first, tag, time].filter(Boolean).join(' · ');
});

// Full-width strips: a bridge notice (not sent / mirror) replaces the bubble;
// a failed send adds one under the message
const platformName = useKitaPlatformName();
const notice = computed(() => kitaNotice(props));
const noticePlatform = computed(
  () => notice.value?.platform || props.conversationChannel
);
const notSentText = (platform, reason, error) => {
  const name = platformName(platform);
  const detail = reason
    ? t(`CONVERSATION.KITA_STRIP.REASONS.${reason}`, {
        platform: name,
        place: t(
          `CONVERSATION.KITA_STRIP.PLACES.${platform === 'teams' ? 'chat' : 'channel'}`
        ),
        error,
      })
    : t('CONVERSATION.KITA_STRIP.REASONS.unknown');
  return name
    ? t('CONVERSATION.KITA_STRIP.NOT_SENT', { platform: name, reason: detail })
    : t('CONVERSATION.KITA_STRIP.NOT_SENT_GENERIC', { reason: detail });
};
const noticeStrip = computed(() => {
  const value = notice.value;
  if (!value) return null;
  const name = platformName(noticePlatform.value);
  if (value.kind === 'mirror') {
    return {
      tone: 'info',
      text: t('CONVERSATION.KITA_STRIP.MIRROR', { platform: name }),
    };
  }
  return {
    tone: 'error',
    text: notSentText(noticePlatform.value, value.reason || 'unknown'),
    connectLabel: value.reason === 'not_connected' ? name : '',
    connectUrl: value.connectUrl || '',
  };
});
const errorStrip = computed(() => {
  const error = props.contentAttributes?.externalError;
  if (!error) return null;
  const { reason, text } = failedSendReason(error);
  const platform = sourcePlatform.value || props.conversationChannel;
  return {
    text: notSentText(platform, reason, text),
    canRetry: canRetryFailed(props, hasOneDayPassed(props.createdAt)),
    connectLabel: reason === 'not_connected' ? platformName(platform) : '',
  };
});

provideMessageContext({
  ...toRefs(props),
  isPrivate: computed(() => props.private),
  variant,
  orientation,
  isBotOrAgentMessage,
  shouldGroupWithNext,
  timeInHeader: computed(() => layout.value.timeInHeader),
  layoutStyle,
});
</script>

<!-- eslint-disable-next-line vue/no-root-v-if -->
<template>
  <div
    v-if="shouldRenderMessage"
    :id="`message${props.id}`"
    class="flex flex-col w-full message-bubble-container"
    :data-message-id="props.id"
    :class="[
      {
        'group-with-next mb-1': shouldGroupWithNext,
        'mb-4': !shouldGroupWithNext,
        'bg-n-alpha-1': showBackgroundHighlight,
        'bg-woot-25 dark:bg-n-alpha-2 rounded-xl px-4 py-3.5': isOpenThreadRoot,
      },
    ]"
    :data-thread-open="isOpenThreadRoot || undefined"
  >
    <MessageStrip
      v-if="noticeStrip"
      :tone="noticeStrip.tone"
      :text="noticeStrip.text"
      :connect-label="noticeStrip.connectLabel"
      :connect-url="noticeStrip.connectUrl"
    />
    <ActivityBubble
      v-else-if="variant === MESSAGE_VARIANTS.ACTIVITY"
      :content="content"
    />
    <div
      v-else
      data-test="message-row"
      class="flex w-full min-w-0 gap-2 group/message"
      :class="flexOrientationClass"
    >
      <div
        v-if="layout.avatarColumn"
        data-test="message-avatar-column"
        class="shrink-0"
        :class="isFlat ? 'w-9 me-1' : 'w-8'"
      >
        <div v-if="layout.showAvatar" v-tooltip.left-end="avatarTooltip">
          <MessageSenderAvatar
            v-bind="avatarInfo"
            :platform="isFlat ? null : sourcePlatform"
            :size="isFlat ? 36 : 32"
          />
        </div>
      </div>
      <div
        data-test="message-column"
        class="flex flex-col min-w-0"
        :class="columnClass"
      >
        <div
          v-if="layout.showHeader"
          data-test="message-header"
          class="flex items-baseline min-w-0 gap-2 mb-1"
          :class="{ 'justify-end': orientation === ORIENTATION.RIGHT }"
        >
          <template v-if="orientation === ORIENTATION.LEFT">
            <span
              v-if="displayName"
              data-test="message-sender-name"
              class="text-sm font-semibold truncate text-n-slate-12"
            >
              {{ displayName }}
            </span>
            <span
              v-if="isTeammateMessage"
              data-test="message-teammate-tag"
              class="text-xs font-medium rounded shrink-0 text-n-brand"
              :class="{ 'px-1 bg-woot-50 dark:bg-woot-800/60': !isFlat }"
            >
              {{ t('CONVERSATION.KITA_TEAMMATE_TAG') }}
            </span>
            <span
              v-else-if="isExternalMessage"
              data-test="message-external-tag"
              class="text-xs font-medium rounded shrink-0 text-n-slate-11"
              :class="{ 'px-1 bg-n-alpha-2': !isFlat }"
            >
              {{ t('CONVERSATION.KITA_EXTERNAL_TAG') }}
            </span>
          </template>
          <span
            v-else-if="isFlat"
            data-test="message-sender-name"
            class="text-xs text-n-slate-11"
          >
            {{ t('CONVERSATION.KITA_YOU') }} ·
          </span>
          <MessageMeta compact class="shrink-0 text-n-slate-11" />
        </div>
        <div
          data-test="message-bubble"
          class="flex max-w-full min-w-0"
          :class="{
            'justify-end': orientation === ORIENTATION.RIGHT,
            'gap-1.5': layout.followUpMeta && !kitaThread,
            'w-full': variant === MESSAGE_VARIANTS.EMAIL,
            'flex-col items-start gap-2': shouldShowWhatsappReferral,
            'flex-col gap-1': kitaThread,
            'items-end': kitaThread && orientation === ORIENTATION.RIGHT,
            'items-start': kitaThread && orientation === ORIENTATION.LEFT,
          }"
          @contextmenu="openContextMenu($event)"
        >
          <WhatsappReferral
            v-if="shouldShowWhatsappReferral"
            :referral="contentAttributes.referral"
          />
          <Component :is="componentToRender" />
          <MessageMeta
            v-if="layout.followUpMeta"
            compact
            hover-time
            data-test="message-follow-up-meta"
            class="self-end shrink-0 whitespace-nowrap text-n-slate-11"
            :class="{ 'order-first': orientation === ORIENTATION.RIGHT }"
          />
          <KitaThreadFooter
            v-if="kitaThread"
            :thread="kitaThread"
            :conversation-id="conversationId"
          />
        </div>
        <p
          v-if="layout.showFooter"
          data-test="message-footer"
          class="px-1 mt-1 mb-0 text-xs text-n-slate-11"
        >
          {{ mirrorFooter }}
        </p>

      </div>
    </div>
    <MessageStrip
      v-if="errorStrip && !noticeStrip"
      :text="errorStrip.text"
      :can-retry="errorStrip.canRetry"
      :connect-label="errorStrip.connectLabel"
      @retry="emit('retry')"
    />
    <div v-if="shouldShowContextMenu" class="context-menu-wrap">
      <ContextMenu
        v-if="isBubble"
        :context-menu-position="contextMenuPosition"
        :is-open="showContextMenu"
        :enabled-options="contextMenuEnabledOptions"
        :message="payloadForContextMenu"
        hide-button
        @open="openContextMenu"
        @close="closeContextMenu"
        @reply-to="handleReplyTo"
      />
    </div>
  </div>
</template>

<style lang="scss">
.group-with-next + .message-bubble-container {
  .left-bubble {
    @apply ltr:rounded-tl-sm rtl:rounded-tr-sm;
  }

  .right-bubble {
    @apply ltr:rounded-tr-sm rtl:rounded-tl-sm;
  }
}
</style>
