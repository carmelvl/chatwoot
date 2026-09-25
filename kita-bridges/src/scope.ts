import { log } from './log.ts';

/**
 * Which channels the desk should show, from Grip (GET /api/v1/support/scope). Accounts that are
 * paused/closed/not on Grip's Customers page come back in `out_of_scope`; their messages are dropped
 * before any Chatwoot contact or conversation exists.
 *
 * Fails open: a failed refresh keeps the last good list, and with no list yet (or Grip not
 * configured) everything is allowed. Unknown keys (channels not linked in Grip yet) always pass.
 */
export interface ScopeCheck {
  allows(channelKey: string | undefined): boolean;
  /** Grip's row for a channel (which customer account it belongs to), when known. */
  channel?(channelKey: string | undefined): ScopeChannel | undefined;
}

/** One data.channels[] row: the channel's Grip account, DRI and (optionally) stage/health. */
export interface ScopeChannel {
  channel_key: string;
  account_id?: string;
  account_name?: string;
  in_scope?: boolean;
  dri_email?: string;
  dri_name?: string;
  sales_owner_email?: string;
  phase?: string;
  health?: string;
}

export interface ScopeOptions {
  baseUrl: string;
  apiKey: string;
  refreshMs?: number;
  fetchImpl?: typeof fetch;
  /** Called after every successful refresh (team sync runs on the same cadence). Errors are logged, never thrown. */
  onRefresh?: (inScope: string[]) => Promise<unknown> | unknown;
}

export const DEFAULT_SCOPE_REFRESH_SECONDS = 300;

export class ScopeCache implements ScopeCheck {
  private outOfScope: Set<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly enabled: boolean;
  readonly refreshMs: number;
  generatedAt: string | undefined;
  /** Channel keys Grip lists as in scope (in_scope, plus channels[] rows with in_scope: true). */
  inScope: string[] = [];
  /** channel_key -> Grip row (data.channels[]). Kept from the last good refresh. */
  channels = new Map<string, ScopeChannel>();
  private o: Partial<ScopeOptions>;

  constructor(o: Partial<ScopeOptions> = {}) {
    this.o = o;
    this.enabled = Boolean(o.baseUrl && o.apiKey);
    this.refreshMs = o.refreshMs && o.refreshMs > 0 ? o.refreshMs : DEFAULT_SCOPE_REFRESH_SECONDS * 1000;
  }

  /** True once a list has been loaded successfully at least once. */
  get loaded() {
    return this.outOfScope !== undefined;
  }

  allows(channelKey: string | undefined): boolean {
    if (!this.enabled || !this.outOfScope || !channelKey) return true;
    return !this.outOfScope.has(channelKey);
  }

  channel(channelKey: string | undefined): ScopeChannel | undefined {
    return channelKey ? this.channels.get(channelKey) : undefined;
  }

  /** Fetch the list once. Never throws: on failure the previous list stays in effect. */
  async refresh(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const url = `${this.o.baseUrl!.replace(/\/$/, '')}/api/v1/support/scope`;
      const res = await (this.o.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = await res.json();
      const body = json?.data && typeof json.data === 'object' ? json.data : json; // Grip wraps it in { success, data }
      if (!Array.isArray(body?.out_of_scope)) throw new Error('malformed scope response');
      this.outOfScope = new Set(body.out_of_scope.map(String));
      this.generatedAt = body.generated_at;
      const inScope = new Set<string>(Array.isArray(body.in_scope) ? body.in_scope.map(String) : []);
      const channels = new Map<string, ScopeChannel>();
      for (const c of Array.isArray(body.channels) ? body.channels : []) {
        if (!c?.channel_key) continue;
        const key = String(c.channel_key);
        if (c.in_scope === true) inScope.add(key);
        const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
        channels.set(key, {
          channel_key: key, account_id: str(c.account_id), account_name: str(c.account_name), in_scope: typeof c.in_scope === 'boolean' ? c.in_scope : undefined,
          dri_email: str(c.dri_email), dri_name: str(c.dri_name), sales_owner_email: str(c.sales_owner_email), phase: str(c.phase), health: str(c.health),
        });
      }
      this.channels = channels;
      for (const k of this.outOfScope) inScope.delete(k);
      this.inScope = [...inScope];
      log.info('scope_refreshed', { in_scope: Array.isArray(body.in_scope) ? body.in_scope.length : undefined, out_of_scope: this.outOfScope.size });
    } catch (e: any) {
      log.warn('scope_refresh_failed', { error: String(e?.message ?? e), keeping_last: this.loaded });
      return false;
    }
    if (this.o.onRefresh) {
      try {
        await this.o.onRefresh(this.inScope);
      } catch (e: any) {
        log.error('scope_on_refresh_failed', { error: String(e?.message ?? e) });
      }
    }
    return true;
  }

  /** Refresh now and then every refreshMs. No-op when disabled. */
  start(): Promise<boolean> {
    if (!this.enabled) {
      log.info('scope_disabled');
      return Promise.resolve(false);
    }
    this.stop();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
    return this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
