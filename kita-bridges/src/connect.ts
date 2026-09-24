import { randomBytes } from 'node:crypto';
import { signedQuery, verifyConnectParams } from './links.ts';
import type { SlackUserOAuth } from './platforms/slack.ts';
import type { TeamsIntegration } from './platforms/teams/index.ts';

const STATE_TTL_MS = 10 * 60 * 1000;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * /bridges/connect: a tiny page where an agent links their own Slack / Microsoft 365 account so
 * replies they write in the desk post as them. Access is by a per-agent signed link (links.ts).
 */
export class AgentConnect {
  private o: { linkSecret: string; teams?: TeamsIntegration; slack?: SlackUserOAuth };
  private slackStates = new Map<string, { exp: number; agentId: number; email: string }>();

  constructor(o: { linkSecret: string; teams?: TeamsIntegration; slack?: SlackUserOAuth }) {
    this.o = o;
  }

  page(params: URLSearchParams): { status: number; html: string } {
    const who = verifyConnectParams(this.o.linkSecret, params);
    if (!who) return { status: 403, html: this.layout('<p>This link is invalid or has expired. Ask an admin for a new one.</p>') };
    const q = signedQuery(params);
    const row = (label: string, connected: boolean, href: string) =>
      `<p><a class="btn" href="${href}">${connected ? `Reconnect ${label}` : `Connect your ${label} account`}</a> ${connected ? '<span>Connected</span>' : ''}</p>`;
    const rows = [
      this.o.slack ? row('Slack', Boolean(this.o.slack.userToken(who.agentId)), `connect/slack/start?${q}`) : '',
      this.o.teams ? row('Microsoft Teams', this.o.teams.agentAuth(who.agentId).isConnected(), `connect/teams/start?${q}`) : '',
    ].join('');
    return {
      status: 200,
      html: this.layout(`<p>Signed in as <b>${esc(who.email)}</b>. Connect your accounts so replies you write in the desk are posted as you. Sign in with this same email.</p>${rows || '<p>No channels are configured.</p>'}`),
    };
  }

  /** Verifies the signed link, then returns the provider's authorize URL. */
  start(platform: 'slack' | 'teams', params: URLSearchParams): string | undefined {
    const who = verifyConnectParams(this.o.linkSecret, params);
    if (!who) return undefined;
    if (platform === 'teams') return this.o.teams?.agentConnectUrl(who.agentId, who.email);
    if (!this.o.slack) return undefined;
    const state = randomBytes(24).toString('base64url');
    this.slackStates.set(state, { exp: Date.now() + STATE_TTL_MS, ...who });
    return this.o.slack.authorizeUrl(state);
  }

  async slackCallback(code: string | null, state: string | null): Promise<string> {
    const st = state ? this.slackStates.get(state) : undefined;
    if (state) this.slackStates.delete(state);
    if (!code || !st || st.exp < Date.now() || !this.o.slack) throw new Error('invalid or expired state');
    return this.o.slack.complete(code, st.agentId, st.email);
  }

  layout(body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kita · Connect your accounts</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}.btn{display:inline-block;padding:.6rem 1rem;border:1px solid #111;border-radius:.4rem;color:#111;text-decoration:none}span{color:#286644;margin-left:.5rem}</style>
</head><body><h1>Connect your accounts</h1>${body}</body></html>`;
  }
}
