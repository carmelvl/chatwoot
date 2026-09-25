import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyChatwootSignature } from './chatwoot.ts';
import type { Bridge } from './bridge.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { parseSlackEvent, verifySlackSignature, type SlackSender } from './platforms/slack.ts';
import { validationToken } from './platforms/teams/messages.ts';
import type { TeamsIntegration } from './platforms/teams/index.ts';
import type { AgentConnect } from './connect.ts';
import type { ChatwootAppClient } from './chatwoot.ts';
import { parseWhatsAppWebhook, resolveMedia, verifyWhatsAppSignature, verifyWhatsAppSubscription } from './platforms/whatsapp.ts';
import { parseViberEvent, verifyViberSignature } from './platforms/viber.ts';
import type { Store } from './store.ts';
import type { Platform } from './types.ts';
import { safeEqual } from './crypto.ts';
import { GripError, type GripLinks } from './griplinks.ts';

const MAX_BODY = 5 * 1024 * 1024;

export interface AppDeps {
  cfg: Config;
  store: Store;
  fetchImpl?: typeof fetch;
  bridge: Bridge;
  enabled: Platform[];
  slack?: SlackSender;
  teams?: TeamsIntegration;
  connect?: AgentConnect;
  /** Per business number: that owner's own Chatwoot client (native attribution of phone-app echoes). */
  whatsappOwnerApps?: Map<string, ChatwootAppClient>;
  /** Desk-driven channel linking through Grip (internal endpoints). */
  gripLinks?: GripLinks;
  /** Refresh Grip scope now and merge newly linked channels (POST /internal/link-refresh). */
  linkRefresh?: () => Promise<unknown>;
  /**
   * Slack member_joined_channel: `self` is true/false when the payload's authorizations tell whether the
   * joining user is our bot, undefined otherwise. The handler backfills the channel's history when it is.
   */
  onSlackJoin?: (channel: string, user: string, self?: boolean) => Promise<unknown>;
}

/**
 * Desk-only endpoints (X-Kita-Bridge-Secret = BRIDGE_LINK_SECRET):
 *   POST /internal/link-refresh                      refresh Grip scope + merge linked channels now
 *   GET  /internal/grip/accounts?search=             Grip accounts for the "Link to customer" picker
 *   POST /internal/grip/link {channel_key, account_id} link the channel in Grip, then refresh
 */
async function internal(d: AppDeps, req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  if (!d.cfg.linkSecret || !safeEqual(h(req, 'x-kita-bridge-secret') ?? '', d.cfg.linkSecret)) return send(res, 401);
  try {
    if (req.method === 'POST' && path === '/internal/link-refresh') {
      if (!d.linkRefresh) return send(res, 404);
      await d.linkRefresh();
      return send(res, 200);
    }
    if (!d.gripLinks?.enabled) return send(res, 404, { error: 'grip_not_configured' });
    if (req.method === 'GET' && path === '/internal/grip/accounts')
      return send(res, 200, { accounts: await d.gripLinks.accounts(url.searchParams.get('search') ?? '') });
    if (req.method === 'POST' && path === '/internal/grip/link') {
      const { channel_key: channelKey, account_id: accountId } = JSON.parse(await readBody(req));
      if (typeof channelKey !== 'string' || typeof accountId !== 'string' || !channelKey || !accountId) return send(res, 422);
      return send(res, 200, await d.gripLinks.link(channelKey, accountId));
    }
    return send(res, 404);
  } catch (e: any) {
    if (e instanceof GripError) return send(res, e.status === 404 ? 404 : 502, { error: e.message });
    throw e;
  }
}

export { MIRROR_NOTE } from './bridge.ts';

/** Cloud API webhook batch -> customer messages (incoming) and phone-app echoes (outgoing, owner). */
async function processWhatsApp(d: AppDeps, body: unknown) {
  const w = d.cfg.whatsapp;
  const { items, skipped } = parseWhatsAppWebhook(body, w.numbers);
  if (skipped.length) log.info('whatsapp_skipped', { skipped });
  for (const it of items) {
    if (d.bridge.outOfScope(it.message)) continue; // before any media download or Chatwoot call
    try {
      const attachments = await resolveMedia(it.media, w.accessToken, d.fetchImpl);
      if (attachments.length < it.media.length) log.warn('whatsapp_media_unresolved', { missing: it.media.length - attachments.length });
      const msg = { ...it.message, attachments };
      if (it.kind === 'customer') await d.bridge.inbound(msg);
      else await d.bridge.businessEcho(msg, { ownerName: it.number.ownerName, ownerEmail: it.number.agentEmail, ownerKey: `whatsapp:${it.number.phoneNumberId}`, ownerApp: d.whatsappOwnerApps?.get(it.number.phoneNumberId) });
    } catch (e: any) {
      log.error('whatsapp_item_failed', { kind: it.kind, error: String(e?.message ?? e) });
    }
  }
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body_too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown = { ok: status < 400 }) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(s);
}

const h = (req: IncomingMessage, k: string) => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};

/** Run work after acking; platform retries + idempotency keys cover failures. */
const background = (what: string, p: Promise<unknown>) => p.catch((e) => log.error(`${what}_failed`, { error: String(e?.message ?? e) }));

/**
 * Streams an agent attachment to Viber/Teams/customers under the bridge's own URL, so no Chatwoot
 * URL or branding is ever exposed. Tokens are 192-bit random and only minted for verified webhooks.
 */
async function serveMedia(d: AppDeps, token: string, method: string, res: ServerResponse) {
  const m = d.store.getMedia(token, d.cfg.mediaTtlMs);
  if (!m) return send(res, 404);
  const up = await (d.fetchImpl ?? fetch)(m.sourceUrl, { method, redirect: 'follow' });
  if (!up.ok) return send(res, 502);
  const headers: Record<string, string> = {
    'content-type': up.headers.get('content-type') ?? 'application/octet-stream',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(m.name)}`,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  };
  const len = up.headers.get('content-length');
  if (len) headers['content-length'] = len;
  res.writeHead(200, headers);
  if (method === 'HEAD' || !up.body) return res.end();
  res.end(Buffer.from(await up.arrayBuffer()));
}

export function createHandler(d: AppDeps) {
  const { cfg, bridge } = d;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    // Tolerate being mounted with or without the /bridges prefix.
    const path = url.pathname.replace(/^\/bridges(?=\/)/, '');
    try {
      if (d.enabled.includes('whatsapp') && req.method === 'GET' && path === '/whatsapp/webhook') {
        const challenge = verifyWhatsAppSubscription(cfg.whatsapp.verifyToken, url.searchParams);
        return challenge === undefined ? send(res, 403) : send(res, 200, challenge);
      }
      if (path.startsWith('/internal/')) return await internal(d, req, res, path, url);
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, platforms: d.enabled, teamsConnected: d.teams?.auth.isConnected() ?? false });

      if (d.connect && req.method === 'GET' && path === '/connect/status') {
        const r = d.connect.statusRequest(url.searchParams, h(req, 'x-kita-bridge-secret'));
        return send(res, r.status, r.body);
      }
      if (d.connect && req.method === 'GET' && path === '/connect') {
        const p = d.connect.page(url.searchParams);
        return html(res, p.status, p.html);
      }
      const start = path.match(/^\/connect\/(slack|teams)\/start$/);
      if (d.connect && req.method === 'GET' && start) {
        const target = d.connect.start(start[1] as 'slack' | 'teams', url.searchParams);
        if (!target) return html(res, 403, d.connect.invalidLink());
        res.writeHead(302, { location: target });
        return res.end();
      }
      if (d.connect && req.method === 'GET' && path === '/connect/slack/callback') {
        try {
          const email = await d.connect.slackCallback(url.searchParams.get('code'), url.searchParams.get('state'));
          return html(res, 200, d.connect.layout(`<p>Slack connected for ${email.replace(/[<>&"]/g, '')}. Replies you write in the desk will now post as you. You can close this tab.</p>`));
        } catch (e: any) {
          log.warn('slack_connect_failed', { error: String(e?.message ?? e) });
          return html(res, 400, d.connect.layout(`<p>Connect failed: ${String(e?.message ?? e).replace(/[<>&"]/g, '')}</p>`));
        }
      }

      if (d.teams && req.method === 'GET' && path === '/teams/connect') {
        const target = d.teams.connectUrl(url.searchParams.get('key'));
        if (!target) return send(res, 403);
        res.writeHead(302, { location: target });
        return res.end();
      }
      if (d.teams && req.method === 'GET' && path === '/teams/connect/callback') {
        if (url.searchParams.get('error')) return send(res, 400, `Microsoft sign-in failed: ${url.searchParams.get('error')}`);
        try {
          const upn = await d.teams.connectCallback(url.searchParams.get('code'), url.searchParams.get('state'));
          return send(res, 200, `Connected as ${upn}. Teams subscriptions are syncing; you can close this tab.`);
        } catch (e: any) {
          log.warn('teams_connect_failed', { error: String(e?.message ?? e) });
          return send(res, 400, `Connect failed: ${e?.message ?? e}`);
        }
      }
      const media = path.match(/^\/media\/([A-Za-z0-9_-]{32})\/[^/]+$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && media) return serveMedia(d, media[1], req.method, res);
      if (req.method !== 'POST') return send(res, 404);
      const raw = await readBody(req);

      if (path === '/slack/events' && d.enabled.includes('slack')) {
        if (!verifySlackSignature(cfg.slack.signingSecret, raw, { signature: h(req, 'x-slack-signature'), timestamp: h(req, 'x-slack-request-timestamp') }))
          return send(res, 401);
        const parsed = parseSlackEvent(JSON.parse(raw), { botToken: cfg.slack.botToken, internalTeamIds: cfg.slack.internalTeamIds, allowedChannels: cfg.slack.allowedChannels });
        if (parsed.kind === 'challenge') return send(res, 200, { challenge: parsed.challenge });
        send(res, 200); // Slack requires an ack within 3s
        // Reason only, never content: an ignored event is never silent
        if (parsed.kind === 'ignore') log.info('slack_event_ignored', { reason: parsed.reason });
        if (parsed.kind === 'joined' && d.onSlackJoin) background('slack_join', d.onSlackJoin(parsed.channel, parsed.user, parsed.self));
        if (parsed.kind === 'message') {
          const m = parsed.message;
          if (bridge.outOfScope(m)) return; // before the Slack user lookup or any Chatwoot call (logged there)
          background('slack_inbound', (async () => {
            const channelLabel = await d.slack?.channelName(String(m.replyRef.channel ?? ''));
            const attrs = channelLabel ? { ...m.conversationAttributes, channel_label: channelLabel } : m.conversationAttributes;
            const p = (await d.slack?.userProfile(m.userKey)) ?? {};
            return bridge.inbound({ ...m, conversationAttributes: attrs, userName: p.name ?? m.userKey, userEmail: p.email, userAvatarUrl: p.avatarUrl });
          })());
        }
        return;
      }

      if (d.teams && (path === '/teams/notifications' || path === '/teams/lifecycle')) {
        // Subscription handshake: echo the token as text/plain (must happen within 10 seconds).
        const token = validationToken(url);
        if (token !== undefined) return send(res, 200, token);
        const body = JSON.parse(raw);
        send(res, 202); // ack fast; clientState is checked per item before anything is fetched
        const teams = d.teams;
        if (path === '/teams/notifications') background('teams_notifications', teams.notifications(body, (m) => bridge.inbound(m)));
        else background('teams_lifecycle', teams.lifecycle(body));
        return;
      }

      if (path === '/viber/webhook' && d.enabled.includes('viber')) {
        if (!verifyViberSignature(cfg.viber.authToken, raw, h(req, 'x-viber-content-signature'))) return send(res, 401);
        const parsed = parseViberEvent(JSON.parse(raw), raw);
        send(res, 200);
        if (parsed.kind === 'message') background('viber_inbound', bridge.inbound(parsed.message));
        return;
      }

      if (path === '/whatsapp/webhook' && d.enabled.includes('whatsapp')) {
        if (!verifyWhatsAppSignature(cfg.whatsapp.appSecret, raw, h(req, 'x-hub-signature-256'))) return send(res, 401);
        const body = JSON.parse(raw);
        send(res, 200); // Meta retries non-2xx; items are idempotent on wamid
        background('whatsapp_webhook', processWhatsApp(d, body));
        return;
      }

      // The one Customers inbox: every platform's agent replies (targeted per message; mirrors get a note).
      if (path === '/chatwoot/customers' && cfg.customers.webhookSecret) {
        if (!verifyChatwootSignature(cfg.customers.webhookSecret, raw, { signature: h(req, 'x-chatwoot-signature'), timestamp: h(req, 'x-chatwoot-timestamp') }))
          return send(res, 401);
        // Synchronous on purpose: a non-2xx makes Chatwoot mark the agent's message as failed in the UI.
        const result = await bridge.outbound(JSON.parse(raw));
        // Refused (agent not connected / not a member): nothing was posted; 422 marks the message failed.
        return send(res, result.startsWith('refused:') ? 422 : 200, { ok: !result.startsWith('refused:'), result });
      }

      return send(res, 404);
    } catch (e: any) {
      log.error('request_failed', { path, error: String(e?.message ?? e) });
      if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500);
    }
  };
}
