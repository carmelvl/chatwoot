import type { ChatwootApi } from './chatwoot.ts';
import type { ClaudeClassifier } from './claude.ts';
import { chatwootUrl, conversationBody, deriveChannelKey, NOT_A_TICKET, platformOf, preview, speakerOf, TICKET_LABEL, toIso } from './derive.ts';
import type { GripClient } from './grip.ts';
import { backoffMs, isRetryable } from './http.ts';
import { log } from './log.ts';
import type { ConversationState, Job, Priority, Store, TicketRow } from './store.ts';

export const MAX_ATTEMPTS = 10;
const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
const HANDLED = new Set(['message_created', 'conversation_created', 'conversation_status_changed', 'conversation_updated']);

export interface SyncDeps {
  store: Store;
  grip?: GripClient;
  chatwoot?: ChatwootApi;
  claude?: ClaudeClassifier;
  publicUrl: string;
  debounceMs: number;
  debounceMaxMs: number;
  now?: () => number;
}

export type IngestResult = 'duplicate' | 'ignored' | 'ok';

/**
 * Two halves:
 *  - ingest(): synchronous, local-only. Folds a webhook into the SQLite conversation snapshot and
 *    enqueues durable jobs. Chatwoot account webhooks are fire-and-forget (5s timeout, no retry),
 *    so nothing slow or fallible happens before the 200.
 *  - runDue(): executes jobs (Grip upsert, classify, ticket status, notes) with exponential backoff.
 *    Jobs are keyed per conversation and read the latest snapshot when they run, so a burst of
 *    events costs one Grip call and a late retry can never write stale state.
 */
export class Sync {
  private d: SyncDeps;
  private now: () => number;
  private running = false;

  constructor(d: SyncDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  get ticketsEnabled() {
    return !!(this.d.grip && this.d.chatwoot && this.d.claude);
  }

  ingest(p: any, deliveryId?: string): IngestResult {
    const { store } = this.d;
    const now = this.now();
    if (!HANDLED.has(p?.event)) return 'ignored';
    if (deliveryId && !store.markSeen(`delivery:${deliveryId}`, now)) return 'duplicate';
    const isMessage = p.event === 'message_created';
    const conv = isMessage ? p.conversation : p;
    const id = Number(conv?.id);
    const accountId = Number(p.account?.id ?? conv?.account?.id ?? conv?.account_id);
    if (!id || !accountId) return 'ignored';

    const prev = store.getConversation(id);
    const s: ConversationState = prev ?? {
      id, accountId, channelKey: null, platform: null, channelLabel: null, status: 'open', labels: [], lastMessageAt: null,
      lastCustomerMessageAt: null, lastSpeaker: null, preview: null, messageCount: 0, lastCustomerMessageId: 0, classifiedUpto: 0, dismissed: false,
    };
    if (typeof conv.status === 'string') s.status = conv.status;
    if (Array.isArray(conv.labels)) s.labels = conv.labels;
    s.channelKey = deriveChannelKey(conv) ?? s.channelKey;
    s.platform = platformOf(s.channelKey);
    s.channelLabel = conv.custom_attributes?.channel_label ?? conv.meta?.sender?.name ?? s.channelLabel;

    const speaker = isMessage ? speakerOf(p) : null;
    const msgId = Number(p.id);
    // Message ids dedupe too: a replayed message_created without a delivery id must not double-count.
    const fresh = !!speaker && !!msgId && store.markSeen(`msg:${msgId}`, now);
    if (fresh && speaker) {
      const at = toIso(p.created_at);
      s.messageCount += 1;
      if (!s.lastMessageAt || at >= s.lastMessageAt) {
        s.lastMessageAt = at;
        s.lastSpeaker = speaker;
        s.preview = preview(p.content, p.attachments ?? []);
      }
      if (speaker === 'customer') {
        s.lastCustomerMessageAt = !s.lastCustomerMessageAt || at > s.lastCustomerMessageAt ? at : s.lastCustomerMessageAt;
        s.lastCustomerMessageId = Math.max(s.lastCustomerMessageId, msgId);
      }
      store.addMessage(id, { id: msgId, role: speaker, content: String(p.content ?? '') || preview(p.content, p.attachments ?? []), createdAt: at });
    }

    const ticket = store.getTicket(id);
    if (s.labels.includes(NOT_A_TICKET) && !s.dismissed) {
      s.dismissed = true;
      store.cancelJob(`classify:${id}`);
      store.logDismissal(id, ticket, store.thread(id));
      log.info('ticket_dismissed', { conversation: id, ticket: ticket?.ticketId ?? null, title: ticket?.title ?? null, priority: ticket?.priority ?? null });
      if (ticket && ticket.status !== 'dismissed') this.enqueueTicketStatus(id, 'dismissed', now);
    }
    store.putConversation(s);

    if (this.d.grip) {
      if (s.channelKey) store.enqueue(`sync:${id}`, 'sync', id, { runAt: now, mode: 'coalesce', now });
      else if (!prev) log.warn('no_channel_key', { conversation: id, channel: conv.channel ?? null });
    }

    if (ticket && !s.dismissed && ticket.status !== 'dismissed') {
      const want = s.status === 'resolved' ? 'done' : s.status === 'open' || s.status === 'pending' ? 'todo' : null;
      if (want && want !== ticket.status) this.enqueueTicketStatus(id, want, now);
    }

    if (fresh && speaker === 'customer' && this.ticketsEnabled && this.eligible(s))
      store.enqueue(`classify:${id}`, 'classify', id, { runAt: now + this.d.debounceMs, mode: 'debounce', maxWaitMs: this.d.debounceMaxMs, now });
    return 'ok';
  }

  private enqueueTicketStatus(id: number, status: 'todo' | 'done' | 'dismissed', now: number) {
    this.d.store.enqueue(`ticket_status:${id}`, 'ticket_status', id, { runAt: now, payload: { status }, mode: 'replace', now });
  }

  private eligible(s: ConversationState) {
    return !s.dismissed && !s.labels.includes(NOT_A_TICKET) && s.status !== 'resolved';
  }

  /** Runs every due job once. Single-flight: overlapping ticks are no-ops. */
  async runDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (const job of this.d.store.dueJobs(this.now())) {
        n++;
        try {
          await this.run(job);
          this.d.store.completeJob(job);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          const attempt = job.attempts + 1;
          if (isRetryable(e) && attempt < MAX_ATTEMPTS) {
            this.d.store.failJob(job, msg, { runAt: this.now() + backoffMs(attempt) });
            log.warn('job_retry', { key: job.key, attempt, error: msg });
          } else {
            this.d.store.failJob(job, msg, 'dead');
            log.error('job_dead', { key: job.key, attempt, error: msg });
          }
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private async run(job: Job): Promise<void> {
    const { store } = this.d;
    const id = job.conversationId;
    switch (job.kind) {
      case 'sync': {
        const s = store.getConversation(id);
        if (!s?.channelKey || !this.d.grip) return;
        const r = await this.d.grip.upsertConversation(conversationBody(s, this.d.publicUrl));
        log.info('conversation_synced', { conversation: id, account: r?.account_id ?? null, support_status: r?.support_status ?? null });
        return;
      }
      case 'ticket_status': {
        const t = store.getTicket(id);
        if (!t || !this.d.grip) return;
        await this.d.grip.setTicketStatus(id, job.payload.status);
        store.putTicket({ ...t, status: job.payload.status });
        log.info('ticket_status', { conversation: id, status: job.payload.status });
        return;
      }
      case 'classify':
        return this.classify(id);
      case 'announce':
        return this.announce(id);
      case 'note': {
        const s = store.getConversation(id);
        if (s && this.d.chatwoot) await this.d.chatwoot.privateNote(s.accountId, id, job.payload.text);
        return;
      }
      default:
        log.warn('unknown_job', { key: job.key });
    }
  }

  private async classify(id: number): Promise<void> {
    const { store, grip, claude } = this.d;
    const before = store.getConversation(id);
    if (!before || !grip || !claude || !this.eligible(before)) return;
    const upto = before.lastCustomerMessageId;
    if (upto <= before.classifiedUpto) return; // nothing new since the last classification
    const thread = store.thread(id);
    const existing = store.getTicket(id);
    const result = await claude.classify(thread, existing);

    // Re-read: an agent may have added not-a-ticket or resolved while Claude was thinking.
    const s = store.getConversation(id)!;
    const t = store.getTicket(id);
    log.info('classified', { conversation: id, is_issue: result.is_issue, priority: result.priority, ticket: !!t });
    if (result.is_issue && this.eligible(s) && t?.status !== 'dismissed') {
      const url = chatwootUrl(this.d.publicUrl, s.accountId, id);
      const priority: Priority = t && RANK[t.priority] > RANK[result.priority] ? t.priority : result.priority; // never auto-downgrade
      const title = result.title.trim() || t?.title || 'Support request';
      const summary = result.summary.trim() || t?.summary || '';
      if (!t || t.title !== title || t.summary !== summary || t.priority !== priority) {
        const r = await grip.upsertTicket({ chatwoot_conversation_id: id, title, body: ticketBody(summary, s.channelLabel, url), priority, chatwoot_url: url });
        const row: TicketRow = t
          ? { ...t, title, summary, priority, ticketId: r.ticket_id ?? t.ticketId, ticketUrl: r.ticket_url ?? t.ticketUrl }
          : { conversationId: id, ticketId: r.ticket_id, ticketUrl: r.ticket_url, title, summary, priority, status: 'todo', notePosted: false, labelAdded: false };
        store.putTicket(row);
        log.info(t ? 'ticket_updated' : 'ticket_created', { conversation: id, ticket: row.ticketId, priority });
        const now = this.now();
        // not-a-ticket landed while the ticket request was in flight: dismiss what we just created.
        if (store.getConversation(id)?.dismissed) {
          this.enqueueTicketStatus(id, 'dismissed', now);
          return;
        }
        if (!t) store.enqueue(`announce:${id}`, 'announce', id, { runAt: now, mode: 'coalesce', now });
        else if (RANK[priority] > RANK[t.priority])
          store.enqueue(`note:${id}`, 'note', id, { runAt: now, mode: 'replace', now, payload: { text: `Grip ticket escalated to **${priority}** (was ${t.priority}): ${row.ticketUrl}` } });
      }
    }
    store.putConversation({ ...s, classifiedUpto: Math.max(s.classifiedUpto, upto) });
  }

  /** Posts the private note + `ticket` label once per ticket; each step is flagged so retries never repeat it. */
  private async announce(id: number): Promise<void> {
    const { store, chatwoot } = this.d;
    const s = store.getConversation(id);
    let t = store.getTicket(id);
    if (!s || !t || !chatwoot) return;
    if (!t.notePosted) {
      await chatwoot.privateNote(s.accountId, id,
        `Grip ticket created automatically (${t.priority}): **${t.title}**\n${t.ticketUrl}\n\nNot a ticket? Add the label \`${NOT_A_TICKET}\` and it will be dismissed.`);
      t = { ...t, notePosted: true };
      store.putTicket(t);
    }
    if (!t.labelAdded) {
      await chatwoot.addLabel(s.accountId, id, TICKET_LABEL);
      store.putTicket({ ...t, labelAdded: true });
    }
  }
}

function ticketBody(summary: string, channelLabel: string | null, url: string): string {
  return `${summary}\n\nChannel: ${channelLabel ?? 'unknown'}\nConversation: ${url}\n\n(Created automatically from the support desk.)`;
}
