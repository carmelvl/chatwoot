import { seal, unseal } from '../../crypto.ts';
import { log } from '../../log.ts';
import type { Store } from '../../store.ts';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Delegated scopes the "Kita" service account grants once (admin consent):
 * read/subscribe to channel + chat messages, send as Kita, discover teams/channels, and tell
 * guests from staff. offline_access yields the refresh token the bridge keeps.
 */
export const TEAMS_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'User.Read',
  'User.ReadBasic.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'ChannelMessage.Read.All',
  'ChannelMessage.Send',
  'Chat.Read',
  'ChatMessage.Send',
];

export interface GraphAuthConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** UPN of the licensed service account, e.g. kita@kita.ai. The connect flow refuses any other user. */
  kitaUserUpn: string;
  encryptionKey: string;
}

export class GraphError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(`graph ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** Agents only need to send as themselves; reading/subscribing stays with the shared Kita user. */
export const TEAMS_AGENT_SCOPES = ['offline_access', 'openid', 'profile', 'User.Read', 'ChannelMessage.Send', 'ChatMessage.Send'];

/**
 * OAuth2 authorization-code flow (one time) + refresh-token rotation for one principal:
 * 'service' = the shared Kita user (listener + fallback sender); otherwise a Chatwoot agent id.
 */
export class GraphAuth {
  private cfg: GraphAuthConfig;
  private store: Store;
  private fetchImpl: typeof fetch;
  private access?: { token: string; exp: number };
  private scopes: string[];
  private refreshKey: string;
  private userKey: string;

  constructor(cfg: GraphAuthConfig, store: Store, fetchImpl: typeof fetch = fetch, principal = 'service') {
    this.cfg = cfg;
    this.store = store;
    this.fetchImpl = fetchImpl;
    const service = principal === 'service';
    this.scopes = service ? TEAMS_SCOPES : TEAMS_AGENT_SCOPES;
    this.refreshKey = service ? 'teams.refresh_token' : `teams.agent.${principal}.refresh_token`;
    this.userKey = service ? 'teams.kita_user_id' : `teams.agent.${principal}.user_id`;
  }

  private get tokenUrl() {
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`;
  }

  authorizeUrl(state: string, loginHint = this.cfg.kitaUserUpn): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: 'code',
      redirect_uri: this.cfg.redirectUri,
      response_mode: 'query',
      scope: this.scopes.join(' '),
      state,
      login_hint: loginHint,
      prompt: 'select_account',
    });
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/authorize?${q}`;
  }

  isConnected(): boolean {
    return Boolean(this.store.getKv(this.refreshKey) && this.store.getKv(this.userKey));
  }

  /** Entra object id of the connected principal (the Kita user for 'service'). */
  kitaUserId(): string | undefined {
    return this.store.getKv(this.userKey);
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: this.scopes.join(' '), ...params }),
    });
    const j: any = await res.json();
    if (!res.ok || !j.access_token) throw new GraphError(res.status, j.error, j.error_description?.split('\n')[0] ?? 'token request failed');
    this.access = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    if (j.refresh_token) this.store.putKv(this.refreshKey, seal(this.cfg.encryptionKey, j.refresh_token));
    return j;
  }

  /**
   * Callback of the connect flow: exchange the code, verify the signed-in account is the expected
   * one (Kita user UPN, or the agent's Chatwoot email matched to UPN/mail), persist the refresh token.
   */
  async completeConnect(code: string, expected = this.cfg.kitaUserUpn): Promise<{ userId: string; upn: string }> {
    await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri });
    const me: any = await this.graphJson('GET', '/me?$select=id,userPrincipalName,mail');
    const ids = [me.userPrincipalName, me.mail].filter(Boolean).map((x: string) => x.toLowerCase());
    if (!ids.includes(expected.toLowerCase())) {
      this.store.deleteKv(this.refreshKey);
      this.access = undefined;
      throw new Error(`signed in as ${me.userPrincipalName}, expected ${expected}`);
    }
    this.store.putKv(this.userKey, me.id);
    return { userId: me.id, upn: me.userPrincipalName };
  }

  async accessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 120_000) return this.access.token;
    const sealed = this.store.getKv(this.refreshKey);
    if (!sealed) throw new GraphError(401, 'not_connected', 'run /bridges/teams/connect');
    try {
      await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(this.cfg.encryptionKey, sealed) });
    } catch (e) {
      if (e instanceof GraphError && e.code === 'invalid_grant') log.error('teams_reconnect_required', { error: e.message });
      throw e;
    }
    return this.access!.token;
  }

  private async graphJson(method: string, path: string) {
    const res = await this.fetchImpl(`${GRAPH}${path}`, { method, headers: { authorization: `Bearer ${this.access!.token}` } });
    const j: any = await res.json();
    if (!res.ok) throw new GraphError(res.status, j.error?.code, j.error?.message ?? '');
    return j;
  }
}

/** Minimal Graph REST client acting as the Kita user. */
export class Graph {
  auth: { accessToken(): Promise<string> };
  private fetchImpl: typeof fetch;

  constructor(auth: { accessToken(): Promise<string> }, fetchImpl: typeof fetch = fetch) {
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = path.startsWith('https://') ? path : `${GRAPH}/${path.replace(/^\//, '')}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await this.auth.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined;
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GraphError(res.status, j.error?.code, j.error?.message ?? res.statusText);
    return j;
  }

  /** GET that follows @odata.nextLink. */
  async list(path: string): Promise<any[]> {
    const out: any[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: any = await this.request('GET', next);
      out.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return out;
  }
}
