import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Mirror } from '../src/mirror.ts';
import { Store } from '../src/store.ts';
import { WaClient, type BaileysLib } from '../src/wa.ts';

const G = '120363040000000001@g.us';
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

/** Mocked Baileys socket: an event emitter plus recorded group / send calls. */
function fakeSocket() {
  const ee = new EventEmitter();
  const calls: string[] = [];
  const sock = {
    ev: { on: (e: string, fn: any) => ee.on(e, fn) },
    emit: (e: string, arg: any) => ee.emit(e, arg),
    user: { id: '14155550100:7@s.whatsapp.net' },
    calls,
    groupGetInviteInfo: async (code: string) => {
      calls.push(`info:${code}`);
      if (code !== CODE) throw new Error('not-authorized');
      return { id: G, subject: 'Kita x Tala', size: 12 };
    },
    groupAcceptInvite: async (code: string) => (calls.push(`accept:${code}`), G),
    groupMetadata: async (jid: string) => ({ id: jid, subject: 'Fetched' }),
    groupFetchAllParticipating: async () => ({ [G]: { id: G, subject: 'Kita x Tala', participants: [1, 2, 3] } }),
    sendMessage: async (jid: string, c: any) => (calls.push(`send:${jid}:${c.text}`), { key: { id: 'SENT1' } }),
    logout: async () => {},
    end: () => {},
  };
  return sock;
}

async function setup(env: Partial<ReturnType<typeof loadConfig>> = {}) {
  const cfg = { ...loadConfig(), dataDir: await mkdtemp(join(tmpdir(), 'wag-')), encryptionKey: 'k'.repeat(32), linkSecret: 's'.repeat(32), joinsPerHour: 2, ...env };
  const store = new Store(':memory:');
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const opts: any[] = [];
  const lib: BaileysLib = {
    makeWASocket: (o: any) => {
      opts.push(o);
      const s = fakeSocket();
      sockets.push(s);
      return s as any;
    },
    downloadMediaMessage: async () => Buffer.from('x'),
    initAuthCreds: () => ({ registered: false }),
    appStateSyncKey: (v) => v,
    browser: ['Mac OS', 'Desktop', '14'],
  };
  const handled: { msgs: any[]; backfill?: boolean }[] = [];
  const mirror = { handle: async (msgs: any[], o: any = {}) => (handled.push({ msgs, backfill: o.backfill }), []) } as unknown as Mirror;
  const wa = new WaClient({ cfg, store, lib, mirror });
  await wa.start();
  const open = async () => {
    sockets.at(-1)!.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 5));
  };
  return { wa, cfg, store, sockets, opts, handled, open };
}

test('pairing: QR is exposed, then "connected as" the number; history sync is requested', async () => {
  const { wa, opts, sockets, open } = await setup();
  assert.equal(wa.status, 'pairing');
  assert.equal(opts[0].syncFullHistory, true);
  assert.equal(opts[0].markOnlineOnConnect, false);
  sockets[0].emit('connection.update', { qr: '2@abc' });
  assert.equal(wa.qr, '2@abc');
  await open();
  assert.equal(wa.status, 'connected');
  assert.equal(wa.number, '14155550100');
  assert.equal(wa.qr, undefined);
  assert.deepEqual(wa.groups().map((g) => [g.subject, g.participants]), [['Kita x Tala', 3]]);
  wa.stop();
});

test('401 logged out: auth state is wiped and a fresh socket shows a new QR; other drops reconnect', async () => {
  const { wa, sockets, open, cfg } = await setup();
  await open();
  sockets[0].emit('creds.update', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((await readdir(join(cfg.dataDir, 'auth'))).length > 0);
  sockets[0].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(wa.status, 'pairing');
  assert.equal(wa.number, undefined);
  assert.equal(sockets.length, 2);
  sockets[1].emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sockets.length, 3);
  wa.stop();
});

test('group messages (live and history) go to the mirror; 1:1 chats never do', async () => {
  const { wa, sockets, handled, open, store } = await setup();
  await open();
  const g = { key: { remoteJid: G, id: '1' }, message: { conversation: 'hi' } };
  const dm = { key: { remoteJid: '639@s.whatsapp.net', id: '2' }, message: { conversation: 'dm' } };
  sockets[0].emit('messages.upsert', { type: 'notify', messages: [g, dm] });
  sockets[0].emit('messaging-history.set', { chats: [{ id: '777@g.us', name: 'Old group' }], messages: [g, dm] });
  assert.deepEqual(handled.map((h) => [h.msgs.length, h.backfill]), [[1, false], [1, true]]);
  assert.equal(store.getGroup('777@g.us')?.subject, 'Old group');
  wa.stop();
});

test('join: validates the link, rejects revoked invites, is idempotent and rate limited', async () => {
  const { wa, sockets, open } = await setup({ joinsPerHour: 1 });
  await assert.rejects(wa.join(`https://chat.whatsapp.com/${CODE}`), { status: 409 }); // not connected yet
  await open();
  await assert.rejects(wa.join('https://example.com/x'), { status: 422 });
  await assert.rejects(wa.join('https://chat.whatsapp.com/ZZZZZZZZZZZZZZZZZZZZZZ'), { status: 404 });
  // Already a member (seen at connect): no accept call, no rate-limit spent
  assert.deepEqual(await wa.join(`https://chat.whatsapp.com/${CODE}`), { jid: G, subject: 'Kita x Tala', already: true });
  assert.ok(!sockets[0].calls.some((c) => c.startsWith('accept:')));
  wa.stop();
});

test('join accepts the invite and records the group; the hourly limit blocks the next one', async () => {
  const { wa, sockets, open, store } = await setup({ joinsPerHour: 1 });
  await open();
  store.deleteGroup(G);
  assert.deepEqual(await wa.join(`https://chat.whatsapp.com/${CODE}`), { jid: G, subject: 'Kita x Tala' });
  assert.ok(sockets[0].calls.includes(`accept:${CODE}`));
  store.deleteGroup(G);
  await assert.rejects(wa.join(`https://chat.whatsapp.com/${CODE}`), { status: 429 });
  wa.stop();
});

test('send is refused unless WA_GROUPS_SEND=on; when on, the sent id is remembered as our own', async () => {
  const off = await setup();
  await off.open();
  await assert.rejects(off.wa.send(G, 'hi'), { status: 403 });
  assert.ok(!off.sockets[0].calls.some((c) => c.startsWith('send:')));
  off.wa.stop();

  const on = await setup({ send: true });
  await on.open();
  assert.equal(await on.wa.send(G, 'Hello from Kita'), `wag:${G}:SENT1`);
  assert.ok(on.store.isSent(`wag:${G}:SENT1`));
  await assert.rejects(on.wa.send('999@g.us', 'x'), { status: 404 });
  on.wa.stop();
});
