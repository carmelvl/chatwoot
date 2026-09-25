<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMapGetter } from 'dashboard/composables/store';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import {
  platformStates,
  rowWait,
  shortDuration,
} from 'dashboard/helper/kitaInbox';
import Avatar from 'dashboard/components-next/avatar/Avatar.vue';
import ChannelIcon from 'next/icon/ChannelIcon.vue';
import PlatformLogo from './PlatformLogo.vue';
import { customerPreview } from './customersHelper';

// One Inbox row (S03): name + stage, DRI and wait; platform logos with their
// state; the waiting (or latest) message; the pressing ticket; labels.
const props = defineProps({
  row: { type: Object, required: true },
  active: { type: Boolean, default: false },
  focused: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  currentUserName: { type: String, default: '' },
});

defineEmits(['open', 'toggleSelect']);

const MAX_LABELS = 3;

const { t } = useI18n();
const platformName = useKitaPlatformName();
const agents = useMapGetter('agents/getAgents');

const states = computed(() => platformStates(props.row));
// Conversations from other inboxes (website, email…) show their channel icon
const channelInbox = computed(() => {
  const [conversation] = props.row.conversations || [];
  return props.row.kind === 'conversation' && conversation?.channel_type
    ? { channel_type: conversation.channel_type }
    : null;
});

const message = computed(() => props.row.last_message);
// "Slack · Maria: batch 14 came back empty"
const preview = computed(() => {
  const text = customerPreview(props.row, {
    you: t('KITA_CUSTOMERS.YOU'),
    currentUserName: props.currentUserName,
  });
  const platform = platformName(message.value?.platform);
  return text && platform ? `${platform} · ${text}` : text;
});

const wait = computed(() => {
  const value = rowWait(props.row, Math.floor(Date.now() / 1000));
  if (!value) return '';
  const duration = shortDuration(value.seconds);
  return value.waiting ? t('KITA_INBOX.WAITING', { duration }) : duration;
});
const isWaiting = computed(() => props.row.section === 'needs_reply');
// Red only when an urgent ticket is open (no SLA on the desk)
const isUrgent = computed(() => !!props.row.urgent_ticket);
const isPinned = computed(
  () => isWaiting.value && props.row.pressing_tickets > 0
);

const dri = computed(
  () =>
    agents.value.find(agent => agent.id === props.row.dri_id) ??
    (props.row.dri_name ? { name: props.row.dri_name } : null)
);

const ticket = computed(() => props.row.top_ticket);
const ticketLine = computed(() => {
  if (!ticket.value) return '';
  return [
    ticket.value.display_id,
    t(`KITA_THREADS.PRIORITY.${ticket.value.priority}`),
    ticket.value.title,
  ]
    .filter(Boolean)
    .join(' · ');
});
const moreTickets = computed(() =>
  Math.max(0, (props.row.pressing_tickets || 0) - 1)
);

const labels = computed(() => (props.row.labels || []).slice(0, MAX_LABELS));
const extraLabels = computed(() =>
  Math.max(0, (props.row.labels || []).length - MAX_LABELS)
);

const STATE_CLASS = {
  needs_reply: '',
  open: '',
  pending: '',
  snoozed: 'opacity-60',
  resolved: 'opacity-35 grayscale',
};
</script>

<template>
  <div
    data-test="kita-inbox-row"
    role="button"
    tabindex="0"
    class="relative flex gap-2 px-3 py-3 cursor-pointer rounded-xl kita-inbox-row"
    :class="[
      active
        ? 'bg-woot-25 dark:bg-n-alpha-2 outline outline-1 outline-woot-100 dark:outline-n-weak active'
        : 'hover:bg-n-alpha-1',
      { 'ring-1 ring-n-slate-7': focused && !active },
    ]"
    @click="$emit('open', row)"
    @keydown.enter="$emit('open', row)"
  >
    <span
      v-if="isPinned"
      data-test="kita-inbox-pinned"
      class="absolute inset-y-2 w-0.5 rounded-full ltr:left-0 rtl:right-0 bg-n-ruby-9"
    />
    <span class="flex flex-col items-center w-4 pt-0.5 shrink-0">
      <input
        type="checkbox"
        class="size-3.5 cursor-pointer accent-n-brand"
        :class="selected ? '' : 'opacity-0 group-hover:opacity-100'"
        :checked="selected"
        :aria-label="t('KITA_INBOX.BULK.SELECT')"
        data-test="kita-inbox-select"
        @click.stop="$emit('toggleSelect', row)"
      />
    </span>
    <span class="flex flex-col flex-1 min-w-0 gap-1">
      <span class="flex items-center min-w-0 gap-2">
        <span
          class="text-sm truncate text-n-slate-12"
          :class="row.unread_count ? 'font-semibold' : 'font-medium'"
        >
          {{ row.name || t('KITA_INBOX.UNNAMED') }}
        </span>
        <span
          v-if="row.stage"
          class="px-1.5 py-px text-[0.625rem] font-medium rounded-full bg-woot-50 text-woot-700 dark:bg-n-alpha-2 dark:text-n-slate-11 shrink-0"
        >
          {{ row.stage }}
        </span>
        <span
          v-if="row.unlinked"
          class="px-1.5 py-px text-[0.625rem] rounded-full bg-n-alpha-2 text-n-slate-11 shrink-0"
        >
          {{ t('KITA_INBOX.NOT_LINKED') }}
        </span>
        <span class="flex items-center gap-1.5 ms-auto shrink-0">
          <Avatar
            v-if="dri"
            :name="dri.name"
            :src="dri.thumbnail"
            :size="16"
            rounded-full
            :title="t('KITA_INBOX.DRI', { name: dri.name })"
          />
          <span
            class="text-xs"
            :class="
              isWaiting && isUrgent
                ? 'font-medium text-n-ruby-11'
                : 'text-n-slate-11'
            "
            data-test="kita-inbox-wait"
          >
            {{ wait }}
          </span>
        </span>
      </span>

      <span class="flex items-center gap-1.5">
        <span
          v-for="item in states"
          :key="item.platform"
          class="relative inline-flex"
          :title="platformName(item.platform)"
          data-test="kita-inbox-platform"
        >
          <PlatformLogo
            :platform="item.platform"
            class="size-4"
            :class="STATE_CLASS[item.state]"
          />
          <span
            v-if="item.state === 'snoozed'"
            class="absolute -bottom-1 -end-1 i-lucide-clock size-2.5 text-n-slate-11"
          />
          <span
            v-else-if="item.unread"
            class="absolute -top-0.5 -end-0.5 size-1.5 rounded-full bg-n-brand"
          />
        </span>
        <ChannelIcon
          v-if="channelInbox"
          :inbox="channelInbox"
          class="size-4 text-n-slate-11"
        />
      </span>

      <span v-if="preview" class="flex items-start gap-1.5 min-w-0">
        <PlatformLogo
          v-if="platformName(message?.platform)"
          :platform="message.platform"
          class="size-3.5 mt-0.5 shrink-0"
        />
        <span class="flex-1 min-w-0 text-sm text-n-slate-11 line-clamp-2">
          {{ preview }}
        </span>
        <span
          v-if="row.unread_count"
          class="grid px-1 text-xs font-medium text-white rounded-full min-w-4 h-4 place-content-center bg-n-brand shrink-0"
        >
          {{ row.unread_count }}
        </span>
      </span>

      <span
        v-if="ticket"
        data-test="kita-inbox-ticket"
        class="text-xs truncate"
        :class="
          ticket.priority === 'urgent'
            ? 'font-medium text-n-ruby-11'
            : 'text-n-amber-11'
        "
      >
        {{ ticketLine }}
        <template v-if="moreTickets">
          {{ t('KITA_INBOX.MORE_TICKETS', { count: moreTickets }) }}
        </template>
      </span>

      <span v-if="labels.length" class="flex flex-wrap gap-1">
        <span
          v-for="label in labels"
          :key="label"
          class="px-1.5 py-px text-[0.625rem] rounded-md bg-n-alpha-2 text-n-slate-11"
        >
          {{ label }}
        </span>
        <span v-if="extraLabels" class="text-[0.625rem] text-n-slate-11">
          +{{ extraLabels }}
        </span>
      </span>
    </span>
  </div>
</template>
