<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useMapGetter } from 'dashboard/composables/store.js';
import Icon from 'next/icon/Icon.vue';

const props = defineProps({
  to: { type: [Object, String], default: '' },
  label: { type: String, default: '' },
  icon: { type: [String, Object], default: '' },
  expandable: { type: Boolean, default: false },
  isExpanded: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },
  hasActiveChild: { type: Boolean, default: false },
  getterKeys: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['toggle']);

const router = useRouter();
const showBadge = useMapGetter(props.getterKeys.badge);
const dynamicCount = useMapGetter(props.getterKeys.count);
const count = computed(() =>
  dynamicCount.value > 99 ? '99+' : dynamicCount.value
);

// A real link so Cmd/Ctrl-click opens it in a new tab; a plain click keeps
// the in-app toggle instead of following the href.
const href = computed(() => (props.to ? router.resolve(props.to).href : null));

const onClick = event => {
  if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  emit('toggle');
};
</script>

<template>
  <component
    :is="to ? 'a' : 'div'"
    class="flex items-center gap-2 px-3 rounded-lg h-9 min-w-0"
    role="button"
    draggable="false"
    :href="href"
    :title="label"
    :class="{
      // Kita forest sidebar (Paper S02/S03): white at 72%, active on white/10
      'text-white bg-white/[0.12]': isActive && !hasActiveChild,
      'text-white': hasActiveChild,
      'text-white/[0.72] hover:bg-white/5 hover:text-white':
        !isActive && !hasActiveChild,
    }"
    @click.stop="onClick"
  >
    <div v-if="icon" class="relative flex items-center gap-2">
      <Icon v-if="icon" :icon="icon" class="size-[1.125rem]" />
      <span
        v-if="showBadge"
        class="size-2 -top-px ltr:-right-px rtl:-left-px bg-n-brand absolute rounded-full border border-n-solid-2"
      />
    </div>
    <div
      class="flex items-center gap-1.5 flex-grow justify-between min-w-0 flex-1"
    >
      <span class="text-sm truncate leading-[1.125rem]">
        {{ label }}
      </span>
      <span
        v-if="dynamicCount && !expandable"
        class="inline-grid h-[1.125rem] min-w-5 place-items-center rounded-full bg-white px-2 text-[0.6875rem] font-bold leading-[0.875rem] text-woot-800 flex-shrink-0"
      >
        {{ count }}
      </span>
    </div>
    <span
      v-if="expandable"
      v-show="isExpanded"
      class="i-lucide-chevron-up size-3"
      @click.stop.prevent="emit('toggle')"
    />
  </component>
</template>
