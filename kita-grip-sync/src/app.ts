import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyChatwootSignature } from './chatwoot.ts';
import { log } from './log.ts';
import type { Sync } from './sync.ts';

const MAX_BODY = 2 * 1024 * 1024;

export interface AppDeps {
  webhookSecret: string;
  sync: Sync;
  /** Kick the job runner after an ingest so work starts immediately instead of on the next tick. */
  kick?: () => void;
  health?: () => Record<string, unknown>;
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
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const h = (req: IncomingMessage, k: string) => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};

export function createHandler(d: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://grip-sync');
    // Tolerate being mounted with or without the /grip-sync prefix.
    const path = url.pathname.replace(/^\/grip-sync(?=\/)/, '');
    try {
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, ...(d.health?.() ?? {}) });
      if (req.method !== 'POST' || path !== '/chatwoot/webhook') return send(res, 404);
      const raw = await readBody(req);
      if (!verifyChatwootSignature(d.webhookSecret, raw, { signature: h(req, 'x-chatwoot-signature'), timestamp: h(req, 'x-chatwoot-timestamp') })) {
        log.warn('signature_rejected');
        return send(res, 401);
      }
      const payload = JSON.parse(raw);
      const result = d.sync.ingest(payload, h(req, 'x-chatwoot-delivery'));
      send(res, 200, { ok: true, result });
      if (result === 'ok') d.kick?.();
    } catch (e: any) {
      log.error('request_failed', { path, error: String(e?.message ?? e) });
      if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500);
    }
  };
}
