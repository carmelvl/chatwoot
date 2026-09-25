<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { isPressingTicket } from 'dashboard/helper/kitaThreads';

const props = defineProps({
  ticket: { type: Object, required: true },
  // Inside another button (the threads list) the chip can't be a link
  asLink: { type: Boolean, default: true },
});

const { t } = useI18n();

const priority = computed(() =>
  props.ticket.priority
    ? t(`KITA_THREADS.PRIORITY.${props.ticket.priority}`)
    : null
);
</script>

<template>
  <Component
    :is="asLink ? 'a' : 'span'"
    :href="asLink ? ticket.url : undefined"
    :target="asLink ? '_blank' : undefined"
    :rel="asLink ? 'noopener noreferrer' : undefined"
    data-test="kita-ticket-chip"
    class="flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md shrink-0"
    :class="
      isPressingTicket(ticket)
        ? 'bg-n-ruby-3 text-n-ruby-11 hover:bg-n-ruby-4'
        : 'bg-n-amber-3 text-n-amber-11 hover:bg-n-amber-4'
    "
  >
    {{
      ticket.display_id
        ? t('KITA_THREADS.TICKET_WITH_ID', { id: ticket.display_id })
        : t('KITA_THREADS.TICKET')
    }}
    <template v-if="priority">
      <span class="opacity-60">/</span>
      {{ priority }}
    </template>
  </Component>
</template>
