import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Speaker = 'customer' | 'kita';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface ConversationState {
  id: number; // Chatwoot display_id (what the app API and URLs use)
  accountId: number;
  channelKey: string | null;
  platform: string | null;
  channelLabel: string | null;
  status: string;
  labels: string[];
  lastMessageAt: string | null;
  lastCustomerMessageAt: string | null;
  lastSpeaker: Speaker | null;
  preview: string | null;
  messageCount: number;
  lastCustomerMessageId: number;
  classifiedUpto: number;
  dismissed: boolean;
  /** Grip said the channel's account is out of scope: resolved + labelled once, never classified. Cleared when it comes back in scope. */
  outOfScope?: boolean;
}

export interface TicketRow {
  conversationId: number;
  ticketId: string;
  ticketUrl: string;
  title: string;
  priority: Priority;
  summary: string;
  status: string; // todo | done | dismissed (what we last told Grip)
  notePosted: boolean;
  labelAdded: boolean;
}

export interface ThreadMessage {
  id: number;
  role: Speaker;
  content: string;
  createdAt: string;
}

export interface Job {
  key: string;
  kind: string;
  conversationId: number;
  payload: any;
  attempts: number;
  version: number;
}

/** Per-conversation owner state: what Grip last said, what we last wrote to Chatwoot, and whom we assigned. */
export interface OwnerRow {
  conversationId: number;
  /** Grip's latest owner fields for the conversation's account. */
  grip: { dri_email: string | null; dri_name: string | null; sales_owner_email: string | null; account_name: string | null; in_scope: boolean | null };
  /** Custom attribute values this service last wrote (only changed values are sent again). */
  attrs: Record<string, string>;
  /** Agent id this service assigned. A different current assignee means a human reassigned: never override it. */
  assignedAgentId: number | null;
  /** DRI agent id we declined to assign because a human owns the conversation; stops re-checking every sync. */
  keptManualFor: number | null;
}

const THREAD_KEEP = 40;

/** All service state in one SQLite file: dedupe keys, conversation snapshots, tickets, a durable job queue. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, channel_key TEXT, platform TEXT, channel_label TEXT,
        status TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '[]',
        last_message_at TEXT, last_customer_message_at TEXT, last_speaker TEXT, preview TEXT,
        message_count INTEGER NOT NULL DEFAULT 0, last_customer_message_id INTEGER NOT NULL DEFAULT 0,
        classified_upto INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0, out_of_scope INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_conv ON messages (conversation_id, id);
      CREATE TABLE IF NOT EXISTS tickets (
        conversation_id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, ticket_url TEXT NOT NULL, title TEXT NOT NULL,
        priority TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        note_posted INTEGER NOT NULL DEFAULT 0, label_added INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dismissals (
        conversation_id INTEGER NOT NULL, ticket_id TEXT, title TEXT, priority TEXT, summary TEXT, thread TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, conversation_id INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        run_at INTEGER NOT NULL, first_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, dead INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      CREATE TABLE IF NOT EXISTS owners (
        conversation_id INTEGER PRIMARY KEY, grip TEXT NOT NULL DEFAULT '{}', attrs TEXT NOT NULL DEFAULT '{}',
        assigned_agent_id INTEGER, kept_manual_for INTEGER, updated_at INTEGER NOT NULL);
    `);
    // Databases created before the out-of-scope column existed.
    const cols = (this.db.prepare('PRAGMA table_info(conversations)').all() as any[]).map((c) => c.name);
    if (!cols.includes('out_of_scope')) this.db.exec('ALTER TABLE conversations ADD COLUMN out_of_scope INTEGER NOT NULL DEFAULT 0');
  }

  // ---- dedupe ----
  /** Returns true the first time a key is seen (atomic), false on repeats. */
  markSeen(key: string, now = Date.now()): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO seen (key, at) VALUES (?, ?)').run(key, now).changes) === 1;
  }
  pruneSeen(olderThanMs = 14 * 24 * 3600 * 1000, now = Date.now()): void {
    this.db.prepare('DELETE FROM seen WHERE at < ?').run(now - olderThanMs);
  }

  // ---- conversations ----
  getConversation(id: number): ConversationState | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    if (!r) return undefined;
    return {
      id: Number(r.id), accountId: Number(r.account_id), channelKey: r.channel_key, platform: r.platform, channelLabel: r.channel_label,
      status: r.status, labels: JSON.parse(r.labels), lastMessageAt: r.last_message_at, lastCustomerMessageAt: r.last_customer_message_at,
      lastSpeaker: r.last_speaker, preview: r.preview, messageCount: Number(r.message_count),
      lastCustomerMessageId: Number(r.last_customer_message_id), classifiedUpto: Number(r.classified_upto), dismissed: !!r.dismissed,
      outOfScope: !!r.out_of_scope,
    };
  }

  putConversation(c: ConversationState): void {
    this.db.prepare(`INSERT OR REPLACE INTO conversations (id, account_id, channel_key, platform, channel_label, status, labels,
        last_message_at, last_customer_message_at, last_speaker, preview, message_count, last_customer_message_id, classified_upto, dismissed, out_of_scope, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.accountId, c.channelKey, c.platform, c.channelLabel, c.status, JSON.stringify(c.labels), c.lastMessageAt,
        c.lastCustomerMessageAt, c.lastSpeaker, c.preview, c.messageCount, c.lastCustomerMessageId, c.classifiedUpto, c.dismissed ? 1 : 0, c.outOfScope ? 1 : 0, Date.now());
  }

  // ---- thread (recent public messages, for the classifier) ----
  addMessage(conversationId: number, m: ThreadMessage): void {
    this.db.prepare('INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, conversationId, m.role, m.content, m.createdAt);
    this.db.prepare(`DELETE FROM messages WHERE conversation_id = ? AND id NOT IN
        (SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ${THREAD_KEEP})`).run(conversationId, conversationId);
  }

  thread(conversationId: number, upto = Number.MAX_SAFE_INTEGER): ThreadMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id').all(conversationId, upto) as any[])
      .map((r) => ({ id: Number(r.id), role: r.role, content: r.content, createdAt: r.created_at }));
  }

  // ---- tickets ----
  getTicket(conversationId: number): TicketRow | undefined {
    const r = this.db.prepare('SELECT * FROM tickets WHERE conversation_id = ?').get(conversationId) as any;
    if (!r) return undefined;
    return {
      conversationId: Number(r.conversation_id), ticketId: r.ticket_id, ticketUrl: r.ticket_url, title: r.title, priority: r.priority,
      summary: r.summary, status: r.status, notePosted: !!r.note_posted, labelAdded: !!r.label_added,
    };
  }

  putTicket(t: TicketRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO tickets (conversation_id, ticket_id, ticket_url, title, priority, summary, status, note_posted, label_added, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.conversationId, t.ticketId, t.ticketUrl, t.title, t.priority, t.summary, t.status, t.notePosted ? 1 : 0, t.labelAdded ? 1 : 0, Date.now());
  }

  logDismissal(conversationId: number, t: TicketRow | undefined, thread: ThreadMessage[]): void {
    this.db.prepare('INSERT INTO dismissals (conversation_id, ticket_id, title, priority, summary, thread, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(conversationId, t?.ticketId ?? null, t?.title ?? null, t?.priority ?? null, t?.summary ?? null, JSON.stringify(thread), Date.now());
  }

  dismissals(): any[] {
    return this.db.prepare('SELECT * FROM dismissals ORDER BY at').all() as any[];
  }

  // ---- owners ----
  getOwner(conversationId: number): OwnerRow | undefined {
    const r = this.db.prepare('SELECT * FROM owners WHERE conversation_id = ?').get(conversationId) as any;
    if (!r) return undefined;
    return {
      conversationId: Number(r.conversation_id), grip: JSON.parse(r.grip), attrs: JSON.parse(r.attrs),
      assignedAgentId: r.assigned_agent_id === null ? null : Number(r.assigned_agent_id),
      keptManualFor: r.kept_manual_for === null ? null : Number(r.kept_manual_for),
    };
  }

  putOwner(o: OwnerRow): void {
    this.db.prepare('INSERT OR REPLACE INTO owners (conversation_id, grip, attrs, assigned_agent_id, kept_manual_for, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(o.conversationId, JSON.stringify(o.grip), JSON.stringify(o.attrs), o.assignedAgentId, o.keptManualFor, Date.now());
  }

  // ---- durable job queue ----
  /**
   * Upserts a job by key. Every upsert bumps `version`, so a run that started before the upsert can
   * tell it was superseded and must not delete the newer job.
   *  - mode 'coalesce': keep the existing schedule (and any backoff); revive dead jobs.
   *  - mode 'replace' : new payload, run at runAt, attempts reset (latest intent wins).
   *  - mode 'debounce': run_at = min(runAt, first_at + maxWaitMs) unless the job is backing off.
   */
  enqueue(key: string, kind: string, conversationId: number, opts: { runAt: number; payload?: unknown; mode: 'coalesce' | 'replace' | 'debounce'; maxWaitMs?: number; now?: number }): void {
    const now = opts.now ?? Date.now();
    const payload = JSON.stringify(opts.payload ?? {});
    const existing = this.db.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as any;
    if (!existing) {
      this.db.prepare('INSERT INTO jobs (key, kind, conversation_id, payload, run_at, first_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, kind, conversationId, payload, opts.runAt, now);
      return;
    }
    if (existing.dead || opts.mode === 'replace') {
      this.db.prepare('UPDATE jobs SET payload = ?, run_at = ?, first_at = ?, attempts = 0, dead = 0, last_error = NULL, version = version + 1 WHERE key = ?')
        .run(payload, opts.runAt, now, key);
    } else if (opts.mode === 'debounce' && Number(existing.attempts) === 0) {
      const cap = Number(existing.first_at) + (opts.maxWaitMs ?? Number.MAX_SAFE_INTEGER);
      this.db.prepare('UPDATE jobs SET payload = ?, run_at = ?, version = version + 1 WHERE key = ?').run(payload, Math.min(opts.runAt, cap), key);
    } else {
      this.db.prepare('UPDATE jobs SET payload = ?, version = version + 1 WHERE key = ?').run(payload, key);
    }
  }

  cancelJob(key: string): void {
    this.db.prepare('DELETE FROM jobs WHERE key = ?').run(key);
  }

  getJob(key: string): (Job & { runAt: number; dead: boolean; lastError: string | null }) | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE key = ?').get(key) as any;
    return r && { ...this.jobRow(r), runAt: Number(r.run_at), dead: !!r.dead, lastError: r.last_error };
  }

  private jobRow(r: any): Job {
    return { key: r.key, kind: r.kind, conversationId: Number(r.conversation_id), payload: JSON.parse(r.payload), attempts: Number(r.attempts), version: Number(r.version) };
  }

  dueJobs(now: number): Job[] {
    return (this.db.prepare('SELECT * FROM jobs WHERE dead = 0 AND run_at <= ? ORDER BY run_at, rowid').all(now) as any[]).map((r) => this.jobRow(r));
  }

  completeJob(j: Job): void {
    this.db.prepare('DELETE FROM jobs WHERE key = ? AND version = ?').run(j.key, j.version);
  }

  failJob(j: Job, error: string, next: { runAt: number } | 'dead'): void {
    if (next === 'dead') this.db.prepare('UPDATE jobs SET dead = 1, attempts = attempts + 1, last_error = ? WHERE key = ? AND version = ?').run(error, j.key, j.version);
    else this.db.prepare('UPDATE jobs SET attempts = attempts + 1, run_at = ?, last_error = ? WHERE key = ? AND version = ?').run(next.runAt, error, j.key, j.version);
  }

  close(): void {
    this.db.close();
  }
}
