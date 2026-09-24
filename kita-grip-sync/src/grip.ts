import { requestJson } from './http.ts';
import type { Priority } from './store.ts';

export interface TicketInput {
  chatwoot_conversation_id: number;
  title: string;
  body: string;
  priority: Priority;
  chatwoot_url: string;
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
    });
  }

  upsertConversation(body: Record<string, unknown>): Promise<{ account_id: string | null; support_status: string }> {
    return this.call('POST', 'conversations', body);
  }

  /** Upserts by chatwoot_conversation_id: Grip holds at most one support ticket per conversation. */
  upsertTicket(body: TicketInput): Promise<{ ticket_id: string; ticket_url: string }> {
    return this.call('POST', 'tickets', body);
  }

  setTicketStatus(conversationId: number, status: 'todo' | 'done' | 'dismissed'): Promise<unknown> {
    return this.call('PATCH', `tickets/${conversationId}`, { status });
  }
}
