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
}

export interface ScopeOptions {
  baseUrl: string;
  apiKey: string;
  refreshMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_SCOPE_REFRESH_SECONDS = 300;

export class ScopeCache implements ScopeCheck {
  private outOfScope: Set<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly enabled: boolean;
  readonly refreshMs: number;
  generatedAt: string | undefined;
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

  /** Fetch the list once. Never throws: on failure the previous list stays in effect. */
  async refresh(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const url = `${this.o.baseUrl!.replace(/\/$/, '')}/api/v1/support/scope`;
      const res = await (this.o.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${this.o.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (!Array.isArray(body?.out_of_scope)) throw new Error('malformed scope response');
      this.outOfScope = new Set(body.out_of_scope.map(String));
      this.generatedAt = body.generated_at;
      log.info('scope_refreshed', { in_scope: Array.isArray(body.in_scope) ? body.in_scope.length : undefined, out_of_scope: this.outOfScope.size });
      return true;
    } catch (e: any) {
      log.warn('scope_refresh_failed', { error: String(e?.message ?? e), keeping_last: this.loaded });
      return false;
    }
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
