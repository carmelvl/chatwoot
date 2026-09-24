import { createHash } from 'node:crypto';
import { log } from './log.ts';
import { GraphError, type Graph } from './platforms/teams/graph.ts';
import type { Store } from './store.ts';

/**
 * Team in every customer channel: on each Grip scope refresh, make sure every Kita team member is in
 * every IN-SCOPE Slack channel and Teams channel/chat. It only ever adds people, never removes anyone.
 *
 *  - off:     does nothing.
 *  - dry-run: (default) resolves everything and logs `teamsync_would_add`, but makes no write calls.
 *  - on:      invites / adds the missing members.
 *
 * A per-channel hash of the roster is kept in SQLite (kv `teamsync:<channel_key>`), written only after a
 * channel synced cleanly, so unchanged channels are skipped without any API call. WhatsApp and Viber are 1:1
 * and have no membership: skipped.
 */
export type TeamSyncMode = 'off' | 'dry-run' | 'on';

export const parseTeamSyncMode = (v: string | undefined): TeamSyncMode => (v === 'off' || v === 'on' ? v : 'dry-run');

/** Outcome of one channel. `clean` = nothing left to retry, so the roster hash may be stored. */
interface ChannelResult {
  added: string[];
  wouldAdd: string[];
  clean: boolean;
}

export interface MembershipProvider {
  /** Adds the missing roster members to `id` (the part after `platform:`). Must never throw for per-user problems. */
  sync(id: string, roster: string[], dryRun: boolean): Promise<ChannelResult>;
}

export interface TeamSyncDeps {
  mode: TeamSyncMode;
  store: Store;
  roster: () => Promise<string[]>;
  slack?: MembershipProvider;
  teams?: MembershipProvider;
}

export function rosterHash(roster: string[]): string {
  return createHash('sha256').update([...roster].sort().join('\n')).digest('hex').slice(0, 32);
}

export class TeamSync {
  private d: TeamSyncDeps;
  private running?: Promise<void>;

  constructor(d: TeamSyncDeps) {
    this.d = d;
  }

  /** Single-flight: a refresh that lands while a run is in progress joins it. */
  run(inScope: string[]): Promise<void> {
    if (this.d.mode === 'off') return Promise.resolve();
    this.running ??= this.doRun(inScope).finally(() => (this.running = undefined));
    return this.running;
  }

  private async doRun(inScope: string[]) {
    const { store, mode } = this.d;
    const dryRun = mode === 'dry-run';
    const roster = [...new Set((await this.d.roster()).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!roster.length) {
      log.warn('teamsync_empty_roster');
      return;
    }
    const hash = rosterHash(roster);
    const stats = { channels: 0, skipped_unchanged: 0, added: 0, would_add: 0, not_applicable: 0 };
    for (const key of inScope) {
      const [platform, ...rest] = key.split(':');
      const id = rest.join(':');
      const provider = platform === 'slack' ? this.d.slack : platform === 'teams' ? this.d.teams : undefined;
      if (!provider || !id) {
        stats.not_applicable++; // whatsapp/viber are 1:1; or the platform isn't enabled
        continue;
      }
      const hashKey = dryRun ? `teamsync.dry:${key}` : `teamsync:${key}`;
      if (store.getKv(hashKey) === hash) {
        stats.skipped_unchanged++;
        continue;
      }
      stats.channels++;
      try {
        const r = await provider.sync(id, roster, dryRun);
        stats.added += r.added.length;
        stats.would_add += r.wouldAdd.length;
        if (r.wouldAdd.length) log.info('teamsync_would_add', { channel_key: key, emails: r.wouldAdd });
        if (r.added.length) log.info('teamsync_added', { channel_key: key, emails: r.added });
        if (r.clean) store.putKv(hashKey, hash);
      } catch (e) {
        log.error('teamsync_channel_failed', { channel_key: key, error: String((e as Error).message) });
      }
    }
    log.info('teamsync_done', { mode, roster: roster.length, ...stats });
  }
}

// ---------------------------------------------------------------------------------------------- roster

export interface RosterOptions {
  /** TEAM_ROSTER: explicit emails. Empty = every active Chatwoot agent. */
  emails: string[];
  exclude: string[];
  listAgents?: () => Promise<{ email?: string; confirmed?: boolean; type?: string }[]>;
}

export function rosterSource(o: RosterOptions): () => Promise<string[]> {
  const exclude = new Set(o.exclude.map((e) => e.toLowerCase()));
  return async () => {
    if (o.emails.length) return o.emails.filter((e) => !exclude.has(e.toLowerCase()));
    if (!o.listAgents) {
      log.warn('teamsync_no_roster', { reason: 'TEAM_ROSTER unset and no Chatwoot API token to list agents' });
      return [];
    }
    return (await o.listAgents())
      .filter((a) => a.email && a.confirmed !== false && a.type !== 'agent_bot' && !exclude.has(a.email.toLowerCase()))
      .map((a) => a.email!);
  };
}

// ---------------------------------------------------------------------------------------------- Slack

export class SlackRateLimited extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super('ratelimited');
    this.retryAfter = retryAfter;
  }
}

const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SlackMembershipOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between write calls (conversations.invite is Tier 3, ~50/min). */
  paceMs?: number;
}

/** Slack errors on conversations.invite that are final for that user (logged, not retried). */
const SLACK_FINAL = new Set(['cant_invite', 'restricted_action', 'user_is_restricted', 'user_is_ultra_restricted', 'cant_invite_self', 'user_not_found', 'user_disabled', 'no_permission', 'not_allowed_token_type', 'ekm_access_denied']);

/**
 * Slack via the bot token. Works for Slack Connect channels too: the bot (a member of Kita's workspace)
 * can invite Kita's own internal users into a shared channel; the host org's policy may still refuse with
 * restricted_action / cant_invite, which is logged per user.
 */
export class SlackMembership implements MembershipProvider {
  private o: SlackMembershipOptions;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private userIds = new Map<string, string | null>();
  private botUserId?: string;

  constructor(o: SlackMembershipOptions) {
    this.o = o;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? sleepReal;
  }

  private async once(method: string, params: Record<string, string>, write: boolean): Promise<any> {
    const url = `https://slack.com/api/${method}`;
    const headers = { authorization: `Bearer ${this.o.botToken}` };
    const res = write
      ? await this.fetchImpl(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) })
      : await this.fetchImpl(`${url}?${new URLSearchParams(params)}`, { headers });
    if (res.status === 429) throw new SlackRateLimited(Number(res.headers.get('retry-after')) || 30);
    const j: any = await res.json();
    if (!j.ok && j.error === 'ratelimited') throw new SlackRateLimited(Number(res.headers.get('retry-after')) || 30);
    return j;
  }

  /** Calls Slack, honouring Retry-After on 429 / ratelimited (up to 3 waits). Returns the JSON, ok or not. */
  async call(method: string, params: Record<string, string>, write = false): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, params, write);
      } catch (e) {
        if (!(e instanceof SlackRateLimited) || attempt >= 3) throw e;
        log.warn('teamsync_slack_ratelimited', { method, retry_after_s: e.retryAfter });
        await this.sleep(e.retryAfter * 1000);
      }
    }
  }

  private async userId(email: string): Promise<string | null> {
    if (this.userIds.has(email)) return this.userIds.get(email)!;
    const j = await this.call('users.lookupByEmail', { email });
    const id = j.ok ? String(j.user.id) : null;
    if (!j.ok && j.error !== 'users_not_found') throw new Error(`users.lookupByEmail: ${j.error}`);
    if (!id) log.warn('teamsync_slack_user_not_found', { email });
    this.userIds.set(email, id);
    return id;
  }

  private async bot(): Promise<string> {
    if (!this.botUserId) {
      const j = await this.call('auth.test', {});
      if (!j.ok) throw new Error(`auth.test: ${j.error}`);
      this.botUserId = String(j.user_id);
    }
    return this.botUserId;
  }

  private async members(channel: string): Promise<Set<string> | null> {
    const out = new Set<string>();
    let cursor = '';
    do {
      const j = await this.call('conversations.members', { channel, limit: '1000', ...(cursor ? { cursor } : {}) });
      if (!j.ok) {
        if (j.error === 'channel_not_found' || j.error === 'not_in_channel') return null; // private channel the bot isn't in
        throw new Error(`conversations.members: ${j.error}`);
      }
      for (const m of j.members ?? []) out.add(String(m));
      cursor = j.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return out;
  }

  async sync(channel: string, roster: string[], dryRun: boolean): Promise<ChannelResult> {
    const r: ChannelResult = { added: [], wouldAdd: [], clean: true };
    const bot = await this.bot();
    const members = await this.members(channel);
    if (!members || !members.has(bot)) {
      log.warn('teamsync_slack_bot_not_in_channel', { channel, fix: 'invite the Kita app to the channel (/invite @Kita)' });
      return { ...r, clean: false };
    }
    for (const email of roster) {
      const uid = await this.userId(email);
      if (!uid || members.has(uid)) continue;
      if (dryRun) {
        r.wouldAdd.push(email);
        continue;
      }
      const j = await this.call('conversations.invite', { channel, users: uid }, true);
      await this.sleep(this.o.paceMs ?? 1200);
      if (j.ok || j.error === 'already_in_channel') {
        if (j.ok) r.added.push(email);
        continue;
      }
      if (SLACK_FINAL.has(j.error)) log.warn('teamsync_slack_cant_invite', { channel, email, error: j.error });
      else {
        log.error('teamsync_slack_invite_failed', { channel, email, error: j.error });
        r.clean = false;
      }
    }
    return r;
  }
}

// ---------------------------------------------------------------------------------------------- Teams

export interface TeamsMembershipOptions {
  graph: Pick<Graph, 'request' | 'list'>;
  store: Store;
  sleep?: (ms: number) => Promise<void>;
  /** Microsoft asks for a ~2s buffer between member adds. */
  paceMs?: number;
}

/** Full chat history for a newly added chat member (Graph: 0001-01-01T00:00:00Z = all history). */
export const ALL_HISTORY = '0001-01-01T00:00:00Z';

const memberBody = (userId: string, extra: Record<string, unknown> = {}) => ({
  '@odata.type': '#microsoft.graph.aadUserConversationMember',
  roles: [],
  'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${userId}')`,
  ...extra,
});

/**
 * Teams via the Kita service user's delegated Graph token.
 *  - `teams:<channelId>`: the team is found from the bridge's own subscription for that channel.
 *    standard channel -> add to the TEAM (POST /teams/{t}/members; channel membership is inherited);
 *    private/shared channel -> add to the channel (POST /teams/{t}/channels/{c}/members; Kita user must be an owner).
 *  - `teams:<chatId>` (no channel subscription): POST /chats/{id}/members with full history.
 */
export class TeamsMembership implements MembershipProvider {
  private o: TeamsMembershipOptions;
  private sleep: (ms: number) => Promise<void>;
  private userIds = new Map<string, string | null>();

  constructor(o: TeamsMembershipOptions) {
    this.o = o;
    this.sleep = o.sleep ?? sleepReal;
  }

  /** Graph call that waits out 429/503 Retry-After (up to 3 times). */
  private async req(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.graph.request(method, path, body);
      } catch (e) {
        if (!(e instanceof GraphError) || (e.status !== 429 && e.status !== 503) || attempt >= 3) throw e;
        log.warn('teamsync_graph_throttled', { path: path.split('?')[0], retry_after_s: e.retryAfter ?? 10 });
        await this.sleep((e.retryAfter ?? 10) * 1000);
      }
    }
  }

  private async list(path: string): Promise<any[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.graph.list(path);
      } catch (e) {
        if (!(e instanceof GraphError) || (e.status !== 429 && e.status !== 503) || attempt >= 3) throw e;
        await this.sleep((e.retryAfter ?? 10) * 1000);
      }
    }
  }

  private async userId(email: string): Promise<string | null> {
    if (this.userIds.has(email)) return this.userIds.get(email)!;
    let id: string | null = null;
    try {
      id = String((await this.req('GET', `/users/${encodeURIComponent(email)}?$select=id`)).id);
    } catch (e) {
      if (!(e instanceof GraphError && e.status === 404)) throw e;
      log.warn('teamsync_teams_user_not_found', { email });
    }
    this.userIds.set(email, id);
    return id;
  }

  /** Team id for a channel the bridge subscribes to (resource /teams/{t}/channels/{c}/messages). */
  private teamOf(channelId: string): string | undefined {
    for (const s of this.o.store.listSubscriptions()) {
      const m = s.resource.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/);
      if (m && decodeURIComponent(m[2]) === channelId) return m[1];
    }
    return undefined;
  }

  async sync(id: string, roster: string[], dryRun: boolean): Promise<ChannelResult> {
    const team = this.teamOf(id);
    const enc = encodeURIComponent(id);
    let target: { kind: string; list: string; add: string; extra?: Record<string, unknown> };
    if (team) {
      const ch = await this.req('GET', `/teams/${team}/channels/${enc}?$select=id,membershipType`);
      target = ch.membershipType === 'standard' || !ch.membershipType
        ? { kind: 'team', list: `/teams/${team}/members`, add: `/teams/${team}/members` }
        : { kind: `${ch.membershipType}_channel`, list: `/teams/${team}/channels/${enc}/members`, add: `/teams/${team}/channels/${enc}/members` };
    } else {
      target = { kind: 'chat', list: `/chats/${enc}/members`, add: `/chats/${enc}/members`, extra: { visibleHistoryStartDateTime: ALL_HISTORY } };
    }

    const r: ChannelResult = { added: [], wouldAdd: [], clean: true };
    let current: any[];
    try {
      current = await this.list(target.list);
    } catch (e) {
      if (e instanceof GraphError && (e.status === 403 || e.status === 404)) {
        this.forbidden(id, target.kind, e);
        return { ...r, clean: false };
      }
      throw e;
    }
    const have = new Set(current.flatMap((m) => [m.userId, m.email?.toLowerCase()]).filter(Boolean));
    for (const email of roster) {
      if (have.has(email)) continue;
      const uid = await this.userId(email);
      if (!uid || have.has(uid)) continue;
      if (dryRun) {
        r.wouldAdd.push(email);
        continue;
      }
      try {
        await this.req('POST', target.add, memberBody(uid, target.extra));
        r.added.push(email);
      } catch (e) {
        if (e instanceof GraphError && e.status === 409) continue; // already a member
        if (e instanceof GraphError && e.status === 403) {
          this.forbidden(id, target.kind, e);
          return { ...r, clean: false };
        }
        log.error('teamsync_teams_add_failed', { id, kind: target.kind, email, error: String((e as Error).message) });
        r.clean = false;
      }
      await this.sleep(this.o.paceMs ?? 2000);
    }
    return r;
  }

  private forbidden(id: string, kind: string, e: GraphError) {
    const fix = kind === 'chat'
      ? 'the Kita user must be a member of the chat, and the Entra app needs ChatMember.ReadWrite (admin consent, then reconnect /bridges/teams/connect)'
      : kind === 'team'
        ? 'make the Kita user an OWNER of the team, and grant TeamMember.ReadWrite.All (admin consent, then reconnect)'
        : 'make the Kita user an OWNER of the private/shared channel, and grant ChannelMember.ReadWrite.All (admin consent, then reconnect)';
    log.warn('teamsync_teams_forbidden', { id, kind, status: e.status, error: e.message, fix });
  }
}
