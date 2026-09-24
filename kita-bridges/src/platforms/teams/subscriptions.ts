import { randomBytes } from 'node:crypto';
import { safeEqual } from '../../crypto.ts';
import { log } from '../../log.ts';
import type { Store, SubscriptionRow } from '../../store.ts';
import { GraphError, type Graph } from './graph.ts';

/** chatMessage max is 4,320 min (3 days); stay safely under it. >1h requires lifecycleNotificationUrl. */
export const SUBSCRIPTION_LIFETIME_MS = 4200 * 60 * 1000;
/** Renew once less than this remains; with a 15-minute sync loop that leaves many retries before expiry. */
export const RENEW_BEFORE_MS = 12 * 3600 * 1000;
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;

export interface SubscriptionPlan {
  create: string[];
  renew: SubscriptionRow[];
  remove: SubscriptionRow[];
}

/** Pure scheduling: which resources need a new subscription, which to renew, which to drop. */
export function planSubscriptions(desired: string[], existing: SubscriptionRow[], now: number): SubscriptionPlan {
  const want = new Set(desired);
  const live = existing.filter((s) => s.expiresAt > now);
  const plan: SubscriptionPlan = {
    create: desired.filter((r) => !live.some((s) => s.resource === r)),
    renew: live.filter((s) => want.has(s.resource) && s.expiresAt - now < RENEW_BEFORE_MS),
    remove: existing.filter((s) => !want.has(s.resource) || s.expiresAt <= now),
  };
  return plan;
}

export interface DiscoveryOptions {
  kitaUserId: string;
  /** Kita's tenant: only channels hosted here can be subscribed with Kita's delegated token. */
  tenantId: string;
  /** Optional allow-list of team ids. */
  teamIds: string[];
  /** Extra "teamId/channelId" pairs (e.g. a shared channel whose host team the Kita user is not in). */
  extraChannels: string[];
}

/**
 * Resources to watch: every chat the Kita user is in (one user-level subscription) plus one
 * subscription per channel the Kita user can see in Kita-hosted teams, including shared channels
 * (teamwork/associatedTeams covers host teams of shared channels the user was added to directly).
 */
export async function discoverResources(graph: Graph, o: DiscoveryOptions): Promise<string[]> {
  const resources = new Set<string>([`/users/${o.kitaUserId}/chats/getAllMessages`]);
  const teams = await graph.list(`/users/${o.kitaUserId}/teamwork/associatedTeams`);
  for (const t of teams) {
    if (t.tenantId && t.tenantId !== o.tenantId) continue;
    if (o.teamIds.length && !o.teamIds.includes(t.id)) continue;
    try {
      for (const c of await graph.list(`/teams/${t.id}/channels?$select=id,membershipType`)) resources.add(`/teams/${t.id}/channels/${c.id}/messages`);
    } catch (e) {
      log.warn('teams_channel_list_failed', { team: t.id, error: String((e as Error).message) });
    }
  }
  for (const pair of o.extraChannels) {
    const [team, channel] = pair.split('/');
    if (team && channel) resources.add(`/teams/${team}/channels/${channel}/messages`);
  }
  return [...resources];
}

export interface SubscriptionUrls {
  notificationUrl: string;
  lifecycleNotificationUrl: string;
}

export class SubscriptionManager {
  private graph: Graph;
  private store: Store;
  private urls: SubscriptionUrls;
  private discover: () => Promise<string[]>;
  private running?: Promise<void>;

  constructor(graph: Graph, store: Store, urls: SubscriptionUrls, discover: () => Promise<string[]>) {
    this.graph = graph;
    this.store = store;
    this.urls = urls;
    this.discover = discover;
  }

  /** Each notification carries our per-subscription secret; anything else is forged or stale. */
  verifyClientState(subscriptionId: string | undefined, clientState: string | undefined): boolean {
    if (!subscriptionId || !clientState) return false;
    const s = this.store.getSubscription(subscriptionId);
    return Boolean(s && safeEqual(s.clientState, clientState));
  }

  /** Discover + reconcile. Serialised so the timer, lifecycle events and connect never race. */
  sync(now = Date.now()): Promise<void> {
    this.running ??= this.doSync(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async doSync(now: number) {
    const desired = await this.discover();
    const plan = planSubscriptions(desired, this.store.listSubscriptions(), now);
    for (const s of plan.remove) {
      await this.graph.request('DELETE', `/subscriptions/${s.id}`).catch(() => undefined);
      this.store.deleteSubscription(s.id);
    }
    for (const s of plan.renew) await this.renew(s, now);
    for (const r of plan.create) await this.create(r, now);
    log.info('teams_subscriptions_synced', { desired: desired.length, created: plan.create.length, renewed: plan.renew.length, removed: plan.remove.length });
  }

  private async create(resource: string, now: number): Promise<void> {
    const clientState = randomBytes(32).toString('base64url');
    const expirationDateTime = new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString();
    try {
      const sub = await this.graph.request('POST', '/subscriptions', {
        changeType: 'created',
        resource,
        notificationUrl: this.urls.notificationUrl,
        lifecycleNotificationUrl: this.urls.lifecycleNotificationUrl,
        includeResourceData: false, // no encryption cert to manage: we fetch each message by id
        expirationDateTime,
        clientState,
        latestSupportedTlsVersion: 'v1_2',
      });
      this.store.putSubscription({ id: sub.id, resource, clientState, expiresAt: Date.parse(sub.expirationDateTime) });
    } catch (e) {
      // 409 = Graph still has one for this resource (e.g. store was wiped): its clientState is unknown, so replace it.
      if (e instanceof GraphError && e.status === 409) {
        const existing = (await this.graph.list('/subscriptions')).find((s: any) => s.resource?.replace(/^\//, '') === resource.replace(/^\//, ''));
        if (existing) {
          await this.graph.request('DELETE', `/subscriptions/${existing.id}`);
          return this.create(resource, now);
        }
      }
      log.error('teams_subscription_create_failed', { resource, error: String((e as Error).message) });
    }
  }

  private async renew(s: SubscriptionRow, now: number) {
    try {
      const sub = await this.graph.request('PATCH', `/subscriptions/${s.id}`, { expirationDateTime: new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString() });
      this.store.putSubscription({ ...s, expiresAt: Date.parse(sub.expirationDateTime) });
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        this.store.deleteSubscription(s.id);
        await this.create(s.resource, now);
      } else log.error('teams_subscription_renew_failed', { id: s.id, error: String((e as Error).message) });
    }
  }

  /**
   * Lifecycle notifications (https://learn.microsoft.com/graph/change-notifications-lifecycle-events):
   * reauthorizationRequired -> PATCH renew (also reauthorizes); subscriptionRemoved -> recreate;
   * missed -> resync (messages in that window are not replayed; see README).
   */
  async lifecycle(event: { subscriptionId: string; lifecycleEvent: string }, now = Date.now()): Promise<string> {
    const s = this.store.getSubscription(event.subscriptionId);
    if (!s) return 'unknown_subscription';
    switch (event.lifecycleEvent) {
      case 'reauthorizationRequired':
        await this.renew(s, now);
        return 'renewed';
      case 'subscriptionRemoved':
        this.store.deleteSubscription(s.id);
        await this.create(s.resource, now);
        return 'recreated';
      case 'missed':
        log.warn('teams_notifications_missed', { resource: s.resource });
        await this.sync(now);
        return 'resynced';
      default:
        return `ignored:${event.lifecycleEvent}`;
    }
  }
}
