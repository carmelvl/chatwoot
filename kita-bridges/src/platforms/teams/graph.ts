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

const REFRESH_KEY = 'teams.refresh_token';
const USER_KEY = 'teams.kita_user_id';

/** OAuth2 authorization-code flow (one time) + refresh-token rotation for the Kita user. */
export class GraphAuth {
  private cfg: GraphAuthConfig;
  private store: Store;
  private fetchImpl: typeof fetch;
  private access?: { token: string; exp: number };

  constructor(cfg: GraphAuthConfig, store: Store, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  private get tokenUrl() {
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`;
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: 'code',
      redirect_uri: this.cfg.redirectUri,
      response_mode: 'query',
      scope: TEAMS_SCOPES.join(' '),
      state,
      login_hint: this.cfg.kitaUserUpn,
      prompt: 'select_account',
    });
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/authorize?${q}`;
  }

  isConnected(): boolean {
    return Boolean(this.store.getKv(REFRESH_KEY) && this.store.getKv(USER_KEY));
  }

  kitaUserId(): string | undefined {
    return this.store.getKv(USER_KEY);
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: TEAMS_SCOPES.join(' '), ...params }),
    });
    const j: any = await res.json();
    if (!res.ok || !j.access_token) throw new GraphError(res.status, j.error, j.error_description?.split('\n')[0] ?? 'token request failed');
    this.access = { token: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    if (j.refresh_token) this.store.putKv(REFRESH_KEY, seal(this.cfg.encryptionKey, j.refresh_token));
    return j;
  }

  /** Callback of the connect flow: exchange the code, verify it is really the Kita user, persist the refresh token. */
  async completeConnect(code: string): Promise<{ userId: string; upn: string }> {
    await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri });
    const me: any = await this.graphJson('GET', '/me?$select=id,userPrincipalName');
    if (String(me.userPrincipalName).toLowerCase() !== this.cfg.kitaUserUpn.toLowerCase()) {
      this.store.deleteKv(REFRESH_KEY);
      this.access = undefined;
      throw new Error(`signed in as ${me.userPrincipalName}, expected ${this.cfg.kitaUserUpn}`);
    }
    this.store.putKv(USER_KEY, me.id);
    return { userId: me.id, upn: me.userPrincipalName };
  }

  async accessToken(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 120_000) return this.access.token;
    const sealed = this.store.getKv(REFRESH_KEY);
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
