import { randomBytes } from 'node:crypto';
import { safeEqual } from '../../crypto.ts';
import { log } from '../../log.ts';
import type { Store } from '../../store.ts';
import type { InboundMessage } from '../../types.ts';
import { Graph, GraphAuth } from './graph.ts';
import { filterNotifications, resolveNotification, SenderClassifier, TeamsSender, type GraphNotification, type TeamsMessageFormat } from './messages.ts';
import { discoverResources, SubscriptionManager } from './subscriptions.ts';

export interface TeamsConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  kitaUserUpn: string;
  internalTenantIds: string[];
  connectKey: string;
  teamIds: string[];
  extraChannels: string[];
  messageFormat: TeamsMessageFormat;
  encryptionKey: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/** Wires Graph auth, subscriptions, inbound resolution and the sender for the Kita service account. */
export class TeamsIntegration {
  auth: GraphAuth;
  graph: Graph;
  subs: SubscriptionManager;
  classifier: SenderClassifier;
  sender: TeamsSender;
  private cfg: TeamsConfig;
  private states = new Map<string, number>();

  constructor(cfg: TeamsConfig, publicUrl: string, store: Store, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.auth = new GraphAuth(
      { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: `${publicUrl}/teams/connect/callback`, kitaUserUpn: cfg.kitaUserUpn, encryptionKey: cfg.encryptionKey },
      store,
      fetchImpl,
    );
    this.graph = new Graph(this.auth, fetchImpl);
    this.subs = new SubscriptionManager(
      this.graph,
      store,
      { notificationUrl: `${publicUrl}/teams/notifications`, lifecycleNotificationUrl: `${publicUrl}/teams/lifecycle` },
      () => discoverResources(this.graph, { kitaUserId: this.auth.kitaUserId()!, tenantId: cfg.tenantId, teamIds: cfg.teamIds, extraChannels: cfg.extraChannels }),
    );
    this.classifier = new SenderClassifier(this.graph, { kitaUserId: () => this.auth.kitaUserId(), internalTenantIds: cfg.internalTenantIds });
    this.sender = new TeamsSender(this.graph, cfg.messageFormat, fetchImpl);
  }

  /** Step 1 of the one-time connect flow; guarded by TEAMS_CONNECT_KEY so strangers can't start it. */
  connectUrl(key: string | null): string | undefined {
    if (!key || !safeEqual(key, this.cfg.connectKey)) return undefined;
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return this.auth.authorizeUrl(state);
  }

  async connectCallback(code: string | null, state: string | null): Promise<string> {
    const exp = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state);
    if (!code || !exp || exp < Date.now()) throw new Error('invalid or expired state');
    const who = await this.auth.completeConnect(code);
    await this.subs.sync();
    return who.upn;
  }

  sync() {
    return this.auth.isConnected() ? this.subs.sync() : Promise.resolve();
  }

  /** Trusted notifications only; each resolves to a customer message or a skip reason. */
  async notifications(body: any, deliver: (m: InboundMessage) => Promise<unknown>) {
    const { accepted, rejected } = filterNotifications(body, (id, cs) => this.subs.verifyClientState(id ?? '', cs ?? ''));
    if (rejected) log.warn('teams_notifications_rejected', { rejected });
    for (const n of accepted) {
      try {
        const parsed = await resolveNotification(this.graph, this.classifier, n);
        if (parsed.kind === 'message') await deliver(parsed.message);
      } catch (e) {
        log.error('teams_inbound_failed', { error: String((e as Error).message) });
      }
    }
    return { accepted: accepted.length, rejected };
  }

  async lifecycle(body: any) {
    const { accepted, rejected } = filterNotifications(body, (id, cs) => this.subs.verifyClientState(id ?? '', cs ?? ''));
    const results: string[] = [];
    for (const n of accepted as GraphNotification[]) results.push(await this.subs.lifecycle({ subscriptionId: n.subscriptionId, lifecycleEvent: n.lifecycleEvent ?? '' }));
    return { results, rejected };
  }
}
