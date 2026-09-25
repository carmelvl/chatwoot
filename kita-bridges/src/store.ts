import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Platform } from './types.ts';

/** Conversation rows of the single Customers inbox use this platform value. */
export const CUSTOMERS = 'customers';

export interface ConversationRow {
  /** 'customers' for the Customers inbox (thread_key account:<id> | channel:<key>); legacy rows carry a Platform. */
  platform: string;
  threadKey: string;
  conversationId: number;
  /** Chatwoot contact_inbox source_id of the contact that owns the conversation. */
  sourceId: string;
  replyRef: Record<string, unknown>;
  /** Last Chatwoot status seen via conversation_status_changed ('open' until told otherwise). */
  status?: string;
}

export interface MessageRow {
  extId: string;
  deskId: number;
  root: string;
  /** Channel the message was in (absent on legacy rows). */
  channelKey?: string;
  platform?: Platform;
}

/** A platform channel attached to a desk conversation: where replies go, and what kita_channels lists. */
export interface ChannelRow {
  channelKey: string;
  conversationId: number;
  platform: Platform;
  replyRef: Record<string, unknown>;
  label: string;
  lastAt: number;
}

/** History import of one channel/chat: `cursor` is the platform timestamp of the last message imported (oldest first). */
export type BackfillState = 'running' | 'completed' | 'failed' | 'skipped_out_of_scope';
export interface BackfillRow {
  channelKey: string;
  platform: Platform;
  /** What the platform runner needs to fetch the history again (Slack channel id, Teams team/channel or chat id). */
  ref: Record<string, unknown>;
  state: BackfillState;
  cursor?: string;
  imported: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
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
      CREATE TABLE IF NOT EXISTS messages (
        platform TEXT NOT NULL, ext_id TEXT NOT NULL, desk_id INTEGER NOT NULL, root TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (platform, ext_id));
      CREATE INDEX IF NOT EXISTS messages_by_desk ON messages (platform, desk_id);
      CREATE TABLE IF NOT EXISTS channels (
        channel_key TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, platform TEXT NOT NULL,
        reply_ref TEXT NOT NULL, label TEXT NOT NULL, last_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS channels_by_cw ON channels (conversation_id);
      CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media (token TEXT PRIMARY KEY, source_url TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backfills (
        channel_key TEXT PRIMARY KEY, platform TEXT NOT NULL, ref TEXT NOT NULL, state TEXT NOT NULL, cursor TEXT,
        imported INTEGER NOT NULL DEFAULT 0, started_at INTEGER, completed_at INTEGER, error TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_subscriptions (
        id TEXT PRIMARY KEY, resource TEXT NOT NULL UNIQUE, client_state TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    const cols = (this.db.prepare('PRAGMA table_info(conversations)').all() as any[]).map((c) => c.name);
    const mcols = (this.db.prepare('PRAGMA table_info(messages)').all() as any[]).map((c) => c.name);
    if (!mcols.includes('channel_key')) this.db.exec('ALTER TABLE messages ADD COLUMN channel_key TEXT');
    if (!cols.includes('status')) this.db.exec("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  }

  getContactSourceId(platform: string, userKey: string): string | undefined {
    const r = this.db.prepare('SELECT source_id FROM contacts WHERE platform = ? AND user_key = ?').get(platform, userKey) as
      | { source_id: string } | undefined;
    return r?.source_id;
  }

  putContact(platform: string, userKey: string, sourceId: string): void {
    this.db.prepare('INSERT OR REPLACE INTO contacts (platform, user_key, source_id) VALUES (?, ?, ?)').run(platform, userKey, sourceId);
  }

  private row(r: any): ConversationRow | undefined {
    if (!r) return undefined;
    return { platform: r.platform, threadKey: r.thread_key, conversationId: Number(r.conversation_id), sourceId: r.source_id, replyRef: JSON.parse(r.reply_ref), status: r.status };
  }

  getByThread(platform: string, threadKey: string): ConversationRow | undefined {
    return this.row(this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND thread_key = ?').get(platform, threadKey));
  }

  getByConversation(platform: string, conversationId: number): ConversationRow | undefined {
    return this.row(
      this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND conversation_id = ? ORDER BY updated_at DESC LIMIT 1').get(platform, conversationId),
    );
  }

  putConversation(r: ConversationRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO conversations (platform, thread_key, conversation_id, source_id, reply_ref, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.platform, r.threadKey, r.conversationId, r.sourceId, JSON.stringify(r.replyRef), Date.now(), r.status ?? 'open');
  }

  setConversationStatus(platform: string, conversationId: number, status: string): void {
    this.db.prepare('UPDATE conversations SET status = ? WHERE platform = ? AND conversation_id = ?').run(status, platform, conversationId);
  }

  deleteConversation(platform: string, threadKey: string): void {
    this.db.prepare('DELETE FROM conversations WHERE platform = ? AND thread_key = ?').run(platform, threadKey);
  }

  /** Conversations of a platform whose thread_key starts with `prefix`. */
  /** Forgets a desk conversation that no longer exists: its thread rows, channels and cached attributes. */
  dropDeskConversation(conversationId: number): void {
    this.db.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(conversationId);
    this.db.prepare('DELETE FROM channels WHERE conversation_id = ?').run(conversationId);
    this.deleteKv(`attrs:${conversationId}`);
  }

  listConversations(platform: string, prefix = ''): ConversationRow[] {
    return (this.db.prepare('SELECT * FROM conversations WHERE platform = ? AND thread_key LIKE ?').all(platform, `${prefix}%`) as any[]).map((r) => this.row(r)!);
  }

  /** Platform message (eventId format) <-> desk message id, with its thread root (eventId format) and channel. */
  putMessage(platform: Platform, extId: string, deskId: number, root: string, channelKey?: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO messages (platform, ext_id, desk_id, root, at, channel_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(platform, extId, deskId, root, Date.now(), channelKey ?? null);
  }

  private msg(r: any): MessageRow | undefined {
    if (!r) return undefined;
    return { extId: r.ext_id, deskId: Number(r.desk_id), root: r.root, ...(r.channel_key ? { channelKey: r.channel_key } : {}), platform: r.platform };
  }

  getMessageByExt(platform: Platform, extId: string): MessageRow | undefined {
    return this.msg(this.db.prepare('SELECT * FROM messages WHERE platform = ? AND ext_id = ?').get(platform, extId));
  }

  /** Desk ids are unique across the account, so the platform is optional. */
  getMessageByDesk(deskId: number, platform?: Platform): MessageRow | undefined {
    return this.msg(
      platform
        ? this.db.prepare('SELECT * FROM messages WHERE platform = ? AND desk_id = ? ORDER BY at LIMIT 1').get(platform, deskId)
        : this.db.prepare('SELECT * FROM messages WHERE desk_id = ? ORDER BY at LIMIT 1').get(deskId),
    );
  }

  private chan(r: any): ChannelRow | undefined {
    if (!r) return undefined;
    return { channelKey: r.channel_key, conversationId: Number(r.conversation_id), platform: r.platform, replyRef: JSON.parse(r.reply_ref), label: r.label, lastAt: Number(r.last_at) };
  }

  getChannel(channelKey: string): ChannelRow | undefined {
    return this.chan(this.db.prepare('SELECT * FROM channels WHERE channel_key = ?').get(channelKey));
  }

  putChannel(c: ChannelRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO channels (channel_key, conversation_id, platform, reply_ref, label, last_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.channelKey, c.conversationId, c.platform, JSON.stringify(c.replyRef), c.label, c.lastAt);
  }

  /** Channels of a conversation, most recently active first. */
  channelsFor(conversationId: number): ChannelRow[] {
    return (this.db.prepare('SELECT * FROM channels WHERE conversation_id = ? ORDER BY last_at DESC, rowid DESC').all(conversationId) as any[]).map((r) => this.chan(r)!);
  }

  /** After a desk merge: every channel of `from` now belongs to `to`. */
  repointChannels(fromConversationId: number, toConversationId: number): void {
    this.db.prepare('UPDATE channels SET conversation_id = ? WHERE conversation_id = ?').run(toConversationId, fromConversationId);
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

  private backfill(r: any): BackfillRow | undefined {
    if (!r) return undefined;
    return {
      channelKey: r.channel_key, platform: r.platform, ref: JSON.parse(r.ref), state: r.state, imported: Number(r.imported),
      ...(r.cursor ? { cursor: r.cursor } : {}), ...(r.started_at ? { startedAt: Number(r.started_at) } : {}),
      ...(r.completed_at ? { completedAt: Number(r.completed_at) } : {}), ...(r.error ? { error: r.error } : {}),
    };
  }

  getBackfill(channelKey: string): BackfillRow | undefined {
    return this.backfill(this.db.prepare('SELECT * FROM backfills WHERE channel_key = ?').get(channelKey));
  }

  putBackfill(b: BackfillRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO backfills (channel_key, platform, ref, state, cursor, imported, started_at, completed_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.channelKey, b.platform, JSON.stringify(b.ref), b.state, b.cursor ?? null, b.imported, b.startedAt ?? null, b.completedAt ?? null, b.error ?? null, Date.now());
  }

  listBackfills(state?: BackfillState): BackfillRow[] {
    const rows = state ? this.db.prepare('SELECT * FROM backfills WHERE state = ?').all(state) : this.db.prepare('SELECT * FROM backfills').all();
    return (rows as any[]).map((r) => this.backfill(r)!);
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
