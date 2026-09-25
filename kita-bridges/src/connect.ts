import { randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.ts';
import { normalizeEmail } from './email.ts';
import { signedQuery, verifyConnectParams } from './links.ts';
import type { SlackUserOAuth } from './platforms/slack.ts';
import type { TeamsIntegration } from './platforms/teams/index.ts';
import type { WhatsAppNumber } from './platforms/whatsapp.ts';

const STATE_TTL_MS = 10 * 60 * 1000;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ConnectStatus {
  slack: 'connected' | 'not_connected' | 'unavailable';
  teams: 'connected' | 'not_connected' | 'unavailable';
  /** The agent's mirrored WhatsApp Business number, or 'none'. */
  whatsapp: string;
  viber: 'not_applicable';
}

export interface AgentConnectOptions {
  linkSecret: string;
  teams?: TeamsIntegration;
  slack?: SlackUserOAuth;
  whatsappNumbers?: WhatsAppNumber[];
  /** The desk (Chatwoot) base URL, linked from the "open this from the desk" page. */
  deskUrl?: string;
}

/**
 * /bridges/connect: the page where an agent links their own Slack / Microsoft 365 account so
 * replies they write in the desk post as them, and sees how WhatsApp and Viber work for them.
 * Access is by a per-agent signed link (links.ts), minted by the desk's Profile → Connect accounts.
 * /connect/status is the same information as JSON for the desk (server-to-server, shared secret).
 */
export class AgentConnect {
  private o: AgentConnectOptions;
  private slackStates = new Map<string, { exp: number; agentId: number; email: string }>();

  constructor(o: AgentConnectOptions) {
    this.o = o;
  }

  status(agentId: number, email: string): ConnectStatus {
    const { slack, teams } = this.o;
    const number = this.o.whatsappNumbers?.find((n) => n.agentEmail && normalizeEmail(n.agentEmail) === normalizeEmail(email));
    return {
      slack: slack ? (slack.userToken(agentId) ? 'connected' : 'not_connected') : 'unavailable',
      teams: teams ? (teams.agentAuth(agentId).isConnected() ? 'connected' : 'not_connected') : 'unavailable',
      whatsapp: number ? number.displayPhoneNumber || number.phoneNumberId : 'none',
      viber: 'not_applicable',
    };
  }

  /** GET /connect/status: the desk calls it with X-Kita-Bridge-Secret (?a=<id>&e=<email>), or a signed link's params. */
  statusRequest(params: URLSearchParams, secretHeader: string | undefined): { status: number; body: ConnectStatus | { error: string } } {
    let who = verifyConnectParams(this.o.linkSecret, params);
    if (!who && secretHeader && safeEqual(secretHeader, this.o.linkSecret)) {
      const agentId = Number(params.get('a'));
      const email = (params.get('e') ?? '').toLowerCase();
      if (!agentId || !email) return { status: 400, body: { error: 'a and e are required' } };
      who = { agentId, email };
    }
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    return { status: 200, body: this.status(who.agentId, who.email) };
  }

  page(params: URLSearchParams): { status: number; html: string } {
    const who = verifyConnectParams(this.o.linkSecret, params);
    if (!who) return { status: 403, html: this.invalidLink() };
    const q = signedQuery(params);
    const s = this.status(who.agentId, who.email);
    const oauthCard = (name: string, logo: string, state: ConnectStatus['slack'], href: string) =>
      card(
        name,
        logo,
        state === 'connected' ? badge('Connected', 'ok') : state === 'not_connected' ? badge('Not connected', 'todo') : badge('Not available yet', 'muted'),
        state === 'unavailable'
          ? `<p>Kita hasn't turned on ${name} yet. Your replies there will come from you once it's set up.</p>`
          : `<p>Required to reply in ${name}: replies you write in the desk are posted as you, and nothing is sent until you connect. Sign in with <b>${esc(who.email)}</b>.</p><a class="btn${state === 'connected' ? ' ghost' : ''}" href="${href}">${state === 'connected' ? 'Reconnect' : `Connect ${name}`}</a>`,
      );
    const cards = [
      oauthCard('Slack', LOGOS.slack, s.slack, `connect/slack/start?${q}`),
      oauthCard('Microsoft Teams', LOGOS.teams, s.teams, `connect/teams/start?${q}`),
      card(
        'WhatsApp',
        LOGOS.whatsapp,
        s.whatsapp === 'none' ? badge('Not linked', 'muted') : badge('Linked', 'ok'),
        `<p>Your WhatsApp Business number is linked by an admin (QR scan). Reply in WhatsApp yourself, from the WhatsApp Business app on your phone: the desk shows the whole conversation but never sends on WhatsApp.</p>${
          s.whatsapp === 'none' ? '<p class="note">No number is linked to you yet. Ask an admin to scan your QR code.</p>' : `<p class="note">Linked number: <b>${esc(s.whatsapp)}</b></p>`
        }`,
      ),
      card(
        'Viber',
        LOGOS.viber,
        badge('No setup needed', 'muted'),
        "<p>Customers' messages to the Kita Viber bot show up in the desk, so you're notified there. Reply in Viber yourself: the desk never sends on Viber.</p><p class=\"note\">Viber only lets Kita see conversations with the Kita Viber bot, not your personal Viber chats.</p>",
      ),
    ].join('');
    return {
      status: 200,
      html: this.layout(`<p class="lead">Signed in as <b>${esc(who.email)}</b>. Connect your accounts so customers see replies from you, not a shared bot.</p>${cards}`),
    };
  }

  /** Friendly page for an expired, forged or hand-typed link. */
  invalidLink(): string {
    const desk = this.o.deskUrl ? `<a class="btn" href="${esc(this.o.deskUrl)}/app">Open the desk</a>` : '';
    return this.layout(
      `<div class="card"><h2>This link has expired</h2><p>Connect links are personal and last 7 days. Open this from the desk: <b>Profile → Connect accounts</b>.</p>${desk}</div>`,
    );
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
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kita · Connect your accounts</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f6f7f6;color:#111;font:15px/1.5 Geist,Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}
header{display:flex;align-items:center;gap:.6rem;margin-bottom:1.5rem}
.mark{width:28px;height:28px;border-radius:7px;background:#286644;color:#fff;display:grid;place-items:center;font-weight:700}
h1{font-size:1.4rem;margin:0}
h2{font-size:1.05rem;margin:0}
.lead{color:#444;margin:0 0 1.25rem}
.card{background:#fff;border:1px solid #e3e6e3;border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:.9rem}
.card-head{display:flex;align-items:center;gap:.6rem;margin-bottom:.4rem}
.card-head svg{width:22px;height:22px;flex:none}
.card p{margin:.35rem 0;color:#333}
.note{font-size:.9rem;color:#555}
.badge{margin-left:auto;font-size:.78rem;font-weight:600;padding:.15rem .55rem;border-radius:999px;white-space:nowrap}
.badge.ok{background:#e4f1ea;color:#286644}.badge.todo{background:#fdf1dc;color:#8a5a00}.badge.muted{background:#eef0ee;color:#555}
.btn{display:inline-block;margin-top:.6rem;padding:.55rem 1rem;border-radius:8px;background:#286644;color:#fff;text-decoration:none;font-weight:600}
.btn.ghost{background:#fff;color:#286644;border:1px solid #286644}
</style>
</head><body><main><header><div class="mark">K</div><h1>Connect your accounts</h1></header>${body}</main></body></html>`;
  }
}

const badge = (text: string, kind: 'ok' | 'todo' | 'muted') => `<span class="badge ${kind}">${text}</span>`;
const card = (name: string, logo: string, status: string, body: string) =>
  `<section class="card"><div class="card-head">${logo}<h2>${name}</h2>${status}</div>${body}</section>`;

/** Simplified platform marks in their brand colours. */
const LOGOS = {
  slack:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#E01E5A" d="M5 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z"/><path fill="#36C5F0" d="M9 5a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z"/><path fill="#2EB67D" d="M19 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z"/><path fill="#ECB22E" d="M15 19a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z"/></svg>',
  teams:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="14" height="14" rx="3" fill="#5059C9"/><path fill="#fff" d="M5.5 9h7v1.6H9.8V16H8.2v-5.4H5.5z"/><circle cx="19" cy="7" r="2.2" fill="#7B83EB"/><path fill="#7B83EB" d="M17 10h4a1 1 0 0 1 1 1v4a3 3 0 0 1-5 2.2V10Z"/></svg>',
  whatsapp:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25D366" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Z"/><path fill="#fff" d="M8.6 7.2c.2-.4.4-.4.7-.4h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.1-.2.3 0 .6.2.3.9 1.4 1.9 2.2 1.3 1.1 2.3 1.4 2.6 1.6.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.7-.1l1.8.9c.3.1.5.2.5.3.1.2.1.8-.2 1.5-.3.7-1.6 1.4-2.2 1.4-.6.1-1.2.3-4-.8-3.3-1.3-5.4-4.7-5.6-4.9-.2-.2-1.3-1.8-1.3-3.4 0-1.6.8-2.4 1.1-2.7Z"/></svg>',
  viber:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#7360F2" d="M12 2c5.5 0 9 2.6 9 8.2 0 5.6-3.5 8.2-9 8.2l-.9-.1L7 21v-3.4C4.2 16.4 3 14 3 10.2 3 4.6 6.5 2 12 2Z"/><path fill="#fff" d="M9.2 6.8c.3 0 .5.1.6.4l.8 1.5c.1.3.1.5-.1.7l-.5.5c.4 1 1.2 1.9 2.2 2.4l.5-.5c.2-.2.5-.3.7-.1l1.5.8c.3.2.4.4.4.7-.1.9-.9 1.5-1.8 1.4-2.8-.4-5-2.6-5.4-5.4-.1-.9.5-1.7 1.4-1.8h-.3Z"/></svg>',
};
