<script setup>
import { ref } from 'vue';
import { vOnClickOutside } from '@vueuse/components';
import DropdownMenu from 'dashboard/components-next/dropdown-menu/DropdownMenu.vue';
import PlatformLogo from './PlatformLogo.vue';

// A filter pill of the Inbox/Tickets bars: "Status: Needs reply ▾". Items may
// carry a platform (shown as its logo) and isSelected.
defineProps({
  label: { type: String, required: true },
  items: { type: Array, required: true },
  active: { type: Boolean, default: false },
  showSearch: { type: Boolean, default: false },
  platform: { type: String, default: null },
  // Open the menu towards the start (inside a right-aligned popover)
  alignEnd: { type: Boolean, default: false },
});

const emit = defineEmits(['select']);

const isOpen = ref(false);
const select = item => {
  isOpen.value = false;
  emit('select', item.value);
};
</script>

<template>
  <div
    v-on-click-outside="() => (isOpen = false)"
    class="relative"
    data-test="kita-filter-menu"
  >
    <button
      type="button"
      class="flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-lg outline outline-1 transition-colors"
      :class="
        active
          ? 'bg-woot-25 dark:bg-n-alpha-2 outline-woot-200 dark:outline-n-weak text-n-slate-12 font-medium'
          : 'outline-n-weak text-n-slate-11 hover:text-n-slate-12 hover:bg-n-alpha-1'
      "
      @click="isOpen = !isOpen"
    >
      <PlatformLogo v-if="platform" :platform="platform" class="size-3.5" />
      <span class="truncate max-w-32">{{ label }}</span>
      <span class="i-lucide-chevron-down size-3 shrink-0" />
    </button>
    <DropdownMenu
      v-if="isOpen"
      :menu-items="items"
      :show-search="showSearch"
      class="mt-1 top-full max-h-80 min-w-44"
      :class="alignEnd ? 'ltr:right-0 rtl:left-0' : 'ltr:left-0 rtl:right-0'"
      @action="select"
    >
      <template #thumbnail="{ item }">
        <PlatformLogo
          v-if="item.platform"
          :platform="item.platform"
          class="size-4 shrink-0"
        />
      </template>
    </DropdownMenu>
  </div>
</template>
