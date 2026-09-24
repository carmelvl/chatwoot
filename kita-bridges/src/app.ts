import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyChatwootSignature } from './chatwoot.ts';
import type { Bridge } from './bridge.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { parseSlackEvent, verifySlackSignature, type SlackSender } from './platforms/slack.ts';
import { authorizeTeamsAttachments, parseTeamsActivity, verifyTeamsJwt, type JwksProvider, type TeamsSender } from './platforms/teams.ts';
import { parseViberEvent, verifyViberSignature } from './platforms/viber.ts';
import type { Platform } from './types.ts';

const MAX_BODY = 5 * 1024 * 1024;

export interface AppDeps {
  cfg: Config;
  bridge: Bridge;
  enabled: Platform[];
  slack?: SlackSender;
  teams?: TeamsSender;
  jwks: JwksProvider;
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

export function createHandler(d: AppDeps) {
  const { cfg, bridge } = d;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    // Tolerate being mounted with or without the /bridges prefix.
    const path = url.pathname.replace(/^\/bridges(?=\/)/, '');
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, platforms: d.enabled });
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

      if (path === '/teams/messages' && d.enabled.includes('teams')) {
        const activity = JSON.parse(raw);
        const v = await verifyTeamsJwt(h(req, 'authorization'), { appId: cfg.teams.appId, serviceUrl: activity.serviceUrl, jwks: d.jwks });
        if (!v.ok) {
          log.warn('teams_auth_rejected', { reason: v.reason });
          return send(res, 401);
        }
        const parsed = parseTeamsActivity(activity);
        send(res, 200);
        if (parsed.kind === 'message') {
          background('teams_inbound', (async () => {
            const withAuth = parsed.message.attachments.length && d.teams ? authorizeTeamsAttachments(parsed.message, await d.teams.accessToken()) : parsed.message;
            return bridge.inbound(withAuth);
          })());
        }
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
