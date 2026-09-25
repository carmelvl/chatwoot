<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStore } from 'vuex';
import { useRouter } from 'vue-router';
import { debounce } from '@chatwoot/utils';
import { useAlert } from 'dashboard/composables';
import { useMapGetter } from 'dashboard/composables/store';
import Dialog from 'dashboard/components-next/dialog/Dialog.vue';
import Input from 'dashboard/components-next/input/Input.vue';
import KitaChannelLinksAPI from 'dashboard/api/kitaChannelLinks';

const props = defineProps({
  // Desk conversation (display id) of the unlinked channel
  conversationId: { type: Number, required: true },
  label: { type: String, required: true },
});

const { t } = useI18n();
const store = useStore();
const router = useRouter();
const accountId = useMapGetter('getCurrentAccountId');

const dialogRef = ref(null);
const search = ref('');
const accounts = ref([]);
const isSearching = ref(false);
const linkingId = ref(null);

const fetchAccounts = debounce(async () => {
  isSearching.value = true;
  try {
    const { data } = await KitaChannelLinksAPI.searchAccounts(search.value);
    accounts.value = data.payload;
  } catch {
    useAlert(t('KITA_CUSTOMERS.LINK.SEARCH_ERROR'));
  } finally {
    isSearching.value = false;
  }
}, 300);

watch(search, fetchAccounts);

const open = () => {
  search.value = '';
  accounts.value = [];
  dialogRef.value?.open();
  fetchAccounts();
};

const link = async account => {
  linkingId.value = account.id;
  try {
    await KitaChannelLinksAPI.link(props.conversationId, account.id);
    useAlert(t('KITA_CUSTOMERS.LINK.DONE', { customer: account.name }));
    dialogRef.value?.close();
    // The channel's conversation moved under the customer: show the customers list afresh
    await store.dispatch('kitaCustomers/get', { mine: true });
    await store.dispatch('kitaCustomers/get');
    router.push({
      name: 'kita_customers',
      params: { accountId: accountId.value },
    });
  } catch {
    useAlert(t('KITA_CUSTOMERS.LINK.ERROR'));
  } finally {
    linkingId.value = null;
  }
};

defineExpose({ open });
</script>

<template>
  <Dialog
    ref="dialogRef"
    :title="t('KITA_CUSTOMERS.LINK.TITLE', { channel: label })"
    :description="t('KITA_CUSTOMERS.LINK.DESCRIPTION')"
    :show-confirm-button="false"
    :cancel-button-label="t('KITA_CUSTOMERS.LINK.CANCEL')"
    width="md"
  >
    <div class="flex flex-col gap-3" data-test-id="kita-link-customer">
      <Input
        v-model="search"
        :placeholder="t('KITA_CUSTOMERS.LINK.SEARCH')"
        autofocus
      />
      <ul class="flex flex-col m-0 overflow-y-auto list-none max-h-72">
        <li
          v-if="!isSearching && !accounts.length"
          class="py-4 text-sm text-center text-n-slate-11"
        >
          {{ t('KITA_CUSTOMERS.LINK.NO_RESULTS') }}
        </li>
        <li v-for="account in accounts" :key="account.id">
          <button
            type="button"
            class="w-full px-3 py-2 text-sm rounded-lg text-start text-n-slate-12 hover:bg-n-alpha-1 disabled:opacity-50"
            :disabled="!!linkingId"
            @click="link(account)"
          >
            {{ account.name }}
          </button>
        </li>
      </ul>
    </div>
  </Dialog>
</template>
