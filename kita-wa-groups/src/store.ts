import { DatabaseSync } from 'node:sqlite';

export interface GroupRow {
  jid: string;
  subject: string;
  participants: number;
  joinedAt: number;
}

/** Dedupe (message ids already delivered to the desk), joined groups, our own sent ids. node:sqlite, no deps. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS delivered (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (jid TEXT PRIMARY KEY, subject TEXT NOT NULL, participants INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS joins (at INTEGER NOT NULL);
    `);
  }

  isDelivered(eventId: string) {
    return !!this.db.prepare('SELECT 1 FROM delivered WHERE event_id = ?').get(eventId);
  }
  markDelivered(eventId: string) {
    this.db.prepare('INSERT OR IGNORE INTO delivered (event_id, at) VALUES (?, ?)').run(eventId, Date.now());
  }

  /** Messages the Kita number posted for the desk (WA_GROUPS_SEND=on): never mirrored back. */
  markSent(eventId: string) {
    this.db.prepare('INSERT OR IGNORE INTO sent (event_id, at) VALUES (?, ?)').run(eventId, Date.now());
  }
  isSent(eventId: string) {
    return !!this.db.prepare('SELECT 1 FROM sent WHERE event_id = ?').get(eventId);
  }

  putGroup(g: { jid: string; subject: string; participants?: number }) {
    this.db
      .prepare(`INSERT INTO groups (jid, subject, participants, joined_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject, participants = CASE WHEN excluded.participants > 0 THEN excluded.participants ELSE groups.participants END`)
      .run(g.jid, g.subject, g.participants ?? 0, Date.now());
  }
  getGroup(jid: string): GroupRow | undefined {
    const r = this.db.prepare('SELECT jid, subject, participants, joined_at AS joinedAt FROM groups WHERE jid = ?').get(jid) as any;
    return r ? { ...r } : undefined;
  }
  listGroups(): GroupRow[] {
    return (this.db.prepare('SELECT jid, subject, participants, joined_at AS joinedAt FROM groups ORDER BY subject').all() as any[]).map((r) => ({ ...r }));
  }
  deleteGroup(jid: string) {
    this.db.prepare('DELETE FROM groups WHERE jid = ?').run(jid);
  }

  /** Sliding-window join limiter (persisted, so restarts don't reset it). True = allowed and recorded. */
  takeJoin(perHour: number, now = Date.now()): boolean {
    this.db.prepare('DELETE FROM joins WHERE at < ?').run(now - 3600_000);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM joins').get() as { n: number };
    if (n >= perHour) return false;
    this.db.prepare('INSERT INTO joins (at) VALUES (?)').run(now);
    return true;
  }

  close() {
    this.db.close();
  }
}
