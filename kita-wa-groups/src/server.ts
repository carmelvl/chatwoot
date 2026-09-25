import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as baileys from 'baileys';
import QRCode from 'qrcode';
import { createHandler } from './app.ts';
import { assertConfig, loadConfig } from './config.ts';
import { log } from './log.ts';
import { bridgeForwarder, Mirror } from './mirror.ts';
import { Store } from './store.ts';
import { WaClient, type BaileysLib } from './wa.ts';

const cfg = loadConfig();
assertConfig(cfg);
mkdirSync(cfg.dataDir, { recursive: true });
const store = new Store(join(cfg.dataDir, 'wa-groups.sqlite'));

const b: any = baileys;
const lib: BaileysLib = {
  makeWASocket: b.default ?? b.makeWASocket,
  downloadMediaMessage: b.downloadMediaMessage,
  initAuthCreds: b.initAuthCreds,
  appStateSyncKey: (v) => b.proto.Message.AppStateSyncKeyData.fromObject(v),
  // macOS('Desktop') is refused at the handshake by rc14; Chrome pairs and still receives history sync
  browser: b.Browsers.macOS('Chrome'),
  fetchLatestVersion: async () => (await b.fetchLatestBaileysVersion()).version,
};

let wa: WaClient;
const mirror = new Mirror({
  store,
  context: () => ({ selfNumber: wa.number, kitaNumbers: cfg.kitaNumbers, subject: (jid) => wa.subject(jid) }),
  download: (msg) => wa.download(msg),
  forward: bridgeForwarder(cfg.bridgesUrl, cfg.linkSecret),
  mediaDir: join(cfg.dataDir, 'media'),
  mediaBaseUrl: `${cfg.internalUrl}/wa-groups`,
  secret: cfg.linkSecret,
  mediaMaxBytes: cfg.mediaMaxBytes,
});
wa = new WaClient({ cfg, store, lib, mirror });

const server = createServer(createHandler({ cfg, wa, mirror, qrSvg: (qr) => QRCode.toString(qr, { type: 'svg', margin: 1 }) }));
server.listen(cfg.port, () => log.info('listening', { port: cfg.port, send: cfg.send, kita_numbers: cfg.kitaNumbers.size }));
void wa.start().catch((e) => {
  log.error('start_failed', { error: String(e?.message ?? e) });
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => {
    wa.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
