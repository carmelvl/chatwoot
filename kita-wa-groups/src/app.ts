import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { safeEqual, verifyPairLink } from './crypto.ts';
import { log } from './log.ts';
import type { Mirror } from './mirror.ts';
import { JoinError, type Status } from './wa.ts';
import type { GroupRow } from './store.ts';

/** What the HTTP layer needs from WaClient (a fake in tests). */
export interface WaApi {
  status: Status;
  qr?: string;
  number?: string;
  groups(): GroupRow[];
  join(link: unknown): Promise<{ jid: string; subject: string; already?: boolean }>;
  send(groupJid: string, text: string): Promise<string>;
  logout(): Promise<void>;
}

export interface AppDeps {
  cfg: Config;
  wa: WaApi;
  mirror: Pick<Mirror, 'media'>;
  /** QR string -> SVG markup (the `qrcode` package). */
  qrSvg: (qr: string) => Promise<string>;
}

const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown = { ok: status < 400 }) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new SyntaxError('body_too_large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const header = (req: IncomingMessage, k: string) => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};

const page = (body: string, refresh: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Kita WhatsApp groups</title>
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<style>body{font:15px system-ui,sans-serif;max-width:32rem;margin:3rem auto;color:#111;text-align:center}svg{width:18rem;height:18rem}p{color:#555}</style>
</head><body><h1>Kita WhatsApp groups</h1>${body}</body></html>`;

export function pairPage(wa: Pick<WaApi, 'status' | 'number' | 'qr'>, svg?: string): { html: string; refresh: boolean } {
  if (wa.status === 'connected') return { html: `<p><strong>Connected as +${wa.number ?? ''}</strong></p><p>You can close this tab.</p>`, refresh: false };
  if (wa.status === 'pairing' && svg)
    return {
      html: `${svg}<p>On the dedicated Kita WhatsApp phone: Settings → Linked devices → Link a device, then scan this code.</p><p>Never use a personal or main business number.</p>`,
      refresh: true,
    };
  return { html: '<p>Connecting to WhatsApp…</p>', refresh: true };
}

/**
 * Routes (the /wa-groups prefix is optional):
 *   GET  /healthz                      {connected, number, groups}
 *   GET  /pair?x=&s=                   QR page (signed admin link, or X-Kita-Bridge-Secret)
 *   GET  /status                       status + groups (secret)
 *   GET  /groups                       joined groups (secret)
 *   POST /join {invite_link}           join a group (secret, rate limited)
 *   POST /logout                       unlink the device (secret)
 *   GET  /internal/media/<token>       attachment bytes for kita-bridges (secret)
 *   POST /internal/send {group_jid,text}  desk reply into the group (secret, WA_GROUPS_SEND=on only)
 */
export function createHandler(d: AppDeps) {
  const { cfg, wa } = d;
  const hasSecret = (req: IncomingMessage) => !!cfg.linkSecret && safeEqual(header(req, 'x-kita-bridge-secret') ?? '', cfg.linkSecret);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://wa-groups');
    const path = url.pathname.replace(/^\/wa-groups(?=\/)/, '');
    try {
      if (req.method === 'GET' && path === '/healthz')
        return send(res, 200, { ok: true, connected: wa.status === 'connected', status: wa.status, number: wa.number ? `+${wa.number}` : null, groups: wa.groups().length });

      if (req.method === 'GET' && path === '/pair') {
        if (!hasSecret(req) && !verifyPairLink(cfg.linkSecret, url.searchParams)) return html(res, 403, page('<p>This link is invalid or has expired. Open it again from the desk.</p>', false));
        const svg = wa.status === 'pairing' && wa.qr ? await d.qrSvg(wa.qr) : undefined;
        const p = pairPage(wa, svg);
        return html(res, 200, page(p.html, p.refresh));
      }

      if (!hasSecret(req)) return send(res, 401);

      if (req.method === 'GET' && path === '/status')
        return send(res, 200, { status: wa.status, connected: wa.status === 'connected', number: wa.number ? `+${wa.number}` : null, send_enabled: cfg.send, groups: wa.groups() });
      if (req.method === 'GET' && path === '/groups') return send(res, 200, { groups: wa.groups() });
      if (req.method === 'POST' && path === '/join') {
        const body = await readJson(req);
        return send(res, 200, await wa.join(body?.invite_link));
      }
      if (req.method === 'POST' && path === '/logout') {
        await wa.logout();
        return send(res, 200);
      }
      const media = path.match(/^\/internal\/media\/([A-Za-z0-9_-]{32})$/);
      if (req.method === 'GET' && media) {
        const buf = await d.mirror.media(media[1]);
        if (!buf) return send(res, 404);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
        return res.end(buf);
      }
      if (req.method === 'POST' && path === '/internal/send') {
        const { group_jid: jid, text } = await readJson(req);
        if (typeof jid !== 'string' || typeof text !== 'string' || !text.trim()) return send(res, 422);
        return send(res, 200, { event_id: await wa.send(jid, text) });
      }
      return send(res, 404);
    } catch (e: any) {
      if (e instanceof JoinError) return send(res, e.status, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400);
      log.error('request_failed', { path, error: String(e?.message ?? e) });
      if (!res.headersSent) send(res, 500);
    }
  };
}
