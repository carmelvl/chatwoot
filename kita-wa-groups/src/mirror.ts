import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.ts';
import { normalize, type InboundPayload, type MediaRef, type NormalizeContext } from './normalize.ts';
import type { Store } from './store.ts';

export interface MirrorDeps {
  store: Store;
  context: () => NormalizeContext;
  /** Decrypted media bytes for a WAMessage (Baileys downloadMediaMessage). */
  download: (msg: any) => Promise<Buffer>;
  /** POST to kita-bridges /internal/inbound; throws on failure. */
  forward: (payload: InboundPayload) => Promise<unknown>;
  mediaDir: string;
  /** Base URL kita-bridges fetches media from, and the header it sends. */
  mediaBaseUrl: string;
  secret: string;
  mediaMaxBytes: number;
}

export type MirrorResult = 'skipped' | 'duplicate' | 'own_send' | 'delivered';

/**
 * WhatsApp group messages -> the desk, one at a time and in order. A message is marked delivered only
 * after kita-bridges accepted it, so a failed delivery is retried the next time WhatsApp sends it
 * (history re-sync); media lives on disk only until then.
 */
export class Mirror {
  private queue: Promise<unknown> = Promise.resolve();
  private d: MirrorDeps;

  constructor(d: MirrorDeps) {
    this.d = d;
  }

  handle(msgs: any[], opts: { backfill?: boolean } = {}): Promise<MirrorResult[]> {
    const run = this.queue.then(async () => {
      const out: MirrorResult[] = [];
      for (const m of msgs) {
        try {
          out.push(await this.one(m, opts));
        } catch (e: any) {
          log.error('mirror_failed', { error: String(e?.message ?? e) });
          out.push('skipped');
        }
      }
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async one(msg: any, opts: { backfill?: boolean }): Promise<MirrorResult> {
    const n = normalize(msg, this.d.context());
    if (!n) return 'skipped';
    const { store } = this.d;
    if (store.isSent(n.payload.event_id)) return 'own_send';
    if (store.isDelivered(n.payload.event_id)) return 'duplicate';
    const file = n.media ? await this.saveMedia(msg, n.media) : undefined;
    try {
      const payload: InboundPayload = {
        ...n.payload,
        attachments: file ? [{ url: `${this.d.mediaBaseUrl}/internal/media/${file.token}`, name: n.media!.fileName, content_type: n.media!.mimetype, headers: { 'x-kita-bridge-secret': this.d.secret } }] : [],
        ...(opts.backfill ? { backfill: true } : {}),
      };
      if (n.media && !file) payload.text = [payload.text, `[${n.media.kind} not copied]`].filter(Boolean).join('\n\n');
      await this.d.forward(payload);
      store.markDelivered(n.payload.event_id);
      return 'delivered';
    } finally {
      if (file) await rm(file.path, { force: true });
    }
  }

  private async saveMedia(msg: any, media: MediaRef) {
    try {
      const buf = await this.d.download(msg);
      if (buf.length > this.d.mediaMaxBytes) throw new Error('too_large');
      await mkdir(this.d.mediaDir, { recursive: true, mode: 0o700 });
      const token = randomBytes(24).toString('base64url');
      const path = join(this.d.mediaDir, token);
      await writeFile(path, buf, { mode: 0o600 });
      return { token, path };
    } catch (e: any) {
      log.warn('media_download_failed', { kind: media.kind, error: String(e?.message ?? e) });
      return undefined;
    }
  }

  /** Bytes for GET /internal/media/<token> (kita-bridges downloading an attachment). */
  async media(token: string): Promise<Buffer | undefined> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return undefined;
    return readFile(join(this.d.mediaDir, token)).catch(() => undefined);
  }
}

/** kita-bridges POST /internal/inbound. */
export function bridgeForwarder(bridgesUrl: string, secret: string, fetchImpl: typeof fetch = fetch) {
  return async (payload: InboundPayload) => {
    const res = await fetchImpl(`${bridgesUrl}/internal/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kita-bridge-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`bridge inbound -> ${res.status}`);
    return res.json().catch(() => ({}));
  };
}
