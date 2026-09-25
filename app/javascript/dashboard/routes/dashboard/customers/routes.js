import { frontendURL } from '../../../helper/URLHelper';
import store from '../../../store';
import KitaCustomersAPI from '../../../api/kitaCustomers';
import ConversationView from '../conversation/ConversationView.vue';

const meta = {
  permissions: [
    'administrator',
    'agent',
    'conversation_manage',
    'conversation_unassigned_manage',
    'conversation_participating_manage',
  ],
};

// Kita: the Customers workspace is the conversation view with the customers
// list in place of the conversation list, and one tab per platform conversation.
const customerProps = route => ({
  inboxId: 0,
  customerId: route.params.customerId ?? '',
  conversationId: route.params.conversation_id ?? 0,
});

export const routes = [
  {
    path: frontendURL('accounts/:accountId/customers'),
    name: 'kita_customers',
    component: ConversationView,
    props: customerProps,
    meta,
  },
  {
    path: frontendURL('accounts/:accountId/customers/mine'),
    name: 'kita_my_customers',
    component: ConversationView,
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
  {
    path: frontendURL('accounts/:accountId/customers/:customerId'),
    name: 'kita_customer',
    component: ConversationView,
    props: customerProps,
    meta,
  },
  {
    path: frontendURL(
      'accounts/:accountId/customers/:customerId/conversations/:conversation_id'
    ),
    name: 'kita_customer_conversation',
    component: ConversationView,
    props: customerProps,
    meta,
  },
];
