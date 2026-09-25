import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mirror } from '../src/mirror.ts';
import type { InboundPayload } from '../src/normalize.ts';
import { Store } from '../src/store.ts';

const G = '120363040000000001@g.us';
const text = (id: string, t = 'hello') => ({ key: { remoteJid: G, id, participant: '639181112222@s.whatsapp.net' }, message: { conversation: t }, pushName: 'Maria', messageTimestamp: 1758000000 });

async function setup(o: { fail?: () => boolean } = {}) {
  const store = new Store(':memory:');
  const posted: InboundPayload[] = [];
  const fetched: (Buffer | undefined)[] = [];
  const mediaDir = await mkdtemp(join(tmpdir(), 'wag-media-'));
  const mirror: Mirror = new Mirror({
    store,
    context: () => ({ selfNumber: '14155550100', kitaNumbers: new Map(), subject: () => 'Kita x Tala' }),
    download: async () => Buffer.from('JPEGDATA'),
    forward: async (p) => {
      if (o.fail?.()) throw new Error('bridge down');
      // kita-bridges downloads the attachment while handling the request
      for (const a of p.attachments) fetched.push(await mirror.media(a.url.split('/').pop()!));
      posted.push(p);
    },
    mediaDir,
    mediaBaseUrl: 'http://wa-groups:8090/wa-groups',
    secret: 'link-secret-0123456789',
    mediaMaxBytes: 1024,
  });
  return { store, posted, fetched, mirror, mediaDir };
}

test('dedupe: live + history copies of one message reach the desk once, in order', async () => {
  const { mirror, posted } = await setup();
  assert.deepEqual(await mirror.handle([text('A', 'one'), text('B', 'two')]), ['delivered', 'delivered']);
  assert.deepEqual(await mirror.handle([text('A', 'one'), text('C', 'three')], { backfill: true }), ['duplicate', 'delivered']);
  assert.deepEqual(posted.map((p) => p.text), ['one', 'two', 'three']);
  assert.equal(posted[0].backfill, undefined);
  assert.equal(posted[2].backfill, true);
  assert.equal(posted[2].created_at, 1758000000);
});

test('a failed delivery is not marked delivered, so a re-sync retries it', async () => {
  let down = true;
  const { mirror, posted } = await setup({ fail: () => down });
  assert.deepEqual(await mirror.handle([text('A')]), ['skipped']);
  down = false;
  assert.deepEqual(await mirror.handle([text('A')]), ['delivered']);
  assert.equal(posted.length, 1);
});

test('messages the Kita number sent for the desk are never mirrored back', async () => {
  const { mirror, store, posted } = await setup();
  store.markSent(`wag:${G}:OWN`);
  assert.deepEqual(await mirror.handle([text('OWN')]), ['own_send']);
  assert.equal(posted.length, 0);
});

test('media is served to the bridge (secret header) during delivery, then deleted', async () => {
  const { mirror, posted, fetched, mediaDir } = await setup();
  await mirror.handle([{ ...text('IMG'), message: { imageMessage: { mimetype: 'image/jpeg', caption: 'see' } } }]);
  const a = posted[0].attachments[0];
  assert.match(a.url, /^http:\/\/wa-groups:8090\/wa-groups\/internal\/media\/[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(a.headers, { 'x-kita-bridge-secret': 'link-secret-0123456789' });
  assert.equal(a.name, 'image-IMG.jpg');
  assert.equal(fetched[0]?.toString(), 'JPEGDATA');
  assert.deepEqual(await readdir(mediaDir), []);
  assert.equal(await mirror.media('../../etc/passwd'), undefined);
});

test('media over the size cap is noted in the text, not copied', async () => {
  const big = await setup();
  (big.mirror as any).d.download = async () => Buffer.alloc(2048);
  await big.mirror.handle([{ ...text('V'), message: { videoMessage: { mimetype: 'video/mp4', caption: 'clip' } } }]);
  assert.deepEqual(big.posted[0].attachments, []);
  assert.equal(big.posted[0].text, 'clip\n\n[video not copied]');
});
