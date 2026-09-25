<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useMapGetter } from 'dashboard/composables/store';
import { listQuery } from 'dashboard/helper/kitaInbox';

// The conversation pane with no customer open: Inbox zero when nobody is
// waiting on me, otherwise a nudge to pick a row.
const { t } = useI18n();
const route = useRoute();
const meta = useMapGetter('kitaInbox/getMeta');
const isFetching = useMapGetter('kitaInbox/isFetching');
const filters = useMapGetter('kitaInbox/getFilters');

const isClear = computed(() => !meta.value.needs_reply);
const allRoute = computed(() => ({
  name: 'kita_inbox',
  query: { ...listQuery(route.query), scope: 'all' },
}));
</script>

<template>
  <div
    class="flex flex-col items-center justify-center flex-1 gap-3 px-10 text-center"
    data-test-id="kita-inbox-empty"
  >
    <template v-if="!isFetching">
      <span
        class="grid rounded-full size-14 place-content-center bg-woot-25 dark:bg-n-alpha-2"
      >
        <span
          class="size-7 text-n-brand"
          :class="isClear ? 'i-lucide-check-check' : 'i-lucide-inbox'"
        />
      </span>
      <h2 class="m-0 text-2xl font-bold font-interDisplay text-n-slate-12">
        {{ isClear ? t('KITA_INBOX.CLEAR.TITLE') : t('KITA_INBOX.PICK.TITLE') }}
      </h2>
      <p class="max-w-sm m-0 text-sm text-n-slate-11">
        {{
          isClear
            ? t('KITA_INBOX.CLEAR.DESCRIPTION')
            : t('KITA_INBOX.PICK.DESCRIPTION')
        }}
      </p>
      <RouterLink
        v-if="isClear && filters.scope === 'mine'"
        :to="allRoute"
        class="text-sm font-medium text-n-brand hover:underline"
      >
        {{ t('KITA_INBOX.CLEAR.SEE_ALL') }}
      </RouterLink>
    </template>
  </div>
</template>
