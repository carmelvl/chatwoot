<script setup>
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useStore } from 'vuex';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import { useAdmin } from 'dashboard/composables/useAdmin';
import { useKitaPlatformName } from 'dashboard/composables/useKitaPlatformName';
import { KITA_PLATFORMS } from 'dashboard/helper/kitaConnect';
import { rowPlatforms, shortDuration } from 'dashboard/helper/kitaInbox';
import { dynamicTime, shortTimestamp } from 'shared/helpers/timeHelper';
import Input from 'dashboard/components-next/input/Input.vue';
import PlatformLogo from 'dashboard/components-next/kita/PlatformLogo.vue';
import KitaLinkCustomerModal from 'dashboard/components-next/kita/KitaLinkCustomerModal.vue';
import {
  directorySections,
  driLabel,
} from 'dashboard/components-next/kita/customersHelper';

// Kita: the Customers directory, one row per account (by name), then the
// channels not linked to a customer yet. A row opens the account profile.
const { t } = useI18n();
const store = useStore();
const router = useRouter();
const platformName = useKitaPlatformName();
const { isAdmin } = useAdmin();
const accountId = useMapGetter('getCurrentAccountId');
const customers = computed(() =>
  store.getters['kitaCustomers/getCustomers']('all')
);
const isFetching = useMapGetter('kitaCustomers/isFetching');

const search = ref('');
const sections = computed(() => {
  const query = search.value.trim().toLowerCase();
  return directorySections(
    customers.value.filter(
      customer => !query || customer.name?.toLowerCase().includes(query)
    )
  );
});
const unlinkedCount = computed(
  () => customers.value.filter(customer => customer.unlinked).length
);

onMounted(async () => {
  try {
    await store.dispatch('kitaCustomers/get');
  } catch {
    useAlert(t('KITA_CUSTOMERS.FETCH_ERROR'));
  }
});

const openCustomer = customer =>
  router.push({
    name: 'kita_customer',
    params: { accountId: accountId.value, customerId: String(customer.id) },
  });

const lastContact = customer =>
  customer.last_activity_at
    ? shortTimestamp(dynamicTime(customer.last_activity_at))
    : '—';

const ticketPills = customer =>
  Object.entries(customer.tickets_by_priority || {})
    .filter(([, count]) => count)
    .map(([priority, count]) => ({ priority, count }));

const showUnlinked = () =>
  document
    .querySelector('[data-section="UNLINKED"]')
    ?.scrollIntoView({ behavior: 'smooth' });

const linkTarget = ref(null);
const linkModal = ref(null);
const startLink = async customer => {
  linkTarget.value = customer;
  await nextTick();
  linkModal.value?.open();
};
</script>

<template>
  <section
    class="flex flex-col w-full h-full min-w-0 overflow-y-auto bg-n-surface-1"
    data-test-id="kita-customers-page"
  >
    <header class="px-10 pt-8 pb-4">
      <div class="flex items-end justify-between gap-6">
        <div>
          <h1 class="m-0 text-3xl font-bold font-interDisplay text-n-slate-12">
            {{ t('KITA_CUSTOMERS.TITLE') }}
          </h1>
          <p class="mt-1 mb-0 text-sm text-n-slate-11">
            {{ t('KITA_CUSTOMERS.DESCRIPTION') }}
          </p>
        </div>
        <Input
          v-model="search"
          class="w-64"
          :placeholder="t('KITA_CUSTOMERS.SEARCH')"
        />
      </div>
      <div
        v-if="unlinkedCount"
        class="flex items-center justify-between gap-4 px-4 py-3 mt-6 rounded-xl bg-woot-25 dark:bg-n-alpha-2"
        data-test-id="kita-link-banner"
      >
        <span class="text-sm text-n-slate-12">
          {{
            t(
              'KITA_CUSTOMERS.LINK_BANNER',
              { count: unlinkedCount },
              unlinkedCount
            )
          }}
        </span>
        <button
          type="button"
          class="text-sm font-medium text-n-brand hover:underline"
          @click="showUnlinked"
        >
          {{
            t(
              'KITA_CUSTOMERS.LINK_CHANNELS',
              { count: unlinkedCount },
              unlinkedCount
            )
          }}
        </button>
      </div>
    </header>
    <div class="px-10 pb-10">
      <p
        v-if="!isFetching && !customers.length"
        class="py-10 text-sm text-center text-n-slate-11"
      >
        {{ t('KITA_CUSTOMERS.EMPTY') }}
      </p>
      <section
        v-for="section in sections"
        :key="section.key"
        :data-section="section.key"
        class="mt-4"
      >
        <h2
          class="m-0 mb-2 text-xs font-medium tracking-widest uppercase text-n-slate-11"
        >
          {{ t(`KITA_CUSTOMERS.SECTIONS.${section.key}`) }}
          <span class="font-normal tracking-normal">
            {{ section.customers.length }}
          </span>
        </h2>
        <table class="w-full text-sm table-fixed">
          <thead>
            <tr
              class="text-xs font-medium tracking-wide uppercase text-n-slate-11"
            >
              <th class="py-2 font-medium text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.CUSTOMER') }}
              </th>
              <th class="py-2 font-medium w-28 text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.STAGE') }}
              </th>
              <th class="py-2 font-medium w-36 text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.DRI') }}
              </th>
              <th class="w-32 py-2 font-medium text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.CHANNELS') }}
              </th>
              <th class="py-2 font-medium w-44 text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.OPEN_TICKETS') }}
              </th>
              <th class="py-2 font-medium w-28 text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.LAST_ACTIVITY') }}
              </th>
              <th class="py-2 font-medium w-28 text-start">
                {{ t('KITA_CUSTOMERS.COLUMNS.FIRST_RESPONSE') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="customer in section.customers"
              :key="customer.id"
              data-test="kita-customer-row"
              class="border-t cursor-pointer border-n-weak hover:bg-n-alpha-1"
              @click="openCustomer(customer)"
            >
              <td class="py-3 pe-4">
                <span class="flex flex-col min-w-0">
                  <span class="font-medium truncate text-n-slate-12">
                    {{ customer.name }}
                  </span>
                  <button
                    v-if="customer.unlinked && isAdmin"
                    type="button"
                    class="self-start text-xs font-medium text-n-brand hover:underline"
                    data-test="kita-link-customer"
                    @click.stop="startLink(customer)"
                  >
                    {{ t('KITA_CUSTOMERS.LINK_TO_CUSTOMER') }}
                  </button>
                </span>
              </td>
              <td class="py-3 truncate text-n-slate-11">
                {{ customer.stage || '—' }}
              </td>
              <td class="py-3 truncate text-n-slate-11">
                {{ customer.unlinked ? '—' : driLabel(customer) }}
              </td>
              <td class="py-3">
                <span class="flex items-center gap-1.5">
                  <PlatformLogo
                    v-for="platform in rowPlatforms(customer, KITA_PLATFORMS)"
                    :key="platform"
                    :platform="platform"
                    :title="platformName(platform)"
                    class="size-4"
                  />
                </span>
              </td>
              <td class="py-3">
                <span class="flex flex-wrap gap-1">
                  <span
                    v-for="pill in ticketPills(customer)"
                    :key="pill.priority"
                    class="px-1.5 py-0.5 text-xs rounded-md"
                    :class="
                      ['urgent', 'high'].includes(pill.priority)
                        ? 'bg-n-ruby-3 text-n-ruby-11'
                        : 'bg-n-alpha-2 text-n-slate-11'
                    "
                  >
                    {{ pill.count }}
                    {{ t(`KITA_THREADS.PRIORITY.${pill.priority}`) }}
                  </span>
                  <span
                    v-if="!ticketPills(customer).length"
                    class="text-n-slate-11"
                  >
                    —
                  </span>
                </span>
              </td>
              <td class="py-3 text-n-slate-11">{{ lastContact(customer) }}</td>
              <td class="py-3 text-n-slate-11">
                {{
                  customer.first_response_median == null
                    ? '—'
                    : shortDuration(customer.first_response_median)
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
    <KitaLinkCustomerModal
      v-if="linkTarget"
      ref="linkModal"
      :conversation-id="linkTarget.conversations[0].id"
      :label="linkTarget.name"
    />
  </section>
</template>
