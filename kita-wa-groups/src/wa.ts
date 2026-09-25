import { join } from 'node:path';
import { clearAuthState, useEncryptedAuthState, type AuthLib } from './authstate.ts';
import type { Config } from './config.ts';
import { digits } from './config.ts';
import { log } from './log.ts';
import type { Mirror } from './mirror.ts';
import { eventIdOf, inviteCode, isGroupJid } from './normalize.ts';
import type { Store } from './store.ts';

/** The slice of Baileys this service uses (injected: tests pass a fake, server.ts the real module). */
export interface BaileysLib extends AuthLib {
  makeWASocket: (opts: any) => WaSocket;
  downloadMediaMessage: (msg: any, type: 'buffer', opts: any, ctx: any) => Promise<Buffer>;
  browser: [string, string, string];
  fetchLatestVersion?: () => Promise<[number, number, number] | undefined>;
}

export interface WaSocket {
  ev: { on: (event: string, fn: (arg: any) => void) => void };
  user?: { id: string } | null;
  groupGetInviteInfo: (code: string) => Promise<{ id: string; subject: string; size?: number }>;
  groupAcceptInvite: (code: string) => Promise<string | undefined>;
  groupMetadata: (jid: string) => Promise<{ id: string; subject: string; participants?: unknown[]; size?: number }>;
  groupFetchAllParticipating: () => Promise<Record<string, { id: string; subject: string; participants?: unknown[]; size?: number }>>;
  sendMessage: (jid: string, content: any) => Promise<{ key: { id?: string | null } } | undefined>;
  updateMediaMessage?: (msg: any) => Promise<any>;
  logout: () => Promise<void>;
  end: (err?: Error) => void;
}

export type Status = 'connecting' | 'pairing' | 'connected';

export class JoinError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Baileys' logger contract, reduced to our JSON log at warn and above (never message content). */
const quietLogger: any = {
  level: 'warn',
  child: () => quietLogger,
  trace() {},
  debug() {},
  info() {},
  warn: (o: any, m?: string) => log.warn('baileys', { detail: m ?? (typeof o === 'string' ? o : undefined) }),
  error: (o: any, m?: string) => log.error('baileys', { detail: m ?? (typeof o === 'string' ? o : o?.err?.message) }),
};

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * The dedicated Kita number as a WhatsApp linked device. Pairs by QR, reconnects with backoff, and on
 * logout forgets the device and shows a fresh QR. Never joins or replies on its own: joins only via
 * join(), sends only via send() with WA_GROUPS_SEND=on.
 */
export class WaClient {
  status: Status = 'connecting';
  qr?: string;
  number?: string;
  private sock?: WaSocket;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private cfg: Config;
  private store: Store;
  private lib: BaileysLib;
  private mirror: Mirror;

  constructor(o: { cfg: Config; store: Store; lib: BaileysLib; mirror: Mirror }) {
    this.cfg = o.cfg;
    this.store = o.store;
    this.lib = o.lib;
    this.mirror = o.mirror;
  }

  get authDir() {
    return join(this.cfg.dataDir, 'auth');
  }

  async start() {
    this.stopped = false;
    const { state, saveCreds } = await useEncryptedAuthState(this.authDir, this.cfg.encryptionKey, this.lib);
    const version = await this.lib.fetchLatestVersion?.().catch(() => undefined);
    const sock = this.lib.makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      browser: this.lib.browser,
      logger: quietLogger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: this.cfg.importHistory,
      shouldSyncHistoryMessage: () => this.cfg.importHistory,
      getMessage: async () => undefined,
    });
    this.sock = sock;
    this.status = state.creds?.registered ? 'connecting' : 'pairing';
    sock.ev.on('creds.update', () => void saveCreds().catch((e) => log.error('creds_save_failed', { error: String(e?.message ?? e) })));
    sock.ev.on('connection.update', (u) => void this.onConnection(sock, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      const groupMsgs = (messages ?? []).filter((m: any) => isGroupJid(m?.key?.remoteJid));
      if (groupMsgs.length) void this.mirror.handle(groupMsgs, { backfill: type !== 'notify' });
    });
    sock.ev.on('messaging-history.set', ({ messages, chats }) => {
      for (const c of chats ?? []) if (isGroupJid(c.id) && c.name) this.store.putGroup({ jid: c.id, subject: c.name });
      const groupMsgs = (messages ?? []).filter((m: any) => isGroupJid(m?.key?.remoteJid));
      if (this.cfg.importHistory && groupMsgs.length) {
        log.info('history_sync', { messages: groupMsgs.length });
        void this.mirror.handle(groupMsgs, { backfill: true });
      }
    });
    const upsertGroups = (gs: any[]) => {
      for (const g of gs ?? []) if (g?.id && g.subject) this.store.putGroup({ jid: g.id, subject: g.subject, participants: g.participants?.length ?? g.size });
    };
    sock.ev.on('groups.upsert', upsertGroups);
    sock.ev.on('groups.update', upsertGroups);
  }

  private async onConnection(sock: WaSocket, u: any) {
    if (sock !== this.sock) return;
    if (u.qr) {
      this.qr = u.qr;
      this.status = 'pairing';
    }
    if (u.connection === 'open') {
      this.status = 'connected';
      this.qr = undefined;
      this.attempt = 0;
      this.number = sock.user?.id ? digits(sock.user.id.split('@')[0].split(':')[0]) : undefined;
      log.info('connected', { groups: this.store.listGroups().length });
      void this.refreshGroups();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode ?? u.lastDisconnect?.error?.statusCode;
      this.sock = undefined;
      if (this.stopped) return;
      if (code === 401) {
        // Logged out (unlinked from the phone, or banned): forget the device, show a fresh QR.
        log.warn('logged_out', { code });
        this.number = undefined;
        this.status = 'pairing';
        await clearAuthState(this.authDir);
        this.schedule(0);
        return;
      }
      this.status = this.number ? 'connecting' : 'pairing';
      // 515 = restart required right after pairing: reconnect immediately.
      const delay = code === 515 ? 0 : BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
      log.warn('disconnected', { code, retry_ms: delay });
      this.schedule(delay);
    }
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.start().catch((e) => {
      log.error('start_failed', { error: String(e?.message ?? e) });
      this.schedule(BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]);
    }), ms);
    this.timer.unref?.();
  }

  /** Subjects of every group the number is in (labels for the desk). */
  async refreshGroups() {
    try {
      const all = await this.sock!.groupFetchAllParticipating();
      for (const g of Object.values(all)) this.store.putGroup({ jid: g.id, subject: g.subject, participants: g.participants?.length ?? g.size });
    } catch (e: any) {
      log.warn('groups_refresh_failed', { error: String(e?.message ?? e) });
    }
  }

  subject(jid: string): string | undefined {
    const known = this.store.getGroup(jid)?.subject;
    if (!known && this.sock && this.status === 'connected')
      void this.sock.groupMetadata(jid).then((g) => this.store.putGroup({ jid, subject: g.subject, participants: g.participants?.length })).catch(() => {});
    return known;
  }

  /** Joins a group from its invite link (validated, rate limited). Never called automatically. */
  async join(link: unknown): Promise<{ jid: string; subject: string; already?: boolean }> {
    const code = inviteCode(link);
    if (!code) throw new JoinError(422, 'invalid_invite_link');
    const sock = this.sock;
    if (!sock || this.status !== 'connected') throw new JoinError(409, 'not_connected');
    let info: { id: string; subject: string; size?: number };
    try {
      info = await sock.groupGetInviteInfo(code);
    } catch {
      throw new JoinError(404, 'invite_link_invalid_or_revoked');
    }
    const existing = this.store.getGroup(info.id);
    if (existing) return { jid: existing.jid, subject: existing.subject, already: true };
    if (!this.store.takeJoin(this.cfg.joinsPerHour)) throw new JoinError(429, 'join_rate_limited');
    const jid = (await sock.groupAcceptInvite(code)) ?? info.id;
    this.store.putGroup({ jid, subject: info.subject, participants: info.size });
    log.info('group_joined', { jid });
    return { jid, subject: info.subject };
  }

  groups() {
    return this.store.listGroups();
  }

  /** Desk reply -> the group, as the Kita number. Only with WA_GROUPS_SEND=on. Returns the bridge event id. */
  async send(groupJid: string, text: string): Promise<string> {
    if (!this.cfg.send) throw new JoinError(403, 'sending_disabled');
    if (!isGroupJid(groupJid) || !this.store.getGroup(groupJid)) throw new JoinError(404, 'unknown_group');
    if (!this.sock || this.status !== 'connected') throw new JoinError(409, 'not_connected');
    const sent = await this.sock.sendMessage(groupJid, { text });
    if (!sent?.key?.id) throw new Error('send_failed');
    const eventId = eventIdOf(groupJid, sent.key.id);
    this.store.markSent(eventId);
    return eventId;
  }

  download(msg: any): Promise<Buffer> {
    const sock = this.sock;
    return this.lib.downloadMediaMessage(msg, 'buffer', {}, { logger: quietLogger, reuploadRequest: sock?.updateMediaMessage });
  }

  /** Unlinks the device (e.g. to move to a new number); a fresh QR follows. */
  async logout() {
    await this.sock?.logout().catch(() => {});
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.sock?.end();
  }
}
