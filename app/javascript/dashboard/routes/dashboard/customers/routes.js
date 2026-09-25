import { frontendURL } from '../../../helper/URLHelper';
import { redirectListToInbox } from '../../../helper/kitaRedirects';
import ConversationView from '../conversation/ConversationView.vue';
import CustomersPage from './CustomersPage.vue';
import CustomerProfile from './CustomerProfile.vue';

const meta = {
  permissions: [
    'administrator',
    'agent',
    'conversation_manage',
    'conversation_unassigned_manage',
    'conversation_participating_manage',
  ],
};

// Kita: the Inbox is the one work list (a row per customer); a row opens the
// customer view on a platform tab, optionally with a thread open.
const inboxProps = route => ({
  customerId: route.params.customerId ?? '',
  tab: route.params.tab ?? '',
  threadId: Number(route.params.threadId) || 0,
});

export const routes = [
  {
    path: frontendURL('accounts/:accountId/inbox'),
    name: 'kita_inbox',
    component: ConversationView,
    props: inboxProps,
    meta,
  },
  {
    path: frontendURL('accounts/:accountId/inbox/customer/:customerId/:tab?'),
    name: 'kita_inbox_customer',
    component: ConversationView,
    props: inboxProps,
    meta,
  },
  {
    path: frontendURL(
      'accounts/:accountId/inbox/customer/:customerId/:tab/thread/:threadId'
    ),
    name: 'kita_inbox_thread',
    component: ConversationView,
    props: inboxProps,
    meta,
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
