import { hmacHex, safeEqual } from './crypto.ts';
import { requestJson } from './http.ts';

const MAX_SKEW_S = 300;

/**
 * Account webhooks are signed exactly like API-inbox webhooks (lib/webhooks/trigger.rb; WebhookListener
 * passes `webhook.secret` for account_type webhooks):
 *   X-Chatwoot-Signature: sha256=HEX(HMAC_SHA256(webhook secret, "<X-Chatwoot-Timestamp>.<raw body>"))
 */
export function verifyChatwootSignature(
  secret: string,
  rawBody: string,
  headers: { signature?: string; timestamp?: string },
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const { signature, timestamp } = headers;
  if (!secret || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  return safeEqual(signature, `sha256=${hmacHex(secret, `${timestamp}.${rawBody}`)}`);
}

/**
 * Chatwoot Application API, limited to the endpoints an agent bot token may call
 * (AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS): messages#create and labels#index/create.
 */
export class ChatwootApi {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private call(method: string, accountId: number, path: string, body?: unknown) {
    return requestJson(this.fetchImpl, `chatwoot ${method} ${path.replace(/\d+/g, ':id')}`, `${this.baseUrl}/api/v1/accounts/${accountId}/${path}`, {
      method,
      headers: { api_access_token: this.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Private note: agents see it, customers never do (and the bridges never forward private messages). */
  async privateNote(accountId: number, conversationId: number, content: string): Promise<number> {
    const r = await this.call('POST', accountId, `conversations/${conversationId}/messages`, { content, message_type: 'outgoing', private: true });
    return Number(r.id);
  }

  async labels(accountId: number, conversationId: number): Promise<string[]> {
    const r = await this.call('GET', accountId, `conversations/${conversationId}/labels`);
    return Array.isArray(r.payload) ? r.payload : [];
  }

  /** labels#create replaces the whole set, so read-merge-write. */
  async addLabel(accountId: number, conversationId: number, label: string): Promise<void> {
    const current = await this.labels(accountId, conversationId);
    if (current.includes(label)) return;
    await this.call('POST', accountId, `conversations/${conversationId}/labels`, { labels: [...current, label] });
  }
}
