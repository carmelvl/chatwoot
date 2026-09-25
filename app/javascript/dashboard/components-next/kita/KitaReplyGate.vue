<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'dashboard/components-next/button/Button.vue';
import { openKitaConnect } from 'dashboard/helper/kitaConnect';

const props = defineProps({
  platform: { type: String, required: true },
  reason: { type: String, required: true },
  // Mirror bar: "Reply to Jun from WhatsApp Business on your phone"
  contactName: { type: String, default: '' },
  // The thread pane has no private-note composer
  showNoteAction: { type: Boolean, default: true },
});

// Private notes are never gated: the bar opens the private-note composer.
// On a mirror, "Replied from phone" clears needs-reply when the bridge missed
// the phone reply.
const emit = defineEmits(['addPrivateNote', 'repliedFromPhone']);

const { t } = useI18n();

const platformName = computed(() => {
  const names = {
    slack: t('KITA_CONNECT.PLATFORMS.SLACK'),
    teams: t('KITA_CONNECT.PLATFORMS.TEAMS'),
    whatsapp: t('KITA_CONNECT.PLATFORMS.WHATSAPP'),
    viber: t('KITA_CONNECT.PLATFORMS.VIBER'),
  };
  return names[props.platform];
});

const mirrorApp = computed(() =>
  props.platform === 'viber'
    ? t('KITA_CONNECT.REPLY_GATE.VIBER_APP')
    : t('KITA_CONNECT.REPLY_GATE.WHATSAPP_APP')
);

const title = computed(() => {
  const platform = platformName.value;
  if (props.reason === 'mirror') {
    return props.contactName
      ? t('KITA_CONNECT.REPLY_GATE.MIRROR_ON_PHONE', {
          name: props.contactName,
          app: mirrorApp.value,
        })
      : t('KITA_CONNECT.REPLY_GATE.MIRROR', { platform });
  }
  const titles = {
    unavailable: t('KITA_CONNECT.REPLY_GATE.UNAVAILABLE', { platform }),
    not_connected: t('KITA_CONNECT.REPLY_GATE.TITLE', { platform }),
  };
  return titles[props.reason];
});

const description = computed(() =>
  props.reason === 'mirror'
    ? t('KITA_CONNECT.REPLY_GATE.MIRROR_EXPLAINER')
    : t('KITA_CONNECT.REPLY_GATE.DESCRIPTION')
);
</script>

<template>
  <div
    class="flex items-center gap-4 px-[1.125rem] py-4 rounded-xl bg-n-surface-2 outline outline-1 outline-n-weak"
    data-test-id="kita-reply-gate"
  >
    <div class="flex flex-col flex-1 min-w-0 gap-[0.1875rem]">
      <span class="text-sm leading-[1.125rem] font-semibold text-n-slate-12">
        {{ title }}
      </span>
      <span class="text-[0.8125rem] leading-4 text-n-slate-11">
        {{ description }}
      </span>
    </div>
    <Button
      v-if="reason === 'not_connected'"
      :label="t('KITA_CONNECT.CONNECT')"
      size="sm"
      data-test-id="kita-connect"
      @click="openKitaConnect"
    />
    <Button
      v-if="reason === 'mirror' && showNoteAction"
      :label="t('KITA_CONNECT.REPLY_GATE.REPLIED_FROM_PHONE')"
      size="sm"
      variant="ghost"
      color="slate"
      data-test-id="kita-replied-from-phone"
      @click="emit('repliedFromPhone')"
    />
    <Button
      v-if="showNoteAction"
      :label="t('KITA_CONNECT.REPLY_GATE.ADD_PRIVATE_NOTE')"
      size="sm"
      variant="outline"
      color="slate"
      data-test-id="kita-add-private-note"
      @click="emit('addPrivateNote')"
    />
  </div>
</template>
