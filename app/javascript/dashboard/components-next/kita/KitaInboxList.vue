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
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import {
  KITA_SNOOZE_OPTIONS,
  useKitaAccountActions,
} from 'dashboard/composables/useKitaAccountActions';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import filterQueryGenerator from 'dashboard/helper/filterQueryGenerator';
import {
  COLLAPSED_SECTIONS,
  INBOX_SCOPES,
  INBOX_SORTS,
  INBOX_STATUSES,
  TICKET_PRIORITIES,
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
import KitaLinkCustomerModal from './KitaLinkCustomerModal.vue';

const props = defineProps({
  // The open row ('' = none)
  customerId: { type: String, default: '' },
});

const REFRESH_MS = 30_000;
const ALL = '__all__';
const TICKET_STATUSES = ['open', 'in_progress', 'waiting_on_customer'];

const { t } = useI18n();
const store = useStore();
const route = useRoute();
const router = useRouter();
const platformName = useKitaPlatformName();
const { isAdmin } = useAdmin();
const { act, snooze } = useKitaAccountActions();

const accountId = useMapGetter('getCurrentAccountId');
const currentUser = useMapGetter('getCurrentUser');
const rows = useMapGetter('kitaInbox/getRows');
const meta = useMapGetter('kitaInbox/getMeta');
const isFetching = useMapGetter('kitaInbox/isFetching');
const labels = useMapGetter('labels/getLabels');
const teams = useMapGetter('teams/getTeams');
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

// Chip menus: value null = any
const menuItems = (options, selected, label, extra = {}) => [
  { label: t('KITA_INBOX.ANY'), value: ALL, isSelected: !selected },
  ...options.map(option => ({
    label: label(option),
    value: String(option.value ?? option),
    isSelected: String(option.value ?? option) === String(selected),
    ...(extra.platform ? { platform: option } : {}),
  })),
];
const pick = key => value => setFilter({ [key]: value === ALL ? null : value });

const chips = computed(() => {
  const f = filters.value;
  const label = (options, value) =>
    options.find(option => String(option.value) === String(value))?.label;
  const teamOptions = teams.value.map(team => ({
    value: team.id,
    label: team.name,
  }));
  const agentOptions = agents.value.map(agent => ({
    value: agent.email,
    label: agent.name,
  }));
  const stageOptions = [
    ...new Set([...rows.value.map(row => row.stage), f.stage].filter(Boolean)),
  ];
  return [
    {
      key: 'status',
      label: t(`KITA_INBOX.STATUS.${f.status}`),
      active: f.status !== 'open',
      items: INBOX_STATUSES.map(status => ({
        label: t(`KITA_INBOX.STATUS.${status}`),
        value: status,
        isSelected: status === f.status,
      })),
      select: value => setFilter({ status: value }),
    },
    {
      key: 'platform',
      label: f.platform
        ? platformName(f.platform)
        : t('KITA_INBOX.CHIPS.PLATFORM'),
      platform: f.platform,
      active: !!f.platform,
      items: menuItems(KITA_PLATFORMS, f.platform, platformName, {
        platform: true,
      }),
      select: pick('platform'),
    },
    {
      key: 'dri',
      label: label(agentOptions, f.dri) || f.dri || t('KITA_INBOX.CHIPS.DRI'),
      active: !!f.dri,
      search: true,
      items: menuItems(agentOptions, f.dri, option => option.label),
      select: pick('dri'),
    },
    {
      key: 'label',
      label: f.label || t('KITA_INBOX.CHIPS.LABEL'),
      active: !!f.label,
      search: true,
      items: menuItems(
        labels.value.map(item => item.title),
        f.label,
        title => title
      ),
      select: pick('label'),
    },
    {
      key: 'team',
      label: label(teamOptions, f.teamId) || t('KITA_INBOX.CHIPS.TEAM'),
      active: !!f.teamId,
      items: menuItems(teamOptions, f.teamId, option => option.label),
      select: pick('teamId'),
    },
    {
      key: 'ticketPriority',
      label: f.ticketPriority
        ? t(`KITA_THREADS.PRIORITY.${f.ticketPriority}`)
        : t('KITA_INBOX.CHIPS.TICKET_PRIORITY'),
      active: !!f.ticketPriority,
      items: menuItems(TICKET_PRIORITIES, f.ticketPriority, priority =>
        t(`KITA_THREADS.PRIORITY.${priority}`)
      ),
      select: pick('ticketPriority'),
    },
    {
      key: 'ticketStatus',
      label: f.ticketStatus
        ? t(`KITA_THREADS.TICKET_STATUS.${f.ticketStatus}`)
        : t('KITA_INBOX.CHIPS.TICKET_STATUS'),
      active: !!f.ticketStatus,
      items: menuItems(TICKET_STATUSES, f.ticketStatus, status =>
        t(`KITA_THREADS.TICKET_STATUS.${status}`)
      ),
      select: pick('ticketStatus'),
    },
    {
      key: 'stage',
      label: f.stage || t('KITA_INBOX.CHIPS.STAGE'),
      active: !!f.stage,
      items: menuItems(stageOptions, f.stage, stage => stage),
      select: pick('stage'),
    },
    {
      key: 'sort',
      label: t(`KITA_INBOX.SORT.${f.sort || 'default'}`),
      active: !!f.sort,
      items: [
        {
          label: t('KITA_INBOX.SORT.default'),
          value: ALL,
          isSelected: !f.sort,
        },
        ...INBOX_SORTS.map(sort => ({
          label: t(`KITA_INBOX.SORT.${sort}`),
          value: sort,
          isSelected: sort === f.sort,
        })),
      ],
      select: pick('sort'),
    },
  ];
});

// Filters from a classic URL (inbox/:id, mentions…) show as removable chips
const inboxById = useMapGetter('inboxes/getInboxById');
const contextChips = computed(() => {
  const f = filters.value;
  return [
    f.conversationType && {
      key: 'conversationType',
      label: t(`KITA_INBOX.TYPES.${f.conversationType}`),
    },
    f.inboxId && {
      key: 'inboxId',
      label: inboxById.value(Number(f.inboxId))?.name || f.inboxId,
    },
    f.advanced?.length && {
      key: 'advanced',
      label: t('KITA_INBOX.ADVANCED_APPLIED', { count: f.advanced.length }),
    },
  ].filter(Boolean);
});
const removeContextChip = key => {
  if (key === 'advanced') advanced.value = null;
  else setFilter({ [key]: null });
};

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
const bulkSnooze = async ({ value }) => {
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
const setNotCustomer = (row, notCustomer) =>
  act([row.id], notCustomer ? 'not_customer' : 'customer');

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
    <header class="px-5 pt-7">
      <div class="flex items-baseline justify-between px-1">
        <h1 class="m-0 text-2xl font-bold font-interDisplay text-n-slate-12">
          {{ t('KITA_INBOX.TITLE') }}
        </h1>
        <span class="text-sm text-n-slate-11">{{ meta.count }}</span>
      </div>
      <nav
        class="flex gap-5 px-1 mt-4 overflow-x-auto border-b no-scrollbar border-n-weak"
      >
        <button
          v-for="tab in scopeTabs"
          :key="tab.key"
          type="button"
          data-test="kita-inbox-scope"
          class="pb-2 -mb-px text-sm border-b-2 whitespace-nowrap"
          :class="
            tab.active
              ? 'font-medium text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
          "
          @click="setFilter(tab.patch)"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="flex flex-wrap items-center gap-1.5 pt-3">
        <KitaFilterMenu
          v-for="chip in chips"
          :key="chip.key"
          :label="chip.label"
          :items="chip.items"
          :active="chip.active"
          :platform="chip.platform"
          :show-search="chip.search"
          @select="chip.select"
        />
        <button
          v-for="chip in contextChips"
          :key="chip.key"
          type="button"
          class="flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded-lg bg-woot-25 dark:bg-n-alpha-2 outline outline-1 outline-woot-200 dark:outline-n-weak text-n-slate-12"
          @click="removeContextChip(chip.key)"
        >
          {{ chip.label }}
          <span class="i-lucide-x size-3" />
        </button>
        <div class="relative">
          <Button
            id="toggleConversationFilterButton"
            :label="t('KITA_INBOX.MORE_FILTERS')"
            icon="i-lucide-list-filter"
            size="xs"
            variant="ghost"
            color="slate"
            data-test-id="kita-more-filters"
            @click="showAdvanced = !showAdvanced"
          />
        </div>
        <Button
          v-if="advanced?.length"
          id="saveFilterTeleportTarget"
          :label="t('KITA_INBOX.SAVE_VIEW')"
          size="xs"
          variant="ghost"
          color="slate"
          @click="showSaveView = true"
        />
        <button
          v-if="hasFilters"
          type="button"
          class="text-xs font-medium text-n-slate-11 hover:text-n-slate-12"
          @click="clearFilters"
        >
          {{ t('KITA_INBOX.CLEAR_FILTERS') }}
        </button>
      </div>
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
        @select="value => bulkSnooze({ value })"
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

    <div ref="listRef" class="flex-1 min-h-0 px-3 pb-4 overflow-y-auto">
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
          class="flex items-center w-full gap-1 px-3 pt-6 pb-2 m-0 text-xs font-medium tracking-widest uppercase text-n-slate-11"
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
          <div v-for="row in section.rows" :key="row.id" class="relative group">
            <KitaInboxRow
              :row="row"
              :active="String(row.id) === customerId"
              :focused="visibleRows[focusedIndex]?.id === row.id"
              :selected="isSelected(row)"
              :current-user-name="currentUser?.name || ''"
              @open="openRow"
              @toggle-select="toggleSelected"
            />
            <div
              v-if="row.kind === 'unlinked'"
              class="flex gap-3 pb-2 -mt-1 ps-10"
            >
              <button
                v-if="isAdmin && row.conversations?.length"
                type="button"
                data-test="kita-link-customer"
                class="text-xs font-medium text-n-brand hover:underline"
                @click="startLink(row)"
              >
                {{ t('KITA_CUSTOMERS.LINK_TO_CUSTOMER') }}
              </button>
              <button
                type="button"
                data-test="kita-not-customer"
                class="text-xs font-medium text-n-slate-11 hover:text-n-slate-12"
                @click="setNotCustomer(row, !row.not_customer)"
              >
                {{
                  row.not_customer
                    ? t('KITA_INBOX.BACK_TO_INBOX')
                    : t('KITA_INBOX.NOT_A_CUSTOMER')
                }}
              </button>
            </div>
          </div>
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
