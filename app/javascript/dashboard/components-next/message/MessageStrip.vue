<script setup>
import { useI18n } from 'vue-i18n';
import { openKitaConnect } from 'dashboard/helper/kitaConnect';

// A full-width strip across the conversation pane: a reply that was not sent
// (light red, with Retry / Connect) or a bridge notice (subtle panel).
const props = defineProps({
  tone: {
    type: String,
    default: 'error',
    validator: value => ['error', 'info'].includes(value),
  },
  text: { type: String, required: true },
  canRetry: { type: Boolean, default: false },
  // Platform name for "Connect Slack"; empty = no connect action
  connectLabel: { type: String, default: '' },
  connectUrl: { type: String, default: '' },
});

const emit = defineEmits(['retry']);
const { t } = useI18n();

const connect = () => {
  if (props.connectUrl) window.open(props.connectUrl, '_blank', 'noopener');
  else openKitaConnect();
};
</script>

<template>
  <div
    data-test="message-strip"
    :data-tone="tone"
    class="flex items-center w-full gap-3 px-4 py-2.5 my-1 text-sm rounded-lg"
    :class="
      tone === 'error'
        ? 'bg-n-ruby-2 text-n-ruby-12 outline outline-1 outline-n-ruby-4'
        : 'bg-n-alpha-1 text-n-slate-11 outline outline-1 outline-n-weak'
    "
  >
    <span
      class="shrink-0 size-4"
      :class="
        tone === 'error'
          ? 'i-lucide-circle-alert text-n-ruby-11'
          : 'i-lucide-info text-n-slate-11'
      "
    />
    <span class="flex-1 min-w-0" data-test="message-strip-text">
      {{ text }}
    </span>
    <span class="flex items-center gap-3 shrink-0">
      <button
        v-if="canRetry"
        type="button"
        data-test="message-strip-retry"
        class="font-medium hover:underline"
        @click="emit('retry')"
      >
        {{ t('CONVERSATION.KITA_STRIP.RETRY') }}
      </button>
      <button
        v-if="connectLabel"
        type="button"
        data-test="message-strip-connect"
        class="font-medium hover:underline"
        @click="connect"
      >
        {{ t('CONVERSATION.KITA_STRIP.CONNECT', { platform: connectLabel }) }}
      </button>
    </span>
  </div>
</template>
