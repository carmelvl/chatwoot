<script setup>
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { dynamicTime } from 'shared/helpers/timeHelper';
import { conversationUrl, frontendURL } from 'dashboard/helper/URLHelper';
import KitaCustomersAPI from 'dashboard/api/kitaCustomers';
import ConversationApi from 'dashboard/api/inbox/conversation';
import {
  customerLabel,
  driLabel,
  customerConversationFilter,
} from 'dashboard/components-next/kita/customersHelper';

import Button from 'dashboard/components-next/button/Button.vue';
import PlatformLogo from 'dashboard/components-next/kita/PlatformLogo.vue';

const { t } = useI18n();
const accountId = useMapGetter('getCurrentAccountId');

const customers = ref([]);
const isLoading = ref(false);
const showMine = ref(false);
const selectedCustomer = ref(null);
const conversations = ref([]);
const isLoadingConversations = ref(false);

const fetchCustomers = async () => {
  isLoading.value = true;
  try {
    const { data } = await KitaCustomersAPI.get({ mine: showMine.value });
    customers.value = data.payload;
  } catch {
    useAlert(t('KITA_CUSTOMERS.FETCH_ERROR'));
  } finally {
    isLoading.value = false;
  }
};

const setMine = mine => {
  if (showMine.value === mine) return;
  showMine.value = mine;
  selectedCustomer.value = null;
  fetchCustomers();
};

const selectCustomer = async customer => {
  if (selectedCustomer.value?.id === customer.id) {
    selectedCustomer.value = null;
    return;
  }
  selectedCustomer.value = customer;
  conversations.value = [];
  isLoadingConversations.value = true;
  try {
    const { data } = await ConversationApi.filter({
      queryData: { payload: customerConversationFilter(customer) },
      page: 1,
    });
    conversations.value = data.payload;
  } catch {
    useAlert(t('KITA_CUSTOMERS.FETCH_ERROR'));
  } finally {
    isLoadingConversations.value = false;
  }
};

const nameFor = customer =>
  customerLabel(customer, t('KITA_CUSTOMERS.UNLINKED'));

const linkFor = conversation =>
  frontendURL(
    conversationUrl({ accountId: accountId.value, id: conversation.id })
  );

onMounted(fetchCustomers);
</script>

<template>
  <section class="flex flex-col w-full h-full overflow-auto bg-n-background">
    <header
      class="flex items-center justify-between gap-4 px-6 py-4 border-b border-n-weak"
    >
      <h1 class="text-xl font-medium text-n-slate-12">
        {{ t('KITA_CUSTOMERS.TITLE') }}
      </h1>
      <div class="flex gap-2">
        <Button
          :label="t('KITA_CUSTOMERS.FILTER.ALL')"
          size="sm"
          :variant="showMine ? 'faded' : 'solid'"
          :color="showMine ? 'slate' : 'blue'"
          @click="setMine(false)"
        />
        <Button
          :label="t('KITA_CUSTOMERS.FILTER.MINE')"
          size="sm"
          :variant="showMine ? 'solid' : 'faded'"
          :color="showMine ? 'blue' : 'slate'"
          @click="setMine(true)"
        />
      </div>
    </header>

    <p v-if="isLoading" class="px-6 py-4 text-sm text-n-slate-11">
      {{ t('KITA_CUSTOMERS.LOADING') }}
    </p>
    <p v-else-if="!customers.length" class="px-6 py-4 text-sm text-n-slate-11">
      {{ t('KITA_CUSTOMERS.EMPTY') }}
    </p>
    <table v-else class="w-full text-sm text-left">
      <thead class="text-n-slate-11">
        <tr class="border-b border-n-weak">
          <th class="px-6 py-2 font-medium">
            {{ t('KITA_CUSTOMERS.COLUMNS.CUSTOMER') }}
          </th>
          <th class="px-3 py-2 font-medium">
            {{ t('KITA_CUSTOMERS.COLUMNS.DRI') }}
          </th>
          <th class="px-3 py-2 font-medium">
            {{ t('KITA_CUSTOMERS.COLUMNS.CHANNELS') }}
          </th>
          <th class="px-3 py-2 font-medium">
            {{ t('KITA_CUSTOMERS.COLUMNS.OPEN') }}
          </th>
          <th class="px-6 py-2 font-medium">
            {{ t('KITA_CUSTOMERS.COLUMNS.LAST_ACTIVITY') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="customer in customers" :key="customer.id">
          <tr
            class="border-b cursor-pointer border-n-weak hover:bg-n-alpha-1"
            :class="{ 'bg-n-alpha-1': selectedCustomer?.id === customer.id }"
            @click="selectCustomer(customer)"
          >
            <td class="px-6 py-3 font-medium text-n-slate-12">
              <span class="flex items-center gap-2">
                {{ nameFor(customer) }}
                <span
                  v-if="customer.waiting_on_us"
                  class="px-2 py-0.5 text-xs rounded-md bg-n-amber-3 text-n-amber-11"
                >
                  {{ t('KITA_CUSTOMERS.WAITING_ON_US') }}
                </span>
              </span>
            </td>
            <td class="px-3 py-3 text-n-slate-11">
              {{ driLabel(customer) }}
            </td>
            <td class="px-3 py-3">
              <span class="flex items-center gap-1.5">
                <PlatformLogo
                  v-for="platform in customer.platforms"
                  :key="platform"
                  :platform="platform"
                  class="size-4"
                />
              </span>
            </td>
            <td class="px-3 py-3 text-n-slate-12">
              {{ customer.open_count }}
            </td>
            <td class="px-6 py-3 text-n-slate-11">
              {{
                customer.last_activity_at
                  ? dynamicTime(customer.last_activity_at)
                  : '—'
              }}
            </td>
          </tr>
          <tr v-if="selectedCustomer?.id === customer.id">
            <td colspan="5" class="px-6 py-3 border-b border-n-weak">
              <p v-if="isLoadingConversations" class="text-sm text-n-slate-11">
                {{ t('KITA_CUSTOMERS.LOADING') }}
              </p>
              <p
                v-else-if="!conversations.length"
                class="text-sm text-n-slate-11"
              >
                {{ t('KITA_CUSTOMERS.NO_CONVERSATIONS') }}
              </p>
              <ul v-else class="flex flex-col gap-1">
                <li
                  v-for="conversation in conversations"
                  :key="conversation.id"
                >
                  <router-link
                    :to="linkFor(conversation)"
                    class="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-n-alpha-2 text-n-slate-12"
                  >
                    <span class="text-n-slate-11">#{{ conversation.id }}</span>
                    <span class="truncate">
                      {{ conversation.meta?.sender?.name }}
                    </span>
                    <span class="ml-auto text-xs text-n-slate-11">
                      {{ dynamicTime(conversation.last_activity_at) }}
                    </span>
                  </router-link>
                </li>
              </ul>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
