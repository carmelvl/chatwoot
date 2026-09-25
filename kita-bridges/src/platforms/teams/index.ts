import { randomBytes } from 'node:crypto';
import { safeEqual } from '../../crypto.ts';
import { log } from '../../log.ts';
import type { Store } from '../../store.ts';
import type { InboundMessage } from '../../types.ts';
import { Graph, GraphAuth } from './graph.ts';
import { filterNotifications, resolveNotification, SenderClassifier, TeamsSender, type GraphNotification, type TeamsMessageFormat } from './messages.ts';
import { discoverResources, SubscriptionManager } from './subscriptions.ts';
import { TeamsHistory, type TeamsRef } from './history.ts';

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
type ConnectState = { exp: number } & ({ kind: 'service' } | { kind: 'agent'; agentId: number; email: string });

/** Wires Graph auth, subscriptions, inbound resolution and the sender for the Kita service account. */
export class TeamsIntegration {
  auth: GraphAuth;
  graph: Graph;
  subs: SubscriptionManager;
  classifier: SenderClassifier;
  sender: TeamsSender;
  /** History backfill of newly discovered channels and chats. */
  history: TeamsHistory;
  private cfg: TeamsConfig;
  private states = new Map<string, ConnectState>();
  private store: Store;
  private fetchImpl: typeof fetch;
  private authCfg;
  private agentAuths = new Map<number, GraphAuth>();

  constructor(cfg: TeamsConfig, publicUrl: string, store: Store, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.authCfg = { tenantId: cfg.tenantId, clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: `${publicUrl}/teams/connect/callback`, kitaUserUpn: cfg.kitaUserUpn, encryptionKey: cfg.encryptionKey };
    this.auth = new GraphAuth(this.authCfg, store, fetchImpl);
    this.graph = new Graph(this.auth, fetchImpl);
    this.subs = new SubscriptionManager(
      this.graph,
      store,
      { notificationUrl: `${publicUrl}/teams/notifications`, lifecycleNotificationUrl: `${publicUrl}/teams/lifecycle` },
      () => discoverResources(this.graph, { kitaUserId: this.auth.kitaUserId()!, tenantId: cfg.tenantId, teamIds: cfg.teamIds, extraChannels: cfg.extraChannels }),
    );
    this.classifier = new SenderClassifier(this.graph, { kitaUserId: () => this.auth.kitaUserId(), internalTenantIds: cfg.internalTenantIds });
    this.history = new TeamsHistory(this.graph, this.classifier);
    this.sender = new TeamsSender(this.graph, cfg.messageFormat, fetchImpl, (id) => {
      const a = this.agentAuth(id);
      return a.isConnected() ? new Graph(a, fetchImpl) : undefined;
    });
  }

  /** Per-agent delegated auth (their own refresh token, encrypted, in the kv table). */
  agentAuth(agentId: number): GraphAuth {
    let a = this.agentAuths.get(agentId);
    if (!a) this.agentAuths.set(agentId, (a = new GraphAuth(this.authCfg, this.store, this.fetchImpl, String(agentId))));
    return a;
  }

  /** Per-agent connect: the caller has already verified the signed link. */
  agentConnectUrl(agentId: number, email: string): string {
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { exp: Date.now() + STATE_TTL_MS, kind: 'agent', agentId, email });
    return this.agentAuth(agentId).authorizeUrl(state, email);
  }

  /** Step 1 of the one-time connect flow; guarded by TEAMS_CONNECT_KEY so strangers can't start it. */
  connectUrl(key: string | null): string | undefined {
    if (!key || !safeEqual(key, this.cfg.connectKey)) return undefined;
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { exp: Date.now() + STATE_TTL_MS, kind: 'service' });
    return this.auth.authorizeUrl(state);
  }

  /** Shared callback for the Kita-user connect and per-agent connects (one redirect URI). */
  async connectCallback(code: string | null, state: string | null): Promise<string> {
    const st = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state);
    if (!code || !st || st.exp < Date.now()) throw new Error('invalid or expired state');
    if (st.kind === 'agent') return (await this.agentAuth(st.agentId).completeConnect(code, st.email)).upn;
    const who = await this.auth.completeConnect(code);
    await this.sync();
    return who.upn;
  }

  /** Called (not awaited) after each subscription sync: the backfill of newly discovered channels and chats. */
  onSynced?: () => Promise<unknown>;

  async sync() {
    if (!this.auth.isConnected()) return;
    await this.subs.sync();
    if (this.onSynced) void this.onSynced().catch((e) => log.error('teams_backfill_discovery_failed', { error: String(e?.message ?? e) }));
  }

  /** Every channel (subscribed) and chat the Kita user is in: what the backfill should cover. Empty until connected. */
  async backfillTargets(): Promise<TeamsRef[]> {
    const me = this.auth.kitaUserId();
    if (!me || !this.auth.isConnected()) return [];
    return this.history.targets(this.store.listSubscriptions().map((s) => s.resource), me);
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
