import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Platform } from './types.ts';

export interface ConversationRow {
  platform: Platform;
  threadKey: string;
  conversationId: number;
  /** Chatwoot contact_inbox source_id of the contact that owns the conversation. */
  sourceId: string;
  replyRef: Record<string, unknown>;
  /** Last Chatwoot status seen via conversation_status_changed ('open' until told otherwise). */
  status?: string;
}

export interface SubscriptionRow {
  id: string;
  resource: string;
  clientState: string;
  expiresAt: number;
}

/** Id mappings (platform <-> Chatwoot) and idempotency keys, in one SQLite file. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS contacts (
        platform TEXT NOT NULL, user_key TEXT NOT NULL, source_id TEXT NOT NULL,
        PRIMARY KEY (platform, user_key));
      CREATE TABLE IF NOT EXISTS conversations (
        platform TEXT NOT NULL, thread_key TEXT NOT NULL, conversation_id INTEGER NOT NULL,
        source_id TEXT NOT NULL, reply_ref TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, thread_key));
      CREATE INDEX IF NOT EXISTS conversations_by_cw ON conversations (platform, conversation_id);
      CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media (token TEXT PRIMARY KEY, source_url TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_subscriptions (
        id TEXT PRIMARY KEY, resource TEXT NOT NULL UNIQUE, client_state TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    const cols = (this.db.prepare('PRAGMA table_info(conversations)').all() as any[]).map((c) => c.name);
    if (!cols.includes('status')) this.db.exec("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  }

  getContactSourceId(platform: Platform, userKey: string): string | undefined {
    const r = this.db.prepare('SELECT source_id FROM contacts WHERE platform = ? AND user_key = ?').get(platform, userKey) as
      | { source_id: string } | undefined;
    return r?.source_id;
  }

  putContact(platform: Platform, userKey: string, sourceId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO contacts (platform, user_key, source_id) VALUES (?, ?, ?)').run(platform, userKey, sourceId);
  }

  private row(r: any): ConversationRow | undefined {
    if (!r) return undefined;
    return { platform: r.platform, threadKey: r.thread_key, conversationId: Number(r.conversation_id), sourceId: r.source_id, replyRef: JSON.parse(r.reply_ref), status: r.status };
  }

  getByThread(platform: Platform, threadKey: string): ConversationRow | undefined {
    return this.row(this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND thread_key = ?').get(platform, threadKey));
  }

  getByConversation(platform: Platform, conversationId: number): ConversationRow | undefined {
    return this.row(
      this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND conversation_id = ? ORDER BY updated_at DESC LIMIT 1').get(platform, conversationId),
    );
  }

  putConversation(r: ConversationRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO conversations (platform, thread_key, conversation_id, source_id, reply_ref, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.platform, r.threadKey, r.conversationId, r.sourceId, JSON.stringify(r.replyRef), Date.now(), r.status ?? 'open');
  }

  setConversationStatus(platform: Platform, conversationId: number, status: string): void {
    this.db.prepare('UPDATE conversations SET status = ? WHERE platform = ? AND conversation_id = ?').run(status, platform, conversationId);
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value;
  }

  putKv(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
  }

  deleteKv(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  listSubscriptions(): SubscriptionRow[] {
    return (this.db.prepare('SELECT * FROM graph_subscriptions').all() as any[]).map((r) => ({
      id: r.id, resource: r.resource, clientState: r.client_state, expiresAt: Number(r.expires_at),
    }));
  }

  getSubscription(id: string): SubscriptionRow | undefined {
    return this.listSubscriptions().find((s) => s.id === id);
  }

  putSubscription(s: SubscriptionRow): void {
    this.db.prepare('DELETE FROM graph_subscriptions WHERE resource = ? AND id != ?').run(s.resource, s.id);
    this.db.prepare('INSERT OR REPLACE INTO graph_subscriptions (id, resource, client_state, expires_at) VALUES (?, ?, ?, ?)').run(s.id, s.resource, s.clientState, s.expiresAt);
  }

  deleteSubscription(id: string): void {
    this.db.prepare('DELETE FROM graph_subscriptions WHERE id = ?').run(id);
  }

  /** Returns true the first time a key is seen (atomic), false on repeats. */
  markSeen(key: string): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO seen (key, at) VALUES (?, ?)').run(key, Date.now());
    return Number(res.changes) === 1;
  }

  isSeen(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM seen WHERE key = ?').get(key) !== undefined;
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM seen WHERE key = ?').run(key);
  }

  pruneSeen(olderThanMs = 7 * 24 * 3600 * 1000): void {
    this.db.prepare('DELETE FROM seen WHERE at < ?').run(Date.now() - olderThanMs);
  }

  putMedia(token: string, sourceUrl: string, name: string): void {
    this.db.prepare('INSERT INTO media (token, source_url, name, at) VALUES (?, ?, ?, ?)').run(token, sourceUrl, name, Date.now());
  }

  getMedia(token: string, maxAgeMs: number): { sourceUrl: string; name: string } | undefined {
    const r = this.db.prepare('SELECT source_url, name FROM media WHERE token = ? AND at >= ?').get(token, Date.now() - maxAgeMs) as any;
    return r ? { sourceUrl: r.source_url, name: r.name } : undefined;
  }

  pruneMedia(maxAgeMs: number): void {
    this.db.prepare('DELETE FROM media WHERE at < ?').run(Date.now() - maxAgeMs);
  }

  close(): void {
    this.db.close();
  }
}
