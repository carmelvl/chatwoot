import { requestJson } from './http.ts';
import type { Priority } from './store.ts';

export interface TicketInput {
  chatwoot_conversation_id: number;
  title: string;
  body: string;
  priority: Priority;
  chatwoot_url: string;
  /** String(thread root desk message id): one ticket per (conversation, issue_key). Omitted for a legacy conversation-level ticket. */
  issue_key?: string;
}

export interface TicketStatusInput {
  status: 'todo' | 'done' | 'dismissed';
  /** That thread's ticket. */
  issue_key?: string;
  /** Every ticket of the conversation (resolve, not-a-ticket). */
  all?: boolean;
}

/** Grip support API (contract: docs/kita-grip-support-sync.md), authenticated with a `grip_` service key. */
export class GripClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  private call(method: string, path: string, body: unknown) {
    return requestJson(this.fetchImpl, `grip ${method} ${path.replace(/\/\d+$/, '/:id')}`, `${this.baseUrl}/api/v1/support/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r: any) => (r && typeof r.data === 'object' && r.data !== null ? r.data : r)); // Grip wraps responses as { success, data }
  }

  /** `in_scope` is false when the linked account is not on Grip's Customers page (paused, closed, no pilot). */
  upsertConversation(body: Record<string, unknown>): Promise<{ account_id: string | null; support_status: string; in_scope?: boolean }> {
    return this.call('POST', 'conversations', body);
  }

  /** Upserts by (chatwoot_conversation_id, issue_key): one Grip ticket per thread. */
  upsertTicket(body: TicketInput): Promise<{ ticket_id: string; ticket_url: string; created?: boolean; dismissed?: boolean; issue_key?: string }> {
    return this.call('POST', 'tickets', body);
  }

  setTicketStatus(conversationId: number, body: TicketStatusInput): Promise<unknown> {
    return this.call('PATCH', `tickets/${conversationId}`, body);
  }
}
