<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAlert } from 'dashboard/composables';
import KitaWhatsappGroupsAPI from 'dashboard/api/kitaWhatsappGroups';
import Button from 'dashboard/components-next/button/Button.vue';
import Input from 'dashboard/components-next/input/Input.vue';

// Kita: WhatsApp groups mirrored into the desk through a dedicated
// linked-device number (kita-wa-groups). Pair the number, add groups by
// invite link, see what is joined.
const POLL_MS = 10000;
const JOIN_ERRORS = {
  invalid_invite_link: 'KITA_WA_GROUPS.ERRORS.INVALID_LINK',
  invite_link_invalid_or_revoked: 'KITA_WA_GROUPS.ERRORS.REVOKED',
  join_rate_limited: 'KITA_WA_GROUPS.ERRORS.RATE_LIMITED',
  not_connected: 'KITA_WA_GROUPS.ERRORS.NOT_CONNECTED',
};

const { t } = useI18n();
const state = ref(null);
const unavailable = ref(false);
const inviteLink = ref('');
const isJoining = ref(false);
let timer;

const connected = computed(() => state.value?.connected === true);
const groups = computed(() => state.value?.groups ?? []);

const fetchStatus = async () => {
  try {
    const { data } = await KitaWhatsappGroupsAPI.status();
    state.value = data;
    unavailable.value = false;
  } catch {
    unavailable.value = true;
  }
};

const openPairPage = async () => {
  try {
    const { data } = await KitaWhatsappGroupsAPI.pairLink();
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch {
    useAlert(t('KITA_WA_GROUPS.ERRORS.UNAVAILABLE'));
  }
};

const join = async () => {
  if (!inviteLink.value.trim()) return;
  isJoining.value = true;
  try {
    const { data } = await KitaWhatsappGroupsAPI.join(inviteLink.value.trim());
    useAlert(
      t(
        data.already
          ? 'KITA_WA_GROUPS.ALREADY_JOINED'
          : 'KITA_WA_GROUPS.JOINED',
        { subject: data.subject }
      )
    );
    inviteLink.value = '';
    await fetchStatus();
  } catch (error) {
    const key = JOIN_ERRORS[error?.response?.data?.error];
    useAlert(t(key ?? 'KITA_WA_GROUPS.ERRORS.JOIN_FAILED'));
  } finally {
    isJoining.value = false;
  }
};

onMounted(() => {
  fetchStatus();
  timer = setInterval(fetchStatus, POLL_MS);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section
    class="flex flex-col w-full h-full min-w-0 overflow-y-auto bg-n-surface-1"
    data-test-id="kita-wa-groups-page"
  >
    <header class="px-10 pt-8 pb-4">
      <h1 class="m-0 text-3xl font-bold font-interDisplay text-n-slate-12">
        {{ t('KITA_WA_GROUPS.TITLE') }}
      </h1>
      <p class="mt-1 mb-0 text-sm text-n-slate-11">
        {{ t('KITA_WA_GROUPS.DESCRIPTION') }}
      </p>
    </header>
    <div class="flex flex-col gap-6 px-10 pb-10 max-w-3xl">
      <div
        class="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-n-alpha-2"
        data-test-id="kita-wa-groups-status"
      >
        <span class="text-sm text-n-slate-12">
          <template v-if="unavailable">
            {{ t('KITA_WA_GROUPS.ERRORS.UNAVAILABLE') }}
          </template>
          <template v-else-if="connected">
            {{ t('KITA_WA_GROUPS.CONNECTED_AS', { number: state.number }) }}
          </template>
          <template v-else-if="state">
            {{ t('KITA_WA_GROUPS.NOT_PAIRED') }}
          </template>
        </span>
        <Button
          :label="t('KITA_WA_GROUPS.PAIR')"
          size="sm"
          :variant="connected ? 'outline' : null"
          :color="connected ? 'slate' : null"
          data-test-id="kita-wa-groups-pair"
          @click="openPairPage"
        />
      </div>
      <p class="m-0 text-xs text-n-slate-11">
        {{ t('KITA_WA_GROUPS.RISK') }}
      </p>
      <form class="flex items-end gap-3" @submit.prevent="join">
        <Input
          v-model="inviteLink"
          class="flex-1"
          :label="t('KITA_WA_GROUPS.ADD_LABEL')"
          :placeholder="t('KITA_WA_GROUPS.ADD_PLACEHOLDER')"
          :disabled="!connected"
        />
        <Button
          type="submit"
          :label="t('KITA_WA_GROUPS.ADD')"
          :is-loading="isJoining"
          :disabled="!connected || !inviteLink.trim()"
          data-test-id="kita-wa-groups-add"
        />
      </form>
      <div>
        <h2 class="mt-0 mb-2 text-sm font-medium text-n-slate-12">
          {{ t('KITA_WA_GROUPS.JOINED_GROUPS', { count: groups.length }) }}
        </h2>
        <p v-if="!groups.length" class="m-0 text-sm text-n-slate-11">
          {{ t('KITA_WA_GROUPS.EMPTY') }}
        </p>
        <ul v-else class="p-0 m-0 list-none divide-y divide-n-weak">
          <li
            v-for="group in groups"
            :key="group.jid"
            class="flex items-center justify-between py-2 text-sm"
          >
            <span class="text-n-slate-12">{{ group.subject }}</span>
            <span v-if="group.participants" class="text-n-slate-11">
              {{ t('KITA_WA_GROUPS.MEMBERS', { count: group.participants }) }}
            </span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
