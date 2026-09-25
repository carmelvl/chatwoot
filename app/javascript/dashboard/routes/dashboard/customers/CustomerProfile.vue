<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { useAdmin } from 'dashboard/composables/useAdmin';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import KitaInboxAPI from 'dashboard/api/kitaInbox';
import { rowRoute } from 'dashboard/helper/kitaInbox';
import { dynamicTime, shortTimestamp } from 'shared/helpers/timeHelper';
import Avatar from 'dashboard/components-next/avatar/Avatar.vue';
import Button from 'dashboard/components-next/button/Button.vue';
import ChannelIcon from 'next/icon/ChannelIcon.vue';
import PlatformLogo from 'dashboard/components-next/kita/PlatformLogo.vue';
import KitaAccountTickets from 'dashboard/components-next/kita/KitaAccountTickets.vue';
import KitaLinkCustomerModal from 'dashboard/components-next/kita/KitaLinkCustomerModal.vue';
import {
  driLabel,
  gripAccountUrl,
} from 'dashboard/components-next/kita/customersHelper';

// Kita: one account's profile (Overview, Tickets, Activity). "Open in Inbox"
// is the way from here to its messages.
const props = defineProps({
  customerId: { type: String, required: true },
});

const TABS = ['overview', 'tickets', 'activity'];

const { t } = useI18n();
const store = useStore();
const router = useRouter();
const platformName = useKitaPlatformName();
const { isAdmin } = useAdmin();
const accountId = useMapGetter('getCurrentAccountId');
const inboxById = useMapGetter('inboxes/getInboxById');

const customer = computed(() =>
  store.getters['kitaCustomers/getCustomer'](props.customerId)
);
const tab = ref('overview');
const contacts = ref([]);

const load = async () => {
  try {
    await store.dispatch('kitaCustomers/show', props.customerId);
    const { data } = await KitaInboxAPI.contacts({
      customer_id: props.customerId,
    });
    contacts.value = data.payload;
  } catch {
    useAlert(t('KITA_CUSTOMERS.FETCH_ERROR'));
  }
};
watch(() => props.customerId, load, { immediate: true });

const gripUrl = computed(() => gripAccountUrl(customer.value));
const openInInbox = conversation =>
  router.push(
    rowRoute(customer.value, accountId.value, {
      tab: conversation ? conversation.platform || 'conversation' : undefined,
      conversationId: conversation?.id,
    })
  );

const channelTitle = conversation =>
  platformName(conversation.platform) ||
  inboxById.value(conversation.inbox_id)?.name ||
  '';
const time = seconds => (seconds ? shortTimestamp(dynamicTime(seconds)) : '');

const linkTarget = ref(null);
const linkModal = ref(null);
const startLink = async conversation => {
  linkTarget.value = conversation;
  await nextTick();
  linkModal.value?.open();
};
</script>

<template>
  <section
    class="flex flex-col w-full h-full min-w-0 overflow-y-auto bg-n-surface-1"
    data-test-id="kita-customer-profile"
  >
    <header class="px-10 pt-8 border-b border-n-weak">
      <RouterLink
        :to="{ name: 'kita_customers', params: { accountId } }"
        class="text-sm text-n-slate-11 hover:text-n-slate-12"
      >
        {{ t('KITA_CUSTOMERS.BACK') }}
      </RouterLink>
      <div class="flex items-start justify-between gap-4 mt-3">
        <div class="min-w-0">
          <div class="flex items-center gap-3">
            <h1
              class="m-0 text-3xl font-bold truncate font-interDisplay text-n-slate-12"
            >
              {{ customer?.name || '' }}
            </h1>
            <span
              v-if="customer?.stage"
              class="px-2 py-0.5 text-xs font-medium rounded-full bg-woot-50 text-woot-700 dark:bg-n-alpha-2 dark:text-n-slate-12"
            >
              {{ customer.stage }}
            </span>
          </div>
          <p
            v-if="customer && !customer.unlinked"
            class="mt-1 mb-0 text-sm text-n-slate-11"
          >
            {{ t('KITA_CUSTOMERS.OWNED_BY', { name: driLabel(customer) }) }}
          </p>
        </div>
        <div class="flex items-center gap-4 shrink-0">
          <a
            v-if="gripUrl"
            :href="gripUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm font-medium text-n-slate-12 hover:underline"
          >
            {{ t('KITA_CUSTOMERS.OPEN_IN_GRIP') }}
          </a>
          <Button
            v-if="customer"
            :label="t('KITA_CUSTOMERS.OPEN_IN_INBOX')"
            size="sm"
            data-test-id="kita-open-in-inbox"
            @click="openInInbox()"
          />
        </div>
      </div>
      <nav class="flex gap-7 mt-6 -mb-px">
        <button
          v-for="item in TABS"
          :key="item"
          type="button"
          class="pb-3 text-sm border-b-2"
          :class="
            tab === item
              ? 'font-medium text-n-slate-12 border-n-slate-12'
              : 'text-n-slate-11 border-transparent hover:text-n-slate-12'
          "
          @click="tab = item"
        >
          {{ t(`KITA_CUSTOMERS.PROFILE_TABS.${item}`) }}
        </button>
      </nav>
    </header>

    <div v-if="customer && tab === 'overview'" class="grid gap-10 px-10 py-8">
      <section>
        <h2
          class="m-0 mb-3 text-xs font-medium tracking-widest uppercase text-n-slate-11"
        >
          {{ t('KITA_CUSTOMERS.CHANNELS') }}
        </h2>
        <ul class="m-0 list-none">
          <li
            v-for="conversation in customer.conversations"
            :key="conversation.id"
            class="flex items-center gap-3 py-2.5 border-t border-n-weak"
          >
            <PlatformLogo
              v-if="conversation.platform"
              :platform="conversation.platform"
              class="size-5"
            />
            <ChannelIcon
              v-else-if="inboxById(conversation.inbox_id)?.id"
              :inbox="inboxById(conversation.inbox_id)"
              class="size-5 text-n-slate-11"
            />
            <span class="text-sm font-medium text-n-slate-12">
              {{ channelTitle(conversation) }}
            </span>
            <span class="text-sm truncate text-n-slate-11">
              {{ conversation.label }}
            </span>
            <span class="text-xs text-n-slate-11 ms-auto">
              {{ t(`KITA_INBOX.STATUS.${conversation.status}`) }}
            </span>
            <button
              v-if="customer.unlinked && isAdmin"
              type="button"
              class="text-xs font-medium text-n-brand hover:underline"
              @click="startLink(conversation)"
            >
              {{ t('KITA_CUSTOMERS.LINK_TO_CUSTOMER') }}
            </button>
            <button
              type="button"
              class="text-xs font-medium text-n-slate-12 hover:underline"
              @click="openInInbox(conversation)"
            >
              {{ t('KITA_CUSTOMERS.OPEN') }}
            </button>
          </li>
        </ul>
      </section>
      <section>
        <h2
          class="m-0 mb-3 text-xs font-medium tracking-widest uppercase text-n-slate-11"
        >
          {{ t('KITA_CUSTOMERS.CONTACTS') }}
        </h2>
        <p v-if="!contacts.length" class="text-sm text-n-slate-11">
          {{ t('KITA_CUSTOMERS.NO_CONTACTS') }}
        </p>
        <ul class="grid gap-2 m-0 list-none sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="contact in contacts" :key="contact.id">
            <RouterLink
              :to="{
                name: 'contacts_edit',
                params: { accountId, contactId: contact.id },
              }"
              class="flex items-center gap-3 p-3 rounded-xl hover:bg-n-alpha-1"
            >
              <Avatar
                :name="contact.name"
                :src="contact.thumbnail"
                :size="32"
                rounded-full
              />
              <span class="flex flex-col min-w-0">
                <span class="text-sm font-medium truncate text-n-slate-12">
                  {{ contact.name }}
                </span>
                <span class="text-xs truncate text-n-slate-11">
                  {{ contact.email || contact.phone_number }}
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>

    <KitaAccountTickets
      v-else-if="tab === 'tickets'"
      :customer-id="customerId"
    />

    <div v-else-if="customer && tab === 'activity'" class="px-10 py-8">
      <ul class="m-0 list-none">
        <li
          v-for="conversation in customer.conversations"
          :key="conversation.id"
          class="flex items-center gap-3 py-3 border-t cursor-pointer border-n-weak hover:bg-n-alpha-1"
          @click="openInInbox(conversation)"
        >
          <PlatformLogo
            v-if="conversation.platform"
            :platform="conversation.platform"
            class="size-4"
          />
          <span class="text-sm text-n-slate-12">
            {{ channelTitle(conversation) }} · {{ conversation.label }}
          </span>
          <span class="text-xs text-n-slate-11 ms-auto">
            {{ t(`KITA_INBOX.STATUS.${conversation.status}`) }} ·
            {{ time(conversation.last_activity_at) }}
          </span>
        </li>
      </ul>
      <p
        v-if="customer.last_message"
        class="mt-6 text-sm text-n-slate-11"
        data-test-id="kita-profile-last-message"
      >
        {{
          t('KITA_CUSTOMERS.LAST_MESSAGE', {
            time: time(customer.last_message.created_at),
            content: customer.last_message.content,
          })
        }}
      </p>
    </div>
    <KitaLinkCustomerModal
      v-if="linkTarget"
      ref="linkModal"
      :conversation-id="linkTarget.id"
      :label="customer.name"
    />
  </section>
</template>
