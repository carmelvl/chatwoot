<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { vOnClickOutside } from '@vueuse/components';
import { useMapGetter } from 'dashboard/composables/store';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import {
  INBOX_SORTS,
  MORE_STATUSES,
  STATUS_SEGMENTS,
  TICKET_PRIORITIES,
  activeFilterChips,
} from 'dashboard/helper/kitaInbox';
import DropdownMenu from 'dashboard/components-next/dropdown-menu/DropdownMenu.vue';
import KitaFilterMenu from './KitaFilterMenu.vue';
import PlatformLogo from './PlatformLogo.vue';

// The Inbox's one compact filter row: status (Needs reply · Open · Resolved),
// a Filter button opening every other filter, a sort button, and removable
// chips only for the filters that are set.
const props = defineProps({
  filters: { type: Object, required: true },
  // Stages seen on the rows (Grip sends no list of them)
  stages: { type: Array, default: () => [] },
});

const emit = defineEmits(['update', 'clear', 'advanced', 'saveView']);

const ANY = '__any__';
const TICKET_STATUSES = ['open', 'in_progress', 'waiting_on_customer'];

const { t } = useI18n();
const platformName = useKitaPlatformName();
const labels = useMapGetter('labels/getLabels');
const teams = useMapGetter('teams/getTeams');
const agents = useMapGetter('agents/getAgents');
const inboxById = useMapGetter('inboxes/getInboxById');
const views = useMapGetter('customViews/getConversationCustomViews');

const set = (key, value) => emit('update', { [key]: value });

// Popover fields: [key, label, options {value, label, platform?}]
const fields = computed(() => [
  {
    key: 'status',
    label: t('KITA_INBOX.FILTER.STATUS'),
    options: MORE_STATUSES.map(status => ({
      value: status,
      label: t(`KITA_INBOX.STATUS.${status}`),
    })),
    value: MORE_STATUSES.includes(props.filters.status)
      ? props.filters.status
      : null,
    reset: 'open',
  },
  {
    key: 'platform',
    label: t('KITA_INBOX.CHIPS.PLATFORM'),
    options: KITA_PLATFORMS.map(platform => ({
      value: platform,
      label: platformName(platform),
      platform,
    })),
  },
  {
    key: 'dri',
    label: t('KITA_INBOX.CHIPS.DRI'),
    search: true,
    options: agents.value.map(agent => ({
      value: agent.email,
      label: agent.name,
    })),
  },
  {
    key: 'label',
    label: t('KITA_INBOX.CHIPS.LABEL'),
    search: true,
    options: labels.value.map(item => ({
      value: item.title,
      label: item.title,
    })),
  },
  {
    key: 'teamId',
    label: t('KITA_INBOX.CHIPS.TEAM'),
    options: teams.value.map(team => ({
      value: String(team.id),
      label: team.name,
    })),
  },
  {
    key: 'ticketPriority',
    label: t('KITA_INBOX.CHIPS.TICKET_PRIORITY'),
    options: TICKET_PRIORITIES.map(priority => ({
      value: priority,
      label: t(`KITA_THREADS.PRIORITY.${priority}`),
    })),
  },
  {
    key: 'ticketStatus',
    label: t('KITA_INBOX.CHIPS.TICKET_STATUS'),
    options: TICKET_STATUSES.map(status => ({
      value: status,
      label: t(`KITA_THREADS.TICKET_STATUS.${status}`),
    })),
  },
  {
    key: 'stage',
    label: t('KITA_INBOX.CHIPS.STAGE'),
    options: props.stages.map(stage => ({ value: stage, label: stage })),
  },
]);

const fieldValue = field =>
  field.key === 'status' ? field.value : props.filters[field.key];
const menuItems = field => [
  {
    label: t('KITA_INBOX.ANY'),
    value: ANY,
    isSelected: !fieldValue(field),
  },
  ...field.options.map(option => ({
    ...option,
    value: String(option.value),
    isSelected: String(option.value) === String(fieldValue(field)),
  })),
];
const fieldLabel = field => {
  const value = fieldValue(field);
  return (
    field.options.find(option => String(option.value) === String(value))
      ?.label || t('KITA_INBOX.ANY')
  );
};
const pick = (field, value) => {
  if (value === ANY) set(field.key, field.reset ?? null);
  else set(field.key, value);
};

// Chips: label of each set filter
const chipLabel = chip => {
  const field = fields.value.find(item => item.key === chip.key);
  const option = field?.options.find(item => String(item.value) === chip.value);
  if (option) return `${field.label}: ${option.label}`;
  if (chip.key === 'inboxId')
    return inboxById.value(Number(chip.value))?.name || chip.value;
  if (chip.key === 'viewId')
    return (
      views.value.find(view => String(view.id) === chip.value)?.name ||
      chip.value
    );
  if (chip.key === 'conversationType')
    return t(`KITA_INBOX.TYPES.${chip.value}`);
  if (chip.key === 'advanced')
    return t('KITA_INBOX.ADVANCED_APPLIED', { count: Number(chip.value) });
  return `${field?.label || chip.key}: ${chip.value}`;
};
const chips = computed(() =>
  activeFilterChips(props.filters).map(chip => ({
    ...chip,
    label: chipLabel(chip),
    platform: chip.key === 'platform' ? chip.value : null,
  }))
);
const removeChip = chip => {
  if (chip.key === 'advanced') emit('advanced', null);
  else set(chip.key, chip.key === 'status' ? 'open' : null);
};

const showFilters = ref(false);
const showSort = ref(false);
const sortItems = computed(() => [
  {
    label: t('KITA_INBOX.SORT.default'),
    value: ANY,
    isSelected: !props.filters.sort,
  },
  ...INBOX_SORTS.map(sort => ({
    label: t(`KITA_INBOX.SORT.${sort}`),
    value: sort,
    isSelected: sort === props.filters.sort,
  })),
]);
const pickSort = ({ value }) => {
  showSort.value = false;
  set('sort', value === ANY ? null : value);
};
</script>

<template>
  <div class="pt-3" data-test-id="kita-inbox-filter-bar">
    <div class="flex items-center gap-2">
      <div
        class="flex p-0.5 rounded-lg bg-n-alpha-1"
        data-test="kita-status-segments"
      >
        <button
          v-for="status in STATUS_SEGMENTS"
          :key="status"
          type="button"
          class="px-2.5 h-6 text-xs rounded-md"
          :class="
            filters.status === status
              ? 'bg-n-solid-1 dark:bg-n-alpha-2 font-medium text-n-slate-12 shadow-sm'
              : 'text-n-slate-11 hover:text-n-slate-12'
          "
          @click="set('status', status)"
        >
          {{ t(`KITA_INBOX.STATUS.${status}`) }}
        </button>
      </div>
      <div
        v-on-click-outside="() => (showFilters = false)"
        class="relative ms-auto"
      >
        <button
          id="toggleConversationFilterButton"
          type="button"
          class="relative grid rounded-lg size-7 place-content-center hover:bg-n-alpha-2"
          :class="
            showFilters || chips.length ? 'text-n-slate-12' : 'text-n-slate-11'
          "
          :title="t('KITA_INBOX.FILTER.TITLE')"
          :aria-label="t('KITA_INBOX.FILTER.TITLE')"
          data-test="kita-filter-button"
          @click="showFilters = !showFilters"
        >
          <span class="i-lucide-list-filter size-4" />
          <span
            v-if="chips.length"
            class="absolute top-1 end-1 size-1.5 rounded-full bg-n-brand"
          />
        </button>
        <div
          v-if="showFilters"
          class="absolute z-50 p-3 mt-1 shadow-lg w-72 top-full ltr:right-0 rtl:left-0 rounded-xl bg-n-alpha-3 backdrop-blur-[100px] outline outline-1 outline-n-container"
          data-test="kita-filter-popover"
        >
          <div
            v-for="field in fields"
            :key="field.key"
            class="flex items-center justify-between gap-3 py-1"
          >
            <span class="text-xs text-n-slate-11">{{ field.label }}</span>
            <KitaFilterMenu
              :label="fieldLabel(field)"
              :items="menuItems(field)"
              :active="!!fieldValue(field)"
              :platform="field.key === 'platform' ? filters.platform : null"
              :show-search="field.search"
              align-end
              @select="value => pick(field, value)"
            />
          </div>
          <div
            class="flex items-center justify-between pt-3 mt-2 border-t border-n-weak"
          >
            <button
              type="button"
              class="text-xs font-medium text-n-slate-12 hover:underline"
              data-test="kita-advanced-filters"
              @click="
                showFilters = false;
                emit('advanced');
              "
            >
              {{ t('KITA_INBOX.FILTER.ADVANCED') }}
            </button>
            <button
              v-if="chips.length"
              type="button"
              class="text-xs font-medium text-n-brand hover:underline"
              data-test="kita-save-view"
              @click="
                showFilters = false;
                emit('saveView');
              "
            >
              {{ t('KITA_INBOX.SAVE_VIEW') }}
            </button>
          </div>
        </div>
      </div>
      <div v-on-click-outside="() => (showSort = false)" class="relative">
        <button
          type="button"
          class="grid rounded-lg size-7 place-content-center hover:bg-n-alpha-2"
          :class="filters.sort ? 'text-n-slate-12' : 'text-n-slate-11'"
          :title="t('KITA_INBOX.SORT.TITLE')"
          :aria-label="t('KITA_INBOX.SORT.TITLE')"
          data-test="kita-sort-button"
          @click="showSort = !showSort"
        >
          <span class="i-lucide-arrow-down-wide-narrow size-4" />
        </button>
        <DropdownMenu
          v-if="showSort"
          :menu-items="sortItems"
          class="mt-1 top-full ltr:right-0 rtl:left-0 min-w-44"
          @action="pickSort"
        />
      </div>
    </div>
    <div
      v-if="chips.length"
      class="flex flex-wrap items-center gap-1 pt-2"
      data-test="kita-filter-chips"
    >
      <button
        v-for="chip in chips"
        :key="chip.key"
        type="button"
        data-test="kita-filter-chip"
        class="flex items-center gap-1 px-2 h-6 text-xs rounded-md bg-woot-25 dark:bg-n-alpha-2 text-n-slate-12 hover:bg-woot-50"
        @click="removeChip(chip)"
      >
        <PlatformLogo
          v-if="chip.platform"
          :platform="chip.platform"
          class="size-3"
        />
        {{ chip.label }}
        <span class="i-lucide-x size-3 text-n-slate-11" />
      </button>
      <button
        type="button"
        class="px-1 text-xs text-n-slate-11 hover:text-n-slate-12"
        @click="emit('clear')"
      >
        {{ t('KITA_INBOX.CLEAR_FILTERS') }}
      </button>
    </div>
  </div>
</template>
