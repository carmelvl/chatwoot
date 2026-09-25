import { Throttle, type BackfillContext } from '../backfill.ts';
import { log } from '../log.ts';
import { parseSlackMessage, SlackApiError, type SlackParseOptions, type SlackProfile } from './slack.ts';

/** conversations.history / .replies are Tier 3 (about 50 calls a minute). */
export const SLACK_TIER3_INTERVAL_MS = 1200;
const MAX_RATE_LIMIT_RETRIES = 8;

export interface SlackHistoryOptions {
  botToken: string;
  parse: SlackParseOptions;
  /** users.info lookups (cached by SlackSender): name, email, avatar, workspace. */
  profile: (userId: string) => Promise<SlackProfile>;
  /** "#channel-name" lookup (cached by SlackSender). */
  channelName: (channelId: string) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Slack history for the backfill: every message of a channel (conversations.history, paginated) plus
 * every thread (conversations.replies per thread root), imported oldest first through the live path.
 * Bot-token only; the scopes are the ones live messages already need (channels/groups:history + :read).
 */
export class SlackHistory {
  private o: SlackHistoryOptions;
  private fetchImpl: typeof fetch;
  private throttle: Throttle;
  private botUser?: string;

  constructor(o: SlackHistoryOptions) {
    this.o = o;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.throttle = new Throttle(o.minIntervalMs ?? SLACK_TIER3_INTERVAL_MS, o.sleep);
  }

  /** GET a Web API method with the bot token; waits for the rate limit and retries 429s after Retry-After. */
  async call(method: string, params: Record<string, string | undefined>): Promise<any> {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
    for (let attempt = 0; ; attempt++) {
      await this.throttle.wait();
      const res = await this.fetchImpl(`https://slack.com/api/${method}?${q}`, { headers: { authorization: `Bearer ${this.o.botToken}` } });
      const j: any = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
      if ((res.status === 429 || j.error === 'ratelimited') && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait = Number(res.headers.get('retry-after')) || 30;
        log.warn('slack_rate_limited', { method, retry_after: wait });
        await this.throttle.backoff(wait);
        continue;
      }
      if (!j.ok) throw new SlackApiError(method, j.error ?? `http_${res.status}`);
      return j;
    }
  }

  /** Every page of a cursor-paginated method, concatenating `key`. */
  private async all(method: string, params: Record<string, string | undefined>, key: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const j = await this.call(method, { ...params, limit: '200', cursor });
      out.push(...(j[key] ?? []));
      cursor = j.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** The bot's own user id (auth.test), for member_joined_channel payloads without `authorizations`. */
  async botUserId(): Promise<string | undefined> {
    if (!this.botUser) this.botUser = (await this.call('auth.test', {})).user_id;
    return this.botUser;
  }

  /** Every channel the bot is a member of (public, private, Slack Connect), for reconciliation. */
  async memberChannels(): Promise<string[]> {
    const list = await this.all('users.conversations', { types: 'public_channel,private_channel', exclude_archived: 'true' }, 'channels');
    return list.map((c) => String(c.id));
  }

  /** Backfill runner: history + threads, sorted by ts, each message enriched like app.ts does for live events. */
  runner = async (ctx: BackfillContext): Promise<void> => {
    const channel = String(ctx.ref.channel);
    const oldest = ctx.since ? String(ctx.since / 1000) : undefined;
    const byTs = new Map<string, any>();
    const history = await this.all('conversations.history', { channel, oldest, include_all_metadata: 'false' }, 'messages');
    for (const m of history) byTs.set(m.ts, m);
    for (const root of history.filter((m) => m.thread_ts === m.ts && Number(m.reply_count) > 0)) {
      for (const r of await this.all('conversations.replies', { channel, ts: root.ts, oldest }, 'messages')) if (!byTs.has(r.ts)) byTs.set(r.ts, r);
    }
    const ordered = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts) || String(a.ts).localeCompare(String(b.ts)));
    const label = await this.o.channelName(channel);
    const botUserIds = [await this.botUserId().catch(() => undefined)].filter(Boolean) as string[];
    log.info('slack_backfill_fetched', { channel, messages: ordered.length, threads: history.filter((m) => Number(m.reply_count) > 0).length });
    for (const m of ordered) {
      let ev = { ...m, channel };
      const profile = m.user && !m.bot_id ? await this.o.profile(m.user) : {};
      // History items may lack user_team/team: the user's workspace decides staff vs customer.
      if (!ev.user_team && !ev.team && profile.teamId) ev = { ...ev, user_team: profile.teamId };
      const parsed = parseSlackMessage(ev, this.o.parse, botUserIds);
      if (parsed.kind !== 'message') continue;
      const msg = parsed.message;
      await ctx.import(
        {
          ...msg,
          conversationAttributes: label ? { ...msg.conversationAttributes, channel_label: label } : msg.conversationAttributes,
          userName: profile.name ?? msg.userKey,
          userEmail: profile.email,
          userAvatarUrl: profile.avatarUrl,
        },
        String(m.ts),
      );
    }
  };
}
