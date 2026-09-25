<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { useAdmin } from 'dashboard/composables/useAdmin';
import { useKeyboardEvents } from 'dashboard/composables/useKeyboardEvents';
import { useSnakeCase } from 'dashboard/composables/useTransformKeys';
import {
  KITA_SNOOZE_OPTIONS,
  useKitaAccountActions,
} from 'dashboard/composables/useKitaAccountActions';
import filterQueryGenerator from 'dashboard/helper/filterQueryGenerator';
import {
  COLLAPSED_SECTIONS,
  INBOX_SCOPES,
  activeFilterCount,
  filtersFromQuery,
  queryFromFilters,
  rowRoute,
  sectionRows,
} from 'dashboard/helper/kitaInbox';
import ConversationFilter from 'next/filter/ConversationFilter.vue';
import SaveCustomView from 'next/filter/SaveCustomView.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import KitaFilterMenu from './KitaFilterMenu.vue';
import KitaInboxRow from './KitaInboxRow.vue';
import KitaInboxFilterBar from './KitaInboxFilterBar.vue';
import KitaLinkCustomerModal from './KitaLinkCustomerModal.vue';

const props = defineProps({
  // The open row ('' = none)
  customerId: { type: String, default: '' },
});

const REFRESH_MS = 30_000;

const { t } = useI18n();
const store = useStore();
const route = useRoute();
const router = useRouter();
const { isAdmin } = useAdmin();
const { act, snooze } = useKitaAccountActions();

const accountId = useMapGetter('getCurrentAccountId');
const currentUser = useMapGetter('getCurrentUser');
const rows = useMapGetter('kitaInbox/getRows');
const meta = useMapGetter('kitaInbox/getMeta');
const isFetching = useMapGetter('kitaInbox/isFetching');
const labels = useMapGetter('labels/getLabels');
const agents = useMapGetter('agents/getAgents');
const views = useMapGetter('customViews/getConversationCustomViews');
const appliedFiltersQuery = useMapGetter('getAppliedConversationFiltersQuery');

// Advanced filters (Chatwoot's filter popover) aren't in the URL
const advanced = ref(null);
const filters = computed(() => ({
  ...filtersFromQuery(route.query),
  advanced: advanced.value,
}));

const fetchRows = async (more = false) => {
  try {
    await store.dispatch('kitaInbox/fetch', { more });
  } catch {
    useAlert(t('KITA_INBOX.FETCH_ERROR'));
  }
};

watch(
  filters,
  value => {
    store.commit('kitaInbox/SET_KITA_INBOX_FILTERS', value);
    fetchRows();
  },
  { immediate: true, deep: true }
);

let timer;
onMounted(() => {
  store.dispatch('labels/get');
  store.dispatch('teams/get');
  store.dispatch('customViews/get', 'conversation');
  timer = setInterval(() => fetchRows(), REFRESH_MS);
});
onUnmounted(() => clearInterval(timer));

// Filter changes keep the open customer; defaults drop out of the URL
const setFilter = patch => {
  router.push({
    name: route.name,
    params: route.params,
    query: queryFromFilters({ ...filters.value, ...patch }),
  });
};
const clearFilters = () => {
  advanced.value = null;
  router.push({
    name: route.name,
    params: route.params,
    query: queryFromFilters({
      ...filtersFromQuery({}),
      scope: filters.value.scope,
      status: filters.value.status,
    }),
  });
};
const hasFilters = computed(() => activeFilterCount(filters.value) > 0);

// Scope tabs: Mine · Unassigned · All, then one per saved view
const scopeTabs = computed(() => [
  ...INBOX_SCOPES.map(scope => ({
    key: scope,
    label: t(`KITA_INBOX.SCOPES.${scope}`),
    active: filters.value.scope === scope && !filters.value.viewId,
    patch: { scope, viewId: null },
  })),
  ...views.value.map(view => ({
    key: `view-${view.id}`,
    label: view.name,
    active: String(filters.value.viewId) === String(view.id),
    patch: { viewId: String(view.id), scope: 'all' },
  })),
]);

// "More filters": Chatwoot's advanced filter popover, run by the Inbox API
const showAdvanced = ref(false);
const appliedFilter = ref([]);
const applyAdvanced = payload => {
  showAdvanced.value = false;
  advanced.value = filterQueryGenerator(
    useSnakeCase(JSON.parse(JSON.stringify(payload)))
  ).payload;
};
const showSaveView = ref(false);

// Stages seen on the rows feed the Stage filter
const stages = computed(() => [
  ...new Set(
    [...rows.value.map(row => row.stage), filters.value.stage].filter(Boolean)
  ),
]);
const setAdvanced = value => {
  if (value === null) advanced.value = null;
  else showAdvanced.value = true;
};

const openLastSavedView = () => {
  const last = views.value[views.value.length - 1];
  if (last) setFilter({ viewId: String(last.id), scope: 'all' });
  advanced.value = null;
};

// Sections: NEEDS REPLY, ACTIVE, UNLINKED, SNOOZED, RESOLVED
const openSections = ref([]);
const sections = computed(() =>
  sectionRows(rows.value).map(section => ({
    ...section,
    collapsible: COLLAPSED_SECTIONS.includes(section.key),
    open:
      !COLLAPSED_SECTIONS.includes(section.key) ||
      openSections.value.includes(section.key) ||
      section.rows.some(row => String(row.id) === props.customerId),
  }))
);
const toggleSection = key => {
  openSections.value = openSections.value.includes(key)
    ? openSections.value.filter(item => item !== key)
    : [...openSections.value, key];
};
const visibleRows = computed(() =>
  sections.value.flatMap(section => (section.open ? section.rows : []))
);

const openRow = row => {
  router.push(rowRoute(row, accountId.value, { query: route.query }));
};

// Multi-select for bulk actions
const selected = ref([]);
const isSelected = row => selected.value.includes(row.id);
const toggleSelected = row => {
  selected.value = isSelected(row)
    ? selected.value.filter(id => id !== row.id)
    : [...selected.value, row.id];
};
watch(rows, value => {
  const ids = value.map(row => row.id);
  selected.value = selected.value.filter(id => ids.includes(id));
});
const bulk = async (action, params) => {
  if (await act(selected.value, action, params)) selected.value = [];
};
const bulkSnooze = async value => {
  if (await snooze(selected.value, value)) selected.value = [];
};
const snoozeItems = computed(() =>
  KITA_SNOOZE_OPTIONS.map(option => ({
    label: t(`KITA_INBOX.SNOOZE.${option}`),
    value: option,
  }))
);
const assignItems = computed(() =>
  agents.value.map(agent => ({ label: agent.name, value: String(agent.id) }))
);
const labelItems = computed(() =>
  labels.value.map(item => ({ label: item.title, value: item.title }))
);

// Unlinked rows: Link to customer (admins) and Not a customer
const linkTarget = ref(null);
const linkModal = ref(null);
const startLink = async row => {
  linkTarget.value = row;
  await nextTick();
  linkModal.value?.open();
};
// The row's ⋯ menu
const onRowAction = (action, row) => {
  if (action === 'select') toggleSelected(row);
  else if (action === 'link') startLink(row);
  else act([row.id], action);
};

// Keyboard: j/k (or Alt+J/K) move, Enter opens, x selects, e resolves
const focusedIndex = ref(-1);
const listRef = ref(null);
const focusRow = index => {
  const list = visibleRows.value;
  if (!list.length) return;
  focusedIndex.value = Math.min(Math.max(index, 0), list.length - 1);
  nextTick(() =>
    listRef.value
      ?.querySelectorAll('[data-test="kita-inbox-row"]')
      [focusedIndex.value]?.scrollIntoView({ block: 'nearest' })
  );
};
const currentIndex = () => {
  if (focusedIndex.value >= 0) return focusedIndex.value;
  return visibleRows.value.findIndex(
    row => String(row.id) === props.customerId
  );
};
const focused = () => visibleRows.value[focusedIndex.value];
const moveAndOpen = step => {
  focusRow(currentIndex() + step);
  if (focused()) openRow(focused());
};
useKeyboardEvents({
  KeyJ: () => focusRow(currentIndex() + 1),
  KeyK: () => focusRow(currentIndex() - 1),
  ArrowDown: () => focusRow(currentIndex() + 1),
  ArrowUp: () => focusRow(currentIndex() - 1),
  Enter: () => focused() && openRow(focused()),
  KeyX: () => focused() && toggleSelected(focused()),
  KeyE: () => focused() && act([focused().id], 'resolve'),
  'Alt+KeyJ': { action: () => moveAndOpen(1), allowOnFocusedInput: true },
  'Alt+KeyK': { action: () => moveAndOpen(-1), allowOnFocusedInput: true },
});
watch(filters, () => {
  focusedIndex.value = -1;
});
</script>

<template>
  <section
    class="relative flex flex-col h-full min-h-0 w-[360px] min-w-[360px] ltr:border-r rtl:border-l border-n-weak bg-n-surface-1"
    data-test-id="kita-inbox-list"
  >
    <header class="px-6 pt-7 pb-4">
      <div class="flex items-baseline justify-between">
        <h1
          class="m-0 text-[1.625rem] leading-8 tracking-[-0.02em] font-bold font-interDisplay text-n-slate-12"
        >
          {{ t('KITA_INBOX.TITLE') }}
        </h1>
        <span class="text-[0.8125rem] text-n-slate-11">{{ meta.count }}</span>
      </div>
      <nav
        class="flex gap-5 mt-[1.125rem] overflow-x-auto border-b no-scrollbar border-n-weak"
      >
        <button
          v-for="tab in scopeTabs"
          :key="tab.key"
          type="button"
          data-test="kita-inbox-scope"
          class="pb-2.5 -mb-px text-[0.8125rem] leading-4 border-b-2 whitespace-nowrap"
          :class="
            tab.active
              ? 'font-semibold text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
          "
          @click="setFilter(tab.patch)"
        >
          {{ tab.label }}
        </button>
      </nav>
      <KitaInboxFilterBar
        :filters="filters"
        :stages="stages"
        @update="setFilter"
        @clear="clearFilters"
        @advanced="setAdvanced"
        @save-view="showSaveView = true"
      />
      <ConversationFilter
        v-if="showAdvanced"
        v-model="appliedFilter"
        class="absolute z-50 mt-2 ltr:left-4 rtl:right-4"
        @apply-filter="applyAdvanced"
        @close="showAdvanced = false"
      />
      <SaveCustomView
        v-if="showSaveView"
        class="absolute z-50 mt-2 ltr:left-4 rtl:right-4"
        :custom-views-query="appliedFiltersQuery"
        :open-last-saved-item="openLastSavedView"
        @close="showSaveView = false"
      />
    </header>

    <div
      v-if="selected.length"
      class="flex flex-wrap items-center gap-2 px-5 py-2 mx-3 mt-3 rounded-xl bg-woot-25 dark:bg-n-alpha-2"
      data-test-id="kita-bulk-bar"
    >
      <span class="text-xs font-medium text-n-slate-12">
        {{ t('KITA_INBOX.BULK.SELECTED', { count: selected.length }) }}
      </span>
      <Button
        :label="t('KITA_INBOX.BULK.RESOLVE')"
        size="xs"
        @click="bulk('resolve')"
      />
      <KitaFilterMenu
        :label="t('KITA_INBOX.BULK.SNOOZE')"
        :items="snoozeItems"
        @select="bulkSnooze"
      />
      <KitaFilterMenu
        :label="t('KITA_INBOX.BULK.ASSIGN')"
        :items="assignItems"
        show-search
        @select="value => bulk('assign', { assignee_id: value })"
      />
      <KitaFilterMenu
        :label="t('KITA_INBOX.BULK.LABEL')"
        :items="labelItems"
        show-search
        @select="value => bulk('label', { label: value })"
      />
      <button
        type="button"
        class="text-xs text-n-slate-11 hover:text-n-slate-12 ms-auto"
        @click="selected = []"
      >
        {{ t('KITA_INBOX.BULK.CLEAR') }}
      </button>
    </div>

    <div
      ref="listRef"
      class="flex flex-col flex-1 min-h-0 gap-0.5 px-3 pb-4 overflow-y-auto"
    >
      <p
        v-if="!isFetching && !rows.length"
        class="px-3 py-10 text-sm text-center text-n-slate-11"
        data-test-id="kita-inbox-list-empty"
      >
        {{
          filters.scope === 'mine' && !hasFilters
            ? t('KITA_INBOX.EMPTY_MINE')
            : t('KITA_INBOX.EMPTY')
        }}
      </p>
      <section
        v-for="section in sections"
        :key="section.key"
        data-test="kita-inbox-section"
      >
        <button
          type="button"
          data-test="kita-inbox-section-title"
          class="flex items-center w-full gap-1 px-3 pt-5 pb-2 m-0 text-[0.6875rem] leading-[0.875rem] font-bold tracking-[0.12em] uppercase text-n-slate-11"
          :disabled="!section.collapsible"
          @click="toggleSection(section.key)"
        >
          <span
            v-if="section.collapsible"
            class="size-3"
            :class="
              section.open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'
            "
          />
          {{ t(`KITA_INBOX.SECTIONS.${section.key}`) }}
          <span class="font-normal tracking-normal">
            {{ section.rows.length }}
          </span>
        </button>
        <template v-if="section.open">
          <KitaInboxRow
            v-for="row in section.rows"
            :key="row.id"
            :row="row"
            :active="String(row.id) === customerId"
            :focused="visibleRows[focusedIndex]?.id === row.id"
            :selected="isSelected(row)"
            :can-link="isAdmin && !!row.conversations?.length"
            :current-user-name="currentUser?.name || ''"
            @open="openRow"
            @action="onRowAction"
          />
        </template>
      </section>
      <div v-if="meta.has_more" class="flex justify-center pt-3">
        <Button
          :label="t('KITA_INBOX.LOAD_MORE')"
          size="sm"
          variant="ghost"
          color="slate"
          :is-loading="isFetching"
          @click="fetchRows(true)"
        />
      </div>
    </div>
    <KitaLinkCustomerModal
      v-if="linkTarget"
      ref="linkModal"
      :conversation-id="linkTarget.conversations[0].id"
      :label="linkTarget.name"
    />
  </section>
</template>
