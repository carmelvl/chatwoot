import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyChatwootSignature } from './chatwoot.ts';
import type { Bridge } from './bridge.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { parseSlackEvent, verifySlackSignature, type SlackSender } from './platforms/slack.ts';
import { validationToken } from './platforms/teams/messages.ts';
import type { TeamsIntegration } from './platforms/teams/index.ts';
import type { AgentConnect } from './connect.ts';
import { parseViberEvent, verifyViberSignature } from './platforms/viber.ts';
import type { Store } from './store.ts';
import type { Platform } from './types.ts';

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
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, platforms: d.enabled, teamsConnected: d.teams?.auth.isConnected() ?? false });

      if (d.connect && req.method === 'GET' && path === '/connect') {
        const p = d.connect.page(url.searchParams);
        return html(res, p.status, p.html);
      }
      const start = path.match(/^\/connect\/(slack|teams)\/start$/);
      if (d.connect && req.method === 'GET' && start) {
        const target = d.connect.start(start[1] as 'slack' | 'teams', url.searchParams);
        if (!target) return html(res, 403, d.connect.layout('<p>This link is invalid or has expired.</p>'));
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
        if (parsed.kind === 'message') {
          const m = parsed.message;
          background('slack_inbound', (async () => bridge.inbound({ ...m, userName: (await d.slack?.userName(m.userKey)) ?? m.userKey }))());
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

      const cw = path.match(/^\/chatwoot\/(slack|teams|viber)$/);
      if (cw && d.enabled.includes(cw[1] as Platform)) {
        const platform = cw[1] as Platform;
        if (!verifyChatwootSignature(cfg.inboxes[platform].webhookSecret, raw, { signature: h(req, 'x-chatwoot-signature'), timestamp: h(req, 'x-chatwoot-timestamp') }))
          return send(res, 401);
        // Synchronous on purpose: a non-2xx makes Chatwoot mark the agent's message as failed in the UI.
        const result = await bridge.outbound(platform, JSON.parse(raw));
        return send(res, 200, { ok: true, result });
      }

      return send(res, 404);
    } catch (e: any) {
      log.error('request_failed', { path, error: String(e?.message ?? e) });
      if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500);
    }
  };
}
