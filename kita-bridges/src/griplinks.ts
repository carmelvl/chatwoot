import { log } from './log.ts';

/**
 * Linking unlinked desk channels to Grip accounts, on behalf of the desk. The desk never holds the
 * grip_ key: it calls these internal endpoints (X-Kita-Bridge-Secret) and the bridge calls Grip.
 */
export interface GripLinksOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Refresh Grip scope and merge newly linked channel conversations now (ScopeCache.refresh → linkChannels). */
  refresh: () => Promise<unknown>;
}

export interface GripAccount {
  id: string;
  name: string;
}

export class GripLinks {
  private o: GripLinksOptions;

  constructor(o: GripLinksOptions) {
    this.o = o;
  }

  get enabled() {
    return Boolean(this.o.baseUrl && this.o.apiKey);
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GripError(res.status, json?.error?.message ?? `grip ${method} ${path.split('?')[0]} -> ${res.status}`);
    return json?.data !== undefined ? json.data : json; // Grip wraps responses as { success, data }
  }

  /** Grip accounts matching `search` (company name), for the desk's "Link to customer" picker. */
  async accounts(search: string): Promise<GripAccount[]> {
    const rows: any[] = await this.call('GET', `crm/accounts?search=${encodeURIComponent(search)}&sort_by=company_name&sort_dir=asc`);
    return (Array.isArray(rows) ? rows : []).slice(0, 25).map((a) => ({ id: String(a.id), name: String(a.company_name ?? '') })).filter((a) => a.name);
  }

  /**
   * Links the channel to the account: Grip's link row id comes from its unlinked list (by channel_key),
   * then scope is refreshed so the bridge merges the channel's conversation under the customer now.
   */
  async link(channelKey: string, accountId: string): Promise<{ linked: boolean }> {
    const rows: any[] = await this.call('GET', 'support/channels?unlinked=true');
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.channel_key === channelKey);
    if (!row) throw new GripError(404, 'channel is not in Grip’s unlinked list');
    await this.call('PATCH', `support/channels/${row.id}`, { account_id: accountId });
    log.info('channel_linked', { channel_key: channelKey, account: accountId });
    await this.o.refresh();
    return { linked: true };
  }
}

export class GripError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
