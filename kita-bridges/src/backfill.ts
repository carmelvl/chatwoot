import { log } from './log.ts';
import type { ScopeCheck } from './scope.ts';
import type { BackfillRow, BackfillState, Store } from './store.ts';
import type { InboundMessage, Platform } from './types.ts';

/**
 * What a platform runner gets for one channel/chat. The runner fetches the whole history, sorts it
 * oldest first and hands every message to import(): the SAME inbound path as live messages.
 */
export interface BackfillContext {
  channelKey: string;
  ref: Record<string, unknown>;
  /** Platform timestamp of the last message imported by an earlier, interrupted run (resume point). */
  cursor?: string;
  /** Oldest message to import (ms since epoch), from BACKFILL_MAX_DAYS; undefined = everything. */
  since?: number;
  /**
   * Imports one message (oldest first). `position` is its platform timestamp as a sortable string
   * (Slack ts, Graph ISO time); messages before the resume cursor are skipped without any desk call.
   */
  import(msg: InboundMessage, position: string): Promise<void>;
}

export type BackfillRunner = (ctx: BackfillContext) => Promise<void>;

export interface BackfillDeps {
  store: Store;
  /** The live inbound path (Bridge.inbound). */
  deliver: (msg: InboundMessage) => Promise<unknown>;
  scope?: ScopeCheck;
  runners: Partial<Record<Platform, BackfillRunner>>;
  /** BACKFILL_MAX_DAYS; 0 / undefined = the whole history. */
  maxDays?: number;
  now?: () => number;
  /** Delays of the in-process retries after a retryable failure (default 30s, 2m, 10m). */
  retryDelaysMs?: number[];
  /** Schedules a retry (default: an unref'd setTimeout). */
  schedule?: (fn: () => void, ms: number) => void;
}

export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

/**
 * A failure worth retrying on its own: the desk or platform had a 5xx or 429 (e.g. a 502 during a desk
 * deploy), or the network dropped. 4xx answers and bugs are not retried.
 */
export const isRetryableError = (error: string) =>
  /-> (5\d\d|429)\b|\b(5\d\d|429)\b.*(bad gateway|unavailable|timeout|too many)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(
    error,
  );

export type BackfillOutcome = BackfillState | 'no_runner';

/**
 * History import when the Kita bot/user joins a channel or chat. One channel at a time (a small FIFO
 * queue, so platform rate limits are shared), resumable (state + cursor per channel in SQLite), and
 * idempotent: live messages and imported ones dedupe on the same platform message id.
 *
 * Scope: with SCOPE_FILTER=on an out-of-scope channel is recorded `skipped_out_of_scope` and imported
 * later by rerunSkipped() (after each Grip refresh) once it is in scope. With the filter off (default)
 * scope.allows() is always true and everything is imported; unlinked channels land in their own
 * "channel:" conversation (Unlinked in the desk), like live messages.
 */
export class Backfiller {
  private d: BackfillDeps;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<BackfillOutcome>>();
  /** Retries already made per channel since its last success (in-process backoff). */
  private retries = new Map<string, number>();

  constructor(d: BackfillDeps) {
    this.d = d;
  }

  /**
   * Queues a backfill of `channelKey` unless it already completed (use `force` to run it again).
   * Returns when it has run. A channel already queued shares the pending run.
   */
  request(
    platform: Platform,
    channelKey: string,
    ref: Record<string, unknown>,
    o: { force?: boolean; onlyFiles?: boolean } = {},
  ): Promise<BackfillOutcome> {
    const row = this.d.store.getBackfill(channelKey);
    if (row?.state === 'completed' && !o.force) return Promise.resolve('completed');
    const queued = this.pending.get(channelKey);
    if (queued) return queued;
    const p = this.tail.then(() => this.run(platform, channelKey, ref, o.force, o.onlyFiles)).finally(() => this.pending.delete(channelKey));
    this.pending.set(channelKey, p);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Channels skipped as out of scope, re-run once Grip puts them in scope (called after each scope refresh). */
  rerunSkipped(): Promise<BackfillOutcome[]> {
    const rows = this.d.store.listBackfills('skipped_out_of_scope').filter((b) => !this.d.scope || this.d.scope.allows(b.channelKey));
    return Promise.all(rows.map((b) => this.request(b.platform, b.channelKey, b.ref)));
  }

  /**
   * Interrupted or failed runs (bridge restarted mid-import, platform outage, a desk 5xx): resume from
   * their cursor. Called by every reconcile, so a failed backfill is never left behind.
   */
  resumeUnfinished(): Promise<BackfillOutcome[]> {
    const rows = [...this.d.store.listBackfills('running'), ...this.d.store.listBackfills('failed')];
    return Promise.all(rows.map((b) => this.request(b.platform, b.channelKey, b.ref)));
  }

  /**
   * Repair: re-reads the history of every completed channel of `platform` and imports the messages with
   * files that never reached the desk (text messages and anything already imported are skipped without a
   * desk call). For file messages an earlier bridge dropped.
   */
  rescanFiles(platform: Platform): Promise<BackfillOutcome[]> {
    const rows = this.d.store.listBackfills('completed').filter((b) => b.platform === platform);
    return Promise.all(rows.map((b) => this.request(b.platform, b.channelKey, b.ref, { force: true, onlyFiles: true })));
  }

  /** True when the channel has a backfill row in any state (reconciliation only starts unknown channels). */
  known(channelKey: string): boolean {
    return !!this.d.store.getBackfill(channelKey);
  }

  private async run(platform: Platform, channelKey: string, ref: Record<string, unknown>, force?: boolean, onlyFiles?: boolean): Promise<BackfillOutcome> {
    const { store } = this.d;
    const runner = this.d.runners[platform];
    if (!runner) return 'no_runner';
    const now = this.d.now ?? Date.now;
    const prev = store.getBackfill(channelKey);
    if (prev?.state === 'completed' && !force) return 'completed';
    const fresh = !prev || prev.state === 'completed';
    const row: BackfillRow = {
      channelKey, platform, ref: { ...prev?.ref, ...ref }, state: 'running', imported: fresh ? 0 : prev.imported,
      startedAt: fresh ? now() : (prev.startedAt ?? now()), ...(fresh || !prev.cursor ? {} : { cursor: prev.cursor }),
    };
    if (this.d.scope && !this.d.scope.allows(channelKey)) {
      store.putBackfill({ ...row, state: 'skipped_out_of_scope' });
      log.info('backfill_skipped_out_of_scope', { channel_key: channelKey });
      return 'skipped_out_of_scope';
    }
    store.putBackfill(row);
    log.info('backfill_started', { platform, channel_key: channelKey, resume: !!row.cursor });
    const resumeFrom = row.cursor;
    const ctx: BackfillContext = {
      channelKey,
      ref: row.ref,
      cursor: resumeFrom,
      since: this.d.maxDays ? now() - this.d.maxDays * 24 * 3600 * 1000 : undefined,
      import: async (msg, position) => {
        // Strictly older than the cursor was imported before; the cursor itself is re-offered and deduped.
        if (resumeFrom && position < resumeFrom) return;
        if (onlyFiles && !msg.attachments.length && !msg.pendingFileIds?.length) return;
        const result = await this.d.deliver({ ...msg, backfill: true });
        if (result === 'created' || result === 'appended' || result === 'staff_synced') row.imported++;
        row.cursor = position;
        store.putBackfill(row);
      },
    };
    try {
      await runner(ctx);
      store.putBackfill({ ...row, state: 'completed', completedAt: now(), error: undefined });
      this.retries.delete(channelKey);
      log.info('backfill_completed', { platform, channel_key: channelKey, imported: row.imported });
      return 'completed';
    } catch (e: any) {
      const error = String(e?.message ?? e);
      store.putBackfill({ ...row, state: 'failed', error });
      log.error('backfill_failed', { platform, channel_key: channelKey, imported: row.imported, error });
      this.scheduleRetry(platform, channelKey, row.ref, error);
      return 'failed';
    }
  }

  /** After a retryable failure, runs the channel again from its cursor: 30s, then 2m, then 10m. */
  private scheduleRetry(platform: Platform, channelKey: string, ref: Record<string, unknown>, error: string) {
    if (!isRetryableError(error)) return;
    const delays = this.d.retryDelaysMs ?? RETRY_DELAYS_MS;
    const attempt = this.retries.get(channelKey) ?? 0;
    if (attempt >= delays.length) {
      log.warn('backfill_retries_exhausted', { platform, channel_key: channelKey, attempts: attempt });
      return;
    }
    this.retries.set(channelKey, attempt + 1);
    const ms = delays[attempt];
    log.info('backfill_retry_scheduled', { platform, channel_key: channelKey, attempt: attempt + 1, in_ms: ms });
    const schedule = this.d.schedule ?? ((fn, wait) => setTimeout(fn, wait).unref());
    schedule(() => void this.request(platform, channelKey, ref).catch(() => undefined), ms);
  }
}

/**
 * Waits between calls to stay under a per-method rate limit, and honours Retry-After on 429s.
 * Shared by the Slack and Graph history runners.
 */
export class Throttle {
  private next = 0;
  private minIntervalMs: number;
  private sleep: (ms: number) => Promise<void>;
  constructor(minIntervalMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.minIntervalMs = minIntervalMs;
    this.sleep = sleep;
  }

  /** Before each call. */
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await this.sleep(at - now);
  }

  /** After a 429: pause everyone for `seconds`. */
  async backoff(seconds: number): Promise<void> {
    const ms = Math.max(1, seconds) * 1000;
    this.next = Math.max(this.next, Date.now() + ms);
    await this.sleep(ms);
  }
}
