<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { isPressingTicket } from 'dashboard/helper/kitaThreads';

// The Grip ticket on a thread root: "Urgent ticket KT-142 · AI underwriter
// stopped working". Red for urgent/high, amber otherwise.
const props = defineProps({
  ticket: { type: Object, required: true },
  // The thread's title (the ticket is named after it)
  title: { type: String, default: '' },
  // Inside another button the chip can't be a link
  asLink: { type: Boolean, default: true },
});

const { t } = useI18n();

const label = computed(() => {
  const kind = props.ticket.priority
    ? t('KITA_THREADS.PRIORITY_TICKET', {
        priority: t(`KITA_THREADS.PRIORITY.${props.ticket.priority}`),
      })
    : t('KITA_THREADS.TICKET');
  return [kind, props.ticket.display_id].filter(Boolean).join(' ');
});
</script>

<template>
  <Component
    :is="asLink && ticket.url ? 'a' : 'span'"
    :href="asLink ? ticket.url : undefined"
    :target="asLink ? '_blank' : undefined"
    :rel="asLink ? 'noopener noreferrer' : undefined"
    data-test="kita-ticket-chip"
    class="inline-flex items-center max-w-full min-w-0 gap-1.5 px-2 py-0.5 text-xs font-semibold rounded-md shrink"
    :class="
      isPressingTicket(ticket)
        ? 'bg-n-ruby-3 text-n-ruby-11 hover:bg-n-ruby-4'
        : 'bg-n-amber-3 text-n-amber-11 hover:bg-n-amber-4'
    "
  >
    <span class="i-lucide-ticket size-3.5 shrink-0" />
    <span class="shrink-0">{{ label }}</span>
    <template v-if="title">
      <span class="opacity-60 shrink-0">·</span>
      <span class="truncate">{{ title }}</span>
    </template>
  </Component>
</template>
