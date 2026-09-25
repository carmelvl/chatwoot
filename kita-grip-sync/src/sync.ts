import type { ChatwootApi, KitaDesk } from './chatwoot.ts';
import type { Classification, Classifier } from './claude.ts';
import { chatwootUrl, conversationBody, deriveChannelKey, isThreadReply, NOT_A_TICKET, OUT_OF_SCOPE_LABEL, platformOf, preview, senderName, speakerOf, threadRootId, TICKET_LABEL, toIso } from './derive.ts';
import type { GripClient, TicketStatusInput } from './grip.ts';
import { backoffMs, isRetryable } from './http.ts';
import { log } from './log.ts';
import { gripOwner, type Owners } from './owner.ts';
import type { ConversationState, GripTicketFields, Job, Priority, Store, ThreadState, TicketRow } from './store.ts';

/** Message imported from the platform's history by kita-bridges (never notified, rarely classified). */
export const isBackfill = (msg: any) => msg?.content_attributes?.kita_backfill === true || msg?.content_attributes?.kita_backfill === 'true';

export const MAX_ATTEMPTS = 10;
const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
const HANDLED = new Set(['message_created', 'conversation_created', 'conversation_status_changed', 'conversation_updated']);

export interface SyncDeps {
  store: Store;
  grip?: GripClient;
  chatwoot?: ChatwootApi;
  claude?: Classifier;
  /** Desk Kita endpoints (thread titles + ticket links). Needs BRIDGE_LINK_SECRET. */
  desk?: KitaDesk;
  /** Owner in the desk (DRI attributes + assignment). Needs a Chatwoot token. */
  owners?: Owners;
  publicUrl: string;
  debounceMs: number;
  debounceMaxMs: number;
  /**
   * SCOPE_FILTER=on: Grip's in_scope: false resolves + labels the conversation and stops classification.
   * Off (default): every conversation stays visible and is treated alike; Grip only maps accounts and owners.
   */
  scopeFilter?: boolean;
  now?: () => number;
}

/** Backfilled history (content_attributes.kita_backfill) is only classified for a thread active this recently. */
export const BACKFILL_CLASSIFY_WINDOW_MS = 7 * 24 * 3600 * 1000;

export type IngestResult = 'duplicate' | 'ignored' | 'ok';

/**
 * Two halves:
 *  - ingest(): synchronous, local-only. Folds a webhook into the SQLite conversation snapshot and
 *    enqueues durable jobs. Chatwoot account webhooks are fire-and-forget (5s timeout, no retry),
 *    so nothing slow or fallible happens before the 200.
 *  - runDue(): executes jobs (Grip upsert, classify, ticket status, notes) with exponential backoff.
 *    Jobs are keyed per conversation (or per thread) and read the latest snapshot when they run, so a
 *    burst of events costs one Grip call and a late retry can never write stale state.
 *
 * A conversation is one customer (many channels, many threads). Tickets are per thread: the thread
 * root is content_attributes.in_reply_to for replies, else the message itself, and
 * issue_key = String(root desk message id). Classification is debounced per thread
 * (`classify:<conversation>:<root>`) and also names the thread (thread_title), posted to the desk.
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
    let root = 0;
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
      root = threadRootId(p);
      store.addMessage(id, { id: msgId, role: speaker, content: String(p.content ?? '') || preview(p.content, p.attachments ?? []), createdAt: at,
        sender: senderName(p), threadReply: isThreadReply(p), rootId: root });
      if (speaker === 'customer') {
        const th = store.getThread(id, root) ?? newThread(id, root);
        store.putThread({ ...th, lastCustomerMessageId: Math.max(th.lastCustomerMessageId, msgId) });
      }
    }

    const tickets = store.tickets(id);
    // not-a-ticket stays conversation-wide: every thread's ticket is dismissed and nothing in the conversation is auto-ticketed again.
    if (s.labels.includes(NOT_A_TICKET) && !s.dismissed) {
      s.dismissed = true;
      store.cancelJobs(`classify:${id}:`);
      if (tickets.length) for (const t of tickets) store.logDismissal(id, t, t.issueKey ? store.threadMessages(id, Number(t.issueKey)) : store.thread(id));
      else store.logDismissal(id, undefined, store.thread(id));
      log.info('ticket_dismissed', { conversation: id, tickets: tickets.map((t) => t.ticketId) });
      if (tickets.some((t) => t.status !== 'dismissed')) this.enqueueStatusAll(id, 'dismissed', now);
    }
    store.putConversation(s);

    if (this.d.grip) {
      if (s.channelKey) store.enqueue(`sync:${id}`, 'sync', id, { runAt: now, mode: 'coalesce', now });
      else if (!prev) log.warn('no_channel_key', { conversation: id, channel: conv.channel ?? null });
    }

    // Resolving the conversation resolves every thread's ticket (one PATCH with all: true).
    // Reopen does NOT flip done tickets back to todo: the next classification of a thread decides
    // (see classify): issue -> that thread's ticket back to todo; else it stays done.
    if (!s.dismissed && s.status === 'resolved' && tickets.some((t) => t.status !== 'done' && t.status !== 'dismissed'))
      this.enqueueStatusAll(id, 'done', now);

    // Imported history: no classification per message. Only the most recent thread (the last backfilled
    // message's, since history arrives oldest first) is classified, and only if that message is under 7 days old.
    const backfill = isBackfill(p);
    if (fresh && backfill && this.ticketsEnabled && this.eligible(s) && now - Date.parse(toIso(p.created_at)) < BACKFILL_CLASSIFY_WINDOW_MS)
      store.enqueue(`classify_backfill:${id}`, 'classify_backfill', id, { runAt: now + this.d.debounceMs, payload: { root }, mode: 'replace', now });
    if (fresh && !backfill && speaker === 'customer' && this.ticketsEnabled && this.eligible(s))
      store.enqueue(`classify:${id}:${root}`, 'classify', id, { runAt: now + this.d.debounceMs, payload: { root }, mode: 'debounce', maxWaitMs: this.d.debounceMaxMs, now });
    return 'ok';
  }

  /** Conversation-wide status (resolve / not-a-ticket): PATCH {status, all: true}. */
  private enqueueStatusAll(id: number, status: 'done' | 'dismissed', now: number) {
    this.d.store.enqueue(`ticket_status:${id}`, 'ticket_status', id, { runAt: now, payload: { status, all: true }, mode: 'replace', now });
  }

  /** One thread's ticket: PATCH {status, issue_key}. */
  private enqueueThreadStatus(id: number, issueKey: string, status: 'todo' | 'done', now: number) {
    this.d.store.enqueue(`ticket_status:${id}:${issueKey}`, 'ticket_status', id, { runAt: now, payload: { status, issue_key: issueKey }, mode: 'replace', now });
  }

  /** Post the thread's title / ticket link to the desk (skipped when nothing changed since the last post). */
  private enqueueThreadPost(id: number, root: number, now: number) {
    if (this.d.desk) this.d.store.enqueue(`thread:${id}:${root}`, 'thread', id, { runAt: now, payload: { root }, mode: 'coalesce', now });
  }

  /** Re-post every per-thread ticket to the desk; each post is a no-op unless what the desk shows changed. */
  private repostTickets(id: number) {
    for (const t of this.d.store.tickets(id)) if (/^\d+$/.test(t.issueKey)) this.enqueueThreadPost(id, Number(t.issueKey), this.now());
  }

  private eligible(s: ConversationState) {
    return !s.dismissed && !(this.d.scopeFilter && s.outOfScope) && !s.labels.includes(NOT_A_TICKET) && s.status !== 'resolved';
  }

  /**
   * Grip's verdict on the conversation's account. Out of scope (a channel that auto-linked to a paused
   * or closed account): once per conversation, cancel classification and enqueue resolve + label.
   * Back in scope: lift the block so new customer messages classify again; the conversation is not reopened.
   */
  private applyScope(id: number, inScope: boolean) {
    const { store } = this.d;
    const s = store.getConversation(id); // re-read: ingest may have run while Grip answered
    if (!s || !!s.outOfScope === !inScope) return;
    store.putConversation({ ...s, outOfScope: !inScope });
    if (inScope) {
      store.cancelJob(`out_of_scope:${id}`);
      log.info('back_in_scope', { conversation: id, channel_key: s.channelKey });
      return;
    }
    store.cancelJobs(`classify:${id}:`);
    log.info('out_of_scope', { conversation: id, channel_key: s.channelKey });
    if (this.d.chatwoot) store.enqueue(`out_of_scope:${id}`, 'out_of_scope', id, { runAt: this.now(), mode: 'coalesce', now: this.now() });
    else log.warn('out_of_scope_not_resolved', { conversation: id, reason: 'no CHATWOOT_API_TOKEN' });
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
        log.info('conversation_synced', { conversation: id, account: r?.account_id ?? null, support_status: r?.support_status ?? null, in_scope: r?.in_scope ?? null });
        if (this.d.scopeFilter && typeof r?.in_scope === 'boolean') this.applyScope(id, r.in_scope);
        const owner = this.d.owners ? gripOwner(r) : undefined;
        if (owner) {
          const prev = store.getOwner(id);
          store.putOwner({ conversationId: id, attrs: {}, assignedAgentId: null, keptManualFor: null, ...prev, grip: owner });
          this.repostTickets(id); // the desk shows the DRI as ticket owner
          store.enqueue(`owner:${id}`, 'owner', id, { runAt: this.now(), mode: 'coalesce', now: this.now() });
        }
        return;
      }
      case 'owner': {
        const s = store.getConversation(id);
        if (s && this.d.owners) await this.d.owners.apply(id, s.accountId);
        return;
      }
      case 'ticket_status': {
        if (!this.d.grip) return;
        const p = job.payload as TicketStatusInput;
        if (p.all) {
          if (!store.tickets(id).length) return; // Grip answers 404 when nothing matches
          await this.d.grip.setTicketStatus(id, { status: p.status, all: true });
          // Dismissed stays dismissed (Grip does the same).
          for (const t of store.tickets(id))
            if (t.status !== 'dismissed') store.putTicket({ ...t, status: p.status, grip: { ...t.grip, status: DESK_STATUS[p.status] } });
        } else {
          const t = store.getTicket(id, p.issue_key ?? '');
          if (!t) return;
          const r = await this.d.grip.setTicketStatus(id, t.issueKey ? { status: p.status, issue_key: t.issueKey } : { status: p.status });
          store.putTicket({ ...t, status: p.status, grip: gripFields(r, { ...t.grip, status: DESK_STATUS[p.status] }) });
        }
        log.info('ticket_status', { conversation: id, status: p.status, all: !!p.all, issue_key: p.issue_key ?? null });
        this.repostTickets(id);
        return;
      }
      case 'out_of_scope': {
        const s = store.getConversation(id);
        if (!s?.outOfScope || !this.d.chatwoot) return; // back in scope before we got to it
        await this.d.chatwoot.resolve(s.accountId, id);
        await this.d.chatwoot.addLabel(s.accountId, id, OUT_OF_SCOPE_LABEL);
        log.info('out_of_scope_resolved', { conversation: id, channel_key: s.channelKey });
        return;
      }
      case 'classify':
      case 'classify_backfill':
        return this.classify(id, Number(job.payload.root));
      case 'announce':
        return this.announce(id, String(job.payload.issue_key ?? ''));
      case 'thread':
        return this.postThread(id, Number(job.payload.root));
      case 'note': {
        const s = store.getConversation(id);
        if (s && this.d.chatwoot) await this.d.chatwoot.privateNote(s.accountId, id, job.payload.text);
        return;
      }
      default:
        log.warn('unknown_job', { key: job.key });
    }
  }

  private async classify(id: number, root: number): Promise<void> {
    const { store, grip, claude } = this.d;
    const before = store.getConversation(id);
    const th0 = store.getThread(id, root);
    if (!before || !th0 || !grip || !claude || !this.eligible(before)) return;
    const upto = th0.lastCustomerMessageId;
    if (upto <= th0.classifiedUpto) return; // nothing new in this thread since the last classification
    const key = String(root);
    const transcript = store.threadMessages(id, root);
    const existing = store.getTicket(id, key);
    const result = await claude.classify(transcript, existing);

    // Re-read: an agent may have added not-a-ticket or resolved while the model was thinking.
    const s = store.getConversation(id)!;
    const now = this.now();
    const title = result.thread_title || null;
    const th = store.getThread(id, root)!;
    store.putThread({ ...th, title: title ?? th.title });
    if (title && title !== th.title) this.enqueueThreadPost(id, root, now);
    await this.ticketFor(s, root, result, title ?? th.title);
    // Watermark last: a failed ticket call retries the whole classification.
    const latest = store.getThread(id, root)!;
    store.putThread({ ...latest, classifiedUpto: Math.max(latest.classifiedUpto, upto) });
  }

  private async ticketFor(s: ConversationState, root: number, result: Classification, threadTitle: string | null): Promise<void> {
    const { store, grip } = this.d;
    const id = s.id;
    const key = String(root);
    const t = store.getTicket(id, key);
    const now = this.now();
    // A done ticket (conversation was resolved, then reopened) is only a template: whatever is open now is a fresh issue.
    const fresh = !t || t.status === 'done' || result.is_new_issue;
    log.info('classified', { conversation: id, thread: root, is_issue: result.is_issue, is_new_issue: result.is_new_issue, priority: result.priority, ticket: !!t });
    if (!result.is_issue || !this.eligible(s) || t?.status === 'dismissed') return;

    const url = chatwootUrl(this.d.publicUrl, s.accountId, id);
    // Same issue: never auto-downgrade. New issue: its own priority (the old issue's urgency doesn't carry over).
    const priority: Priority = !fresh && t && RANK[t.priority] > RANK[result.priority] ? t.priority : result.priority;
    const ticketTitle = result.title.trim() || t?.title || 'Support request';
    const summary = result.summary.trim() || t?.summary || '';
    const reopen = t?.status === 'done';
    if (t && !reopen && t.title === ticketTitle && t.summary === summary && t.priority === priority) return;
    const r = await grip!.upsertTicket({ chatwoot_conversation_id: id, issue_key: key, title: ticketTitle,
      body: ticketBody(summary, threadTitle, s.channelLabel, url), priority, chatwoot_url: url });
    const row: TicketRow = t
      ? { ...t, title: ticketTitle, summary, priority, ticketId: r.ticket_id ?? t.ticketId, ticketUrl: r.ticket_url ?? t.ticketUrl,
          grip: gripFields(r, t.grip) }
      : { conversationId: id, issueKey: key, ticketId: r.ticket_id, ticketUrl: r.ticket_url, title: ticketTitle, summary, priority,
          status: r.dismissed ? 'dismissed' : 'todo', notePosted: false, labelAdded: false, grip: gripFields(r) };
    store.putTicket(row);
    log.info(!t ? 'ticket_created' : fresh ? 'ticket_new_issue' : 'ticket_updated', { conversation: id, thread: root, ticket: row.ticketId, priority, reopened: reopen });
    this.enqueueThreadPost(id, root, now); // the desk shows the ticket on the thread (no-op when nothing it shows changed)
    // not-a-ticket landed while the ticket request was in flight: dismiss what we just created.
    if (store.getConversation(id)?.dismissed) {
      this.enqueueStatusAll(id, 'dismissed', now);
      return;
    }
    if (row.status === 'dismissed') return; // Grip kept an earlier dismissal: no note
    const where = threadTitle ? ` for thread "${threadTitle}"` : '';
    if (!t) store.enqueue(`announce:${id}:${key}`, 'announce', id, { runAt: now, payload: { issue_key: key }, mode: 'coalesce', now });
    else if (fresh) {
      if (reopen) this.enqueueThreadStatus(id, key, 'todo', now);
      store.enqueue(`note:${id}:${key}`, 'note', id, { runAt: now, mode: 'replace', now,
        payload: { text: `${reopen ? 'Grip ticket reopened' : 'Grip ticket now tracks a new issue'}${where} (${priority}): **${ticketTitle}** (was: ${t.title})\n${row.ticketUrl}` } });
    } else if (RANK[priority] > RANK[t.priority])
      store.enqueue(`note:${id}:${key}`, 'note', id, { runAt: now, mode: 'replace', now,
        payload: { text: `Grip ticket${where} escalated to **${priority}** (was ${t.priority}): ${row.ticketUrl}` } });
  }

  /** Posts the private note (naming the thread) + `ticket` label once per ticket; each step is flagged so retries never repeat it. */
  private async announce(id: number, key: string): Promise<void> {
    const { store, chatwoot } = this.d;
    const s = store.getConversation(id);
    let t = store.getTicket(id, key);
    if (!s || !t || !chatwoot) return;
    if (!t.notePosted) {
      const threadTitle = key ? store.getThread(id, Number(key))?.title : null;
      await chatwoot.privateNote(s.accountId, id,
        `Grip ticket created automatically${threadTitle ? ` for thread "${threadTitle}"` : ''} (${t.priority}): **${t.title}**\n${t.ticketUrl}\n\nNot a ticket? Add the label \`${NOT_A_TICKET}\` and every ticket of this conversation will be dismissed.`);
      t = { ...t, notePosted: true };
      store.putTicket(t);
    }
    if (!t.labelAdded) {
      await chatwoot.addLabel(s.accountId, id, TICKET_LABEL);
      store.putTicket({ ...t, labelAdded: true });
    }
  }

  /** POST /api/v1/kita/threads with the thread's latest title and (once it exists) its ticket. No-op when unchanged. */
  private async postThread(id: number, root: number): Promise<void> {
    const { store, desk } = this.d;
    const th = store.getThread(id, root);
    if (!th || !desk) return;
    const ticket = this.deskTicket(id, root);
    const signature = ticket ? JSON.stringify(ticket) : null;
    if (!th.title && !ticket) return;
    if (th.title === th.postedTitle && signature === th.postedTicketUrl) return;
    await desk.postThread({ conversation_id: id, root_message_id: root, ...(th.title ? { title: th.title } : {}), ...(ticket ?? {}) });
    const latest = store.getThread(id, root)!;
    store.putThread({ ...latest, postedTitle: th.title, postedTicketUrl: signature });
    log.info('thread_posted', { conversation: id, thread: root, title: th.title, ticket: ticket?.ticket_id ?? null });
    // Title or ticket changed while we were posting: post again.
    const now = this.deskTicket(id, root);
    if (latest.title !== th.title || (now ? JSON.stringify(now) : null) !== signature) this.enqueueThreadPost(id, root, this.now());
  }

  /**
   * The thread's ticket as the desk shows it. Grip's own fields win when it sent them (display id, assignee);
   * otherwise priority and status are what this service last set, and the owner is the account's DRI.
   */
  private deskTicket(id: number, root: number) {
    const t = this.d.store.getTicket(id, String(root));
    if (!t) return null;
    const g = t.grip ?? {};
    const dri = this.d.store.getOwner(id)?.grip;
    const owner = g.assignee_name || g.assignee_email || dri?.dri_name || dri?.dri_email;
    return {
      ticket_id: t.ticketId, ticket_url: t.ticketUrl, ticket_priority: g.priority || t.priority, ticket_status: g.status || DESK_STATUS[t.status] || 'open',
      // Always sent (null when unknown), so a cleared owner clears in the desk too
      ticket_owner: owner || null, ticket_display_id: g.display_id || null,
    };
  }

  /**
   * The desk resolved or reopened a thread (POST /kita/tickets/status): move that thread's Grip ticket.
   * False when the thread has no ticket here.
   */
  setThreadTicketStatus(id: number, root: number, status: 'done' | 'todo'): boolean {
    const key = String(root);
    if (!this.d.store.getTicket(id, key)) return false;
    this.enqueueThreadStatus(id, key, status, this.now());
    return true;
  }
}

/** Grip's optional ticket fields from a POST/PATCH response, over what we had. Absent fields keep their last value. */
function gripFields(r: any, prev: GripTicketFields = {}): GripTicketFields {
  const out: GripTicketFields = { ...prev };
  for (const k of ['display_id', 'priority', 'status', 'assignee_email', 'assignee_name'] as const)
    if (r && r[k] !== undefined) out[k] = r[k];
  return out;
}

/** Sync status words -> Grip's ticket words, which the desk shows. */
const DESK_STATUS: Record<string, string> = { todo: 'open', done: 'resolved', dismissed: 'dismissed' };

function newThread(conversationId: number, rootId: number): ThreadState {
  return { conversationId, rootId, lastCustomerMessageId: 0, classifiedUpto: 0, title: null, postedTitle: null, postedTicketUrl: null };
}

function ticketBody(summary: string, threadTitle: string | null, channelLabel: string | null, url: string): string {
  return `${summary}\n\n${threadTitle ? `Thread: ${threadTitle}\n` : ''}Channel: ${channelLabel ?? 'unknown'}\nConversation: ${url}\n\n(Created automatically from the support desk.)`;
}
