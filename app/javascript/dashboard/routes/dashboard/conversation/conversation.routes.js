/* eslint arrow-body-style: 0 */
import { frontendURL } from '../../../helper/URLHelper';
import ConversationView from './ConversationView.vue';
import KitaCustomersAPI from 'dashboard/api/kitaCustomers';
import {
  redirectConversationToInbox,
  redirectListToInbox,
} from 'dashboard/helper/kitaRedirects';

const CONVERSATION_PERMISSIONS = [
  'administrator',
  'agent',
  'conversation_manage',
  'conversation_unassigned_manage',
  'conversation_participating_manage',
];

// Kita: every classic conversation URL stays registered (emails, notifications
// and bookmarks keep working) and redirects into the unified Inbox.
const openInInbox = redirectConversationToInbox(async conversationId => {
  const { data } = await KitaCustomersAPI.lookup(conversationId);
  return data;
});

export default {
  routes: [
    {
      path: frontendURL('accounts/:accountId/dashboard'),
      name: 'home',
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      beforeEnter: redirectListToInbox,
      component: ConversationView,
      props: () => {
        return { inboxId: 0 };
      },
    },
    {
      path: frontendURL('accounts/:accountId/conversations/:conversation_id'),
      name: 'inbox_conversation',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => {
        return { inboxId: 0, conversationId: route.params.conversation_id };
      },
    },
    {
      path: frontendURL('accounts/:accountId/inbox/:inbox_id'),
      name: 'inbox_dashboard',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => {
        return { inboxId: route.params.inbox_id };
      },
    },
    {
      path: frontendURL(
        'accounts/:accountId/inbox/:inbox_id/conversations/:conversation_id'
      ),
      name: 'conversation_through_inbox',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => {
        return {
          conversationId: route.params.conversation_id,
          inboxId: route.params.inbox_id,
        };
      },
    },
    {
      path: frontendURL('accounts/:accountId/label/:label'),
      name: 'label_conversations',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({ label: route.params.label }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/label/:label/conversations/:conversation_id'
      ),
      name: 'conversations_through_label',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({
        conversationId: route.params.conversation_id,
        label: route.params.label,
      }),
    },
    {
      path: frontendURL('accounts/:accountId/team/:teamId'),
      name: 'team_conversations',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({ teamId: route.params.teamId }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/team/:teamId/conversations/:conversationId'
      ),
      name: 'conversations_through_team',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({
        conversationId: route.params.conversationId,
        teamId: route.params.teamId,
      }),
    },
    {
      path: frontendURL('accounts/:accountId/custom_view/:id'),
      name: 'folder_conversations',
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      beforeEnter: redirectListToInbox,
      component: ConversationView,
      props: route => ({ foldersId: route.params.id }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/custom_view/:id/conversations/:conversation_id'
      ),
      name: 'conversations_through_folders',
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      beforeEnter: openInInbox,
      props: route => ({
        conversationId: route.params.conversation_id,
        foldersId: route.params.id,
      }),
    },
    {
      path: frontendURL('accounts/:accountId/mentions/conversations'),
      name: 'conversation_mentions',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: () => ({ conversationType: 'mention' }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/mentions/conversations/:conversationId'
      ),
      name: 'conversation_through_mentions',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({
        conversationId: route.params.conversationId,
        conversationType: 'mention',
      }),
    },
    {
      path: frontendURL('accounts/:accountId/unattended/conversations'),
      name: 'conversation_unattended',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: () => ({ conversationType: 'unattended' }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/unattended/conversations/:conversationId'
      ),
      name: 'conversation_through_unattended',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({
        conversationId: route.params.conversationId,
        conversationType: 'unattended',
      }),
    },
    {
      path: frontendURL('accounts/:accountId/participating/conversations'),
      name: 'conversation_participating',
      beforeEnter: redirectListToInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: () => ({ conversationType: 'participating' }),
    },
    {
      path: frontendURL(
        'accounts/:accountId/participating/conversations/:conversationId'
      ),
      name: 'conversation_through_participating',
      beforeEnter: openInInbox,
      meta: {
        permissions: CONVERSATION_PERMISSIONS,
      },
      component: ConversationView,
      props: route => ({
        conversationId: route.params.conversationId,
        conversationType: 'participating',
      }),
    },
  ],
};
