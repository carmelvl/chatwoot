import { frontendURL } from '../../../helper/URLHelper';
import store from '../../../store';
import KitaCustomersAPI from '../../../api/kitaCustomers';
import CustomersIndex from './pages/CustomersIndex.vue';

const meta = {
  permissions: [
    'administrator',
    'agent',
    'conversation_manage',
    'conversation_unassigned_manage',
    'conversation_participating_manage',
  ],
};

export const routes = [
  {
    path: frontendURL('accounts/:accountId/customers'),
    name: 'kita_customers',
    component: CustomersIndex,
    meta,
  },
  {
    path: frontendURL('accounts/:accountId/customers/mine'),
    name: 'kita_my_customers',
    component: CustomersIndex,
    meta,
    beforeEnter: async to => {
      const { data } = await KitaCustomersAPI.myView();
      await store.dispatch('customViews/get', 'conversation');
      return {
        name: 'folder_conversations',
        params: { accountId: to.params.accountId, id: data.id },
      };
    },
  },
];
