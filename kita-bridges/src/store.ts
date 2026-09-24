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
    `);
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
    return { platform: r.platform, threadKey: r.thread_key, conversationId: Number(r.conversation_id), sourceId: r.source_id, replyRef: JSON.parse(r.reply_ref) };
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
      .prepare('INSERT OR REPLACE INTO conversations (platform, thread_key, conversation_id, source_id, reply_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.platform, r.threadKey, r.conversationId, r.sourceId, JSON.stringify(r.replyRef), Date.now());
  }

  /** Returns true the first time a key is seen (atomic), false on repeats. */
  markSeen(key: string): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO seen (key, at) VALUES (?, ?)').run(key, Date.now());
    return Number(res.changes) === 1;
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM seen WHERE key = ?').run(key);
  }

  pruneSeen(olderThanMs = 7 * 24 * 3600 * 1000): void {
    this.db.prepare('DELETE FROM seen WHERE at < ?').run(Date.now() - olderThanMs);
  }

  close(): void {
    this.db.close();
  }
}
