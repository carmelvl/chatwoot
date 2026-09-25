import { Throttle, type BackfillContext } from '../../backfill.ts';
import { log } from '../../log.ts';
import { GraphError, type Graph } from './graph.ts';
import { classifyAndParse, type MessageLocation, type SenderClassifier } from './messages.ts';

const MAX_THROTTLE_RETRIES = 8;
/** Graph's per-app limits for channel/chat message reads are generous; keep a small gap between pages anyway. */
export const GRAPH_HISTORY_INTERVAL_MS = 250;

/** One Teams container to backfill: a channel (team + channel id) or a chat. */
export type TeamsRef = { kind: 'channel'; teamId: string; channelId: string } | { kind: 'chat'; chatId: string };

export const teamsChannelKey = (ref: TeamsRef) => `teams:${ref.kind === 'chat' ? ref.chatId : ref.channelId}`;

/**
 * Teams history for the backfill, read with the Kita service account's delegated token:
 *   channels: GET /teams/{t}/channels/{c}/messages (+ /messages/{id}/replies per root)
 *   chats:    GET /chats/{id}/messages
 * paginated through @odata.nextLink, throttled, retrying 429/503 after Retry-After.
 */
export class TeamsHistory {
  private graph: Graph;
  private classifier: SenderClassifier;
  private throttle: Throttle;

  constructor(graph: Graph, classifier: SenderClassifier, o: { minIntervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.graph = graph;
    this.classifier = classifier;
    this.throttle = new Throttle(o.minIntervalMs ?? GRAPH_HISTORY_INTERVAL_MS, o.sleep);
  }

  private async get(path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle.wait();
      try {
        return await this.graph.request('GET', path);
      } catch (e) {
        if (!(e instanceof GraphError && (e.status === 429 || e.status === 503) && attempt < MAX_THROTTLE_RETRIES)) throw e;
        log.warn('graph_throttled', { status: e.status, retry_after: e.retryAfter ?? null });
        await this.throttle.backoff(e.retryAfter ?? 10);
      }
    }
  }

  private async list(path: string): Promise<any[]> {
    const out: any[] = [];
    let next: string | undefined = path;
    while (next) {
      const page = await this.get(next);
      out.push(...(page?.value ?? []));
      next = page?.['@odata.nextLink'];
    }
    return out;
  }

  /** Channels the Kita user can see (from the subscription resources) plus every chat it is in. */
  async targets(resources: string[], kitaUserId: string): Promise<TeamsRef[]> {
    const out: TeamsRef[] = [];
    for (const r of resources) {
      const m = r.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/);
      if (m) out.push({ kind: 'channel', teamId: m[1], channelId: decodeURIComponent(m[2]) });
    }
    for (const c of await this.list(`/users/${kitaUserId}/chats?$select=id`)) if (c?.id) out.push({ kind: 'chat', chatId: String(c.id) });
    return out;
  }

  /** Backfill runner: every message (and channel thread reply), oldest first, through the live path. */
  runner = async (ctx: BackfillContext): Promise<void> => {
    const ref = ctx.ref as TeamsRef;
    const items: { m: any; loc: MessageLocation }[] = [];
    if (ref.kind === 'chat') {
      for (const m of await this.list(`/chats/${encodeURIComponent(ref.chatId)}/messages?$top=50`))
        items.push({ m, loc: { kind: 'chat', chatId: ref.chatId, messageId: m.id } });
    } else {
      const base = `/teams/${ref.teamId}/channels/${encodeURIComponent(ref.channelId)}/messages`;
      for (const root of await this.list(`${base}?$top=50`)) {
        items.push({ m: root, loc: { kind: 'channel', teamId: ref.teamId, channelId: ref.channelId, messageId: root.id } });
        for (const r of await this.list(`${base}/${root.id}/replies?$top=50`))
          items.push({ m: r, loc: { kind: 'channel', teamId: ref.teamId, channelId: ref.channelId, messageId: r.id, replyToId: root.id } });
      }
    }
    const since = ctx.since ? new Date(ctx.since).toISOString() : undefined;
    const ordered = items
      .filter((x) => x.m?.createdDateTime && (!since || x.m.createdDateTime >= since))
      .sort((a, b) => Date.parse(a.m.createdDateTime) - Date.parse(b.m.createdDateTime));
    log.info('teams_backfill_fetched', { kind: ref.kind, messages: ordered.length });
    for (const { m, loc } of ordered) {
      const parsed = await classifyAndParse(this.graph, this.classifier, m, loc);
      if (parsed.kind === 'message') await ctx.import(parsed.message, new Date(m.createdDateTime).toISOString());
    }
  };
}
