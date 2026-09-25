import { frontendURL } from '../../../helper/URLHelper';
import { redirectListToInbox } from '../../../helper/kitaRedirects';
import ConversationView from '../conversation/ConversationView.vue';
import CustomersPage from './CustomersPage.vue';
import CustomerProfile from './CustomerProfile.vue';
import WhatsAppGroupsPage from './WhatsAppGroupsPage.vue';

const meta = {
  permissions: [
    'administrator',
    'agent',
    'conversation_manage',
    'conversation_unassigned_manage',
    'conversation_participating_manage',
  ],
};

// The Inbox children only carry params; ConversationView renders them all
const RouteStub = { render: () => null };

// Kita: the Inbox is the one work list (a row per customer); a row opens the
// customer view on a platform tab, optionally with a thread open.
const inboxProps = route => ({
  customerId: route.params.customerId ?? '',
  tab: route.params.tab ?? '',
  threadId: Number(route.params.threadId) || 0,
});

export const routes = [
  {
    // One route record, so the list stays mounted while rows open and close
    path: frontendURL('accounts/:accountId/inbox'),
    component: ConversationView,
    props: inboxProps,
    meta,
    children: [
      { path: '', name: 'kita_inbox', component: RouteStub, meta },
      {
        path: 'customer/:customerId/:tab?',
        name: 'kita_inbox_customer',
        component: RouteStub,
        meta,
      },
      {
        path: 'customer/:customerId/:tab/thread/:threadId',
        name: 'kita_inbox_thread',
        component: RouteStub,
        meta,
      },
    ],
  },
  {
    path: frontendURL('accounts/:accountId/customers'),
    name: 'kita_customers',
    component: CustomersPage,
    meta,
  },
  {
    path: frontendURL('accounts/:accountId/customers/mine'),
    name: 'kita_my_customers',
    component: CustomersPage,
    beforeEnter: redirectListToInbox,
    meta,
  },
  {
    // Before :customerId so it is not read as a customer id
    path: frontendURL('accounts/:accountId/customers/whatsapp-groups'),
    name: 'kita_whatsapp_groups',
    component: WhatsAppGroupsPage,
    meta: { permissions: ['administrator'] },
  },
  {
    path: frontendURL('accounts/:accountId/customers/:customerId'),
    name: 'kita_customer',
    component: CustomerProfile,
    props: route => ({ customerId: route.params.customerId }),
    meta,
  },
  {
    // Earlier customer-workspace links
    path: frontendURL(
      'accounts/:accountId/customers/:customerId/conversations/:conversation_id'
    ),
    name: 'kita_customer_conversation',
    component: ConversationView,
    meta,
    beforeEnter: to => ({
      name: 'kita_inbox_customer',
      params: {
        accountId: to.params.accountId,
        customerId: to.params.customerId,
      },
      query: { c: to.params.conversation_id },
    }),
  },
];
