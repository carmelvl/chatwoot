import { frontendURL } from '../../../helper/URLHelper';
import TicketsPage from './TicketsPage.vue';

export const routes = [
  {
    path: frontendURL('accounts/:accountId/tickets'),
    name: 'kita_tickets',
    component: TicketsPage,
    meta: {
      permissions: [
        'administrator',
        'agent',
        'conversation_manage',
        'conversation_unassigned_manage',
        'conversation_participating_manage',
      ],
    },
  },
];
