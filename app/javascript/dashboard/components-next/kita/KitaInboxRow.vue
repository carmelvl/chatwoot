<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { vOnClickOutside } from '@vueuse/components';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import { rowPlatforms } from 'dashboard/helper/kitaInbox';
import { dynamicTime, shortTimestamp } from 'shared/helpers/timeHelper';
import DropdownMenu from 'dashboard/components-next/dropdown-menu/DropdownMenu.vue';
import ChannelIcon from 'next/icon/ChannelIcon.vue';
import PlatformLogo from './PlatformLogo.vue';
import { customerPreview, firstName } from './customersHelper';

// One Inbox row (Paper S03, customers list):
//   1. unread dot · name ··· relative time
//   2. ‹logo› Sender: preview (one logo; several platforms = a tight strip)
//   3. only when needed: the urgent ticket (red), else the owner and "Not linked"
// Row actions (select, link, not a customer) sit in a hover "⋯" menu.
const props = defineProps({
  row: { type: Object, required: true },
  active: { type: Boolean, default: false },
  focused: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  canLink: { type: Boolean, default: false },
  currentUserName: { type: String, default: '' },
});

const emit = defineEmits(['open', 'action']);

const { t } = useI18n();
const platformName = useKitaPlatformName();

const platforms = computed(() => rowPlatforms(props.row, KITA_PLATFORMS));
// Line 2 logos: the message's platform, or every platform of a multi-platform customer
const logos = computed(() => {
  if (platforms.value.length > 1) return platforms.value;
  const platform = props.row.last_message?.platform || platforms.value[0];
  return KITA_PLATFORMS.includes(platform) ? [platform] : [];
});
// Conversations from other inboxes (website, email…) show their channel icon
const channelInbox = computed(() => {
  const [conversation] = props.row.conversations || [];
  return props.row.kind === 'conversation' && conversation?.channel_type
    ? { channel_type: conversation.channel_type }
    : null;
});

const preview = computed(() =>
  customerPreview(props.row, {
    you: t('KITA_CUSTOMERS.YOU'),
    currentUserName: props.currentUserName,
  })
);
const time = computed(() =>
  props.row.last_activity_at
    ? shortTimestamp(dynamicTime(props.row.last_activity_at))
    : ''
);
const isUnread = computed(() => props.row.unread_count > 0);

const ticket = computed(() =>
  props.row.urgent_ticket ? props.row.top_ticket : null
);
const urgentLine = computed(() => {
  if (!props.row.urgent_ticket) return '';
  const more = Math.max(0, (props.row.pressing_tickets || 0) - 1);
  return [
    ticket.value?.display_id
      ? `${t('KITA_CUSTOMERS.URGENT_TICKET')} ${ticket.value.display_id}`
      : t('KITA_CUSTOMERS.URGENT_TICKET'),
    ticket.value?.title,
    more ? t('KITA_INBOX.MORE_TICKETS', { count: more }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
});
const mutedLine = computed(() =>
  [
    props.row.unlinked ? t('KITA_INBOX.NOT_LINKED') : null,
    props.row.stage,
    firstName(props.row.dri_name),
  ]
    .filter(Boolean)
    .join(' · ')
);

const showMenu = ref(false);
const menuItems = computed(() => [
  {
    label: props.selected
      ? t('KITA_INBOX.BULK.DESELECT')
      : t('KITA_INBOX.BULK.SELECT'),
    value: 'select',
    action: 'select',
  },
  ...(props.row.kind === 'unlinked' && props.canLink
    ? [
        {
          label: t('KITA_CUSTOMERS.LINK_TO_CUSTOMER'),
          value: 'link',
          action: 'link',
        },
      ]
    : []),
  ...(props.row.kind === 'unlinked'
    ? [
        {
          label: props.row.not_customer
            ? t('KITA_INBOX.BACK_TO_INBOX')
            : t('KITA_INBOX.NOT_A_CUSTOMER'),
          value: 'not_customer',
          action: props.row.not_customer ? 'customer' : 'not_customer',
        },
      ]
    : []),
]);
const onMenu = ({ action }) => {
  showMenu.value = false;
  emit('action', action, props.row);
};
</script>

<template>
  <div
    data-test="kita-inbox-row"
    role="button"
    tabindex="0"
    class="relative flex flex-col gap-1 px-3 py-3 cursor-pointer group rounded-xl kita-inbox-row"
    :class="[
      active
        ? 'bg-woot-25 dark:bg-n-alpha-2 active'
        : selected
          ? 'bg-n-alpha-1'
          : 'hover:bg-n-alpha-1',
      { 'ring-1 ring-n-slate-7': focused && !active },
    ]"
    @click="emit('open', row)"
    @keydown.enter="emit('open', row)"
  >
    <span class="flex items-center min-w-0 gap-2">
      <span
        v-if="isUnread"
        data-test="kita-inbox-unread"
        class="rounded-full size-2 shrink-0 bg-n-brand"
        :title="t('KITA_INBOX.UNREAD')"
      />
      <span
        v-if="selected"
        class="i-lucide-check-square size-3.5 shrink-0 text-n-brand"
      />
      <span class="text-sm font-semibold truncate text-n-slate-12">
        {{ row.name || t('KITA_INBOX.UNNAMED') }}
      </span>
      <span
        class="text-xs ms-auto shrink-0 text-n-slate-11 group-hover:invisible"
        data-test="kita-inbox-time"
      >
        {{ time }}
      </span>
    </span>

    <span class="flex items-center min-w-0 gap-1.5">
      <span
        v-if="logos.length || channelInbox"
        class="flex items-center gap-0.5 shrink-0"
      >
        <PlatformLogo
          v-for="platform in logos"
          :key="platform"
          :platform="platform"
          :title="platformName(platform)"
          data-test="kita-inbox-logo"
          class="size-3.5"
        />
        <ChannelIcon
          v-if="channelInbox"
          :inbox="channelInbox"
          class="size-3.5 text-n-slate-11"
        />
      </span>
      <span
        class="text-sm truncate text-n-slate-11"
        data-test="kita-inbox-preview"
      >
        {{ preview }}
      </span>
    </span>

    <span
      v-if="urgentLine"
      class="text-xs font-medium truncate text-n-ruby-11"
      data-test="kita-inbox-urgent"
    >
      {{ urgentLine }}
    </span>
    <span
      v-else-if="mutedLine"
      class="text-xs truncate text-n-slate-11"
      data-test="kita-inbox-muted"
    >
      {{ mutedLine }}
    </span>

    <div
      v-on-click-outside="() => (showMenu = false)"
      class="absolute top-2 end-2"
      :class="showMenu ? 'visible' : 'invisible group-hover:visible'"
      @click.stop
    >
      <button
        type="button"
        class="grid rounded-md size-6 place-content-center text-n-slate-11 hover:bg-n-alpha-2 hover:text-n-slate-12"
        :aria-label="t('KITA_INBOX.ROW_ACTIONS')"
        data-test="kita-inbox-row-menu"
        @click="showMenu = !showMenu"
      >
        <span class="i-lucide-ellipsis size-4" />
      </button>
      <DropdownMenu
        v-if="showMenu"
        :menu-items="menuItems"
        class="mt-1 top-full ltr:right-0 rtl:left-0 min-w-44"
        data-test="kita-inbox-row-actions"
        @action="onMenu"
      />
    </div>
  </div>
</template>
