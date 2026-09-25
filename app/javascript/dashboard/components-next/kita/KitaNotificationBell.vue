<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { vOnClickOutside } from '@vueuse/components';
import { useMapGetter } from 'dashboard/composables/store';
import { dynamicTime, shortTimestamp } from 'shared/helpers/timeHelper';
import {
  bellItems,
  notificationRoute,
} from 'dashboard/helper/kitaNotifications';

// Kita: mentions and assignment notifications (Chatwoot's notifications) in
// the sidebar header. Each opens its conversation in the unified view; the
// Mentions filter also opens the Inbox on mentioned conversations.
defineProps({
  isCollapsed: { type: Boolean, default: false },
});

const { t } = useI18n();
const store = useStore();
const router = useRouter();

const accountId = useMapGetter('getCurrentAccountId');
const unreadCount = useMapGetter('notifications/getUnreadCount');
const meta = useMapGetter('notifications/getMeta');
const records = useMapGetter('notifications/getFilteredNotificationsV4');
const uiFlags = useMapGetter('notifications/getUIFlags');

const isOpen = ref(false);
const mentionsOnly = ref(false);

const items = computed(() =>
  bellItems(records.value({ sortOrder: 'desc' }), {
    mentionsOnly: mentionsOnly.value,
  })
);

const toggle = () => {
  isOpen.value = !isOpen.value;
  if (isOpen.value) {
    store.dispatch('notifications/clear');
    store.dispatch('notifications/index', { page: 1, sortOrder: 'desc' });
  }
};

const open = async notification => {
  isOpen.value = false;
  if (!notification.readAt) {
    await store.dispatch('notifications/read', {
      id: notification.id,
      primaryActorId: notification.primaryActorId,
      primaryActorType: notification.primaryActorType,
      unreadCount: meta.value.unreadCount,
    });
    store.dispatch('notifications/unReadCount');
  }
  router.push(notificationRoute(notification, accountId.value));
};

const readAll = () => store.dispatch('notifications/readAll');

const time = notification =>
  shortTimestamp(dynamicTime(notification.lastActivityAt));

const mentionsRoute = computed(() => ({
  name: 'kita_inbox',
  params: { accountId: accountId.value },
  query: { scope: 'all', status: 'all', type: 'mention' },
}));
</script>

<template>
  <div
    v-on-click-outside="() => (isOpen = false)"
    class="relative"
    data-test-id="kita-notification-bell"
  >
    <button
      type="button"
      class="relative flex items-center justify-center rounded-lg outline outline-1 outline-n-weak bg-n-button-color hover:bg-n-alpha-2 dark:hover:bg-n-slate-9/30"
      :class="isCollapsed ? 'size-8' : 'size-7'"
      :title="t('KITA_BELL.TITLE')"
      :aria-label="t('KITA_BELL.TITLE')"
      @click="toggle"
    >
      <span class="i-lucide-bell size-4 text-n-slate-11" />
      <span
        v-if="unreadCount"
        data-test="kita-bell-count"
        class="absolute -top-1.5 -end-1.5 grid px-1 text-[0.625rem] font-semibold text-white rounded-full min-w-4 h-4 place-content-center bg-n-ruby-9"
      >
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>
    <div
      v-if="isOpen"
      class="absolute z-50 mt-2 overflow-hidden shadow-lg ltr:left-0 rtl:right-0 top-full w-80 rounded-xl bg-n-alpha-3 backdrop-blur-[100px] outline outline-1 outline-n-container"
      data-test-id="kita-bell-panel"
    >
      <div class="flex items-center justify-between px-4 pt-3 pb-2">
        <span class="text-sm font-semibold text-n-slate-12">
          {{ t('KITA_BELL.TITLE') }}
        </span>
        <button
          v-if="unreadCount"
          type="button"
          class="text-xs text-n-slate-11 hover:text-n-slate-12"
          @click="readAll"
        >
          {{ t('KITA_BELL.READ_ALL') }}
        </button>
      </div>
      <div class="flex gap-4 px-4 border-b border-n-weak">
        <button
          v-for="option in [false, true]"
          :key="String(option)"
          type="button"
          class="pb-2 -mb-px text-xs border-b-2"
          :class="
            mentionsOnly === option
              ? 'font-medium text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent'
          "
          @click="mentionsOnly = option"
        >
          {{ option ? t('KITA_BELL.MENTIONS') : t('KITA_BELL.ALL') }}
        </button>
      </div>
      <ul class="m-0 overflow-y-auto list-none max-h-96">
        <li
          v-if="!uiFlags.isFetching && !items.length"
          class="px-4 py-8 text-sm text-center text-n-slate-11"
        >
          {{ t('KITA_BELL.EMPTY') }}
        </li>
        <li v-for="notification in items" :key="notification.id">
          <button
            type="button"
            data-test="kita-bell-item"
            class="flex w-full gap-3 px-4 py-3 text-start hover:bg-n-alpha-1"
            @click="open(notification)"
          >
            <span
              class="mt-1.5 size-2 rounded-full shrink-0"
              :class="notification.readAt ? 'bg-transparent' : 'bg-n-brand'"
            />
            <span class="flex flex-col flex-1 min-w-0 gap-0.5">
              <span class="text-xs font-medium text-n-slate-11">
                {{ t(`KITA_BELL.TYPES.${notification.kind}`) }}
              </span>
              <span class="text-sm text-n-slate-12 line-clamp-2">
                {{ notification.pushMessageTitle }}
              </span>
            </span>
            <span class="text-xs text-n-slate-11 shrink-0">
              {{ time(notification) }}
            </span>
          </button>
        </li>
      </ul>
      <div
        class="flex items-center justify-between px-4 py-2.5 border-t border-n-weak"
      >
        <RouterLink
          :to="mentionsRoute"
          class="text-xs font-medium text-n-brand hover:underline"
          data-test="kita-bell-mentions-inbox"
          @click="isOpen = false"
        >
          {{ t('KITA_BELL.MENTIONS_IN_INBOX') }}
        </RouterLink>
        <RouterLink
          :to="{ name: 'inbox_view', params: { accountId } }"
          class="text-xs text-n-slate-11 hover:text-n-slate-12"
          @click="isOpen = false"
        >
          {{ t('KITA_BELL.SEE_ALL') }}
        </RouterLink>
      </div>
    </div>
  </div>
</template>
