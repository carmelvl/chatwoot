import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAuthState, useEncryptedAuthState } from '../src/authstate.ts';

const lib = { initAuthCreds: () => ({ noiseKey: { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5]) }, registered: false }), appStateSyncKey: (v: any) => ({ wrapped: v }) };
const KEY = 'k'.repeat(32);

test('auth state round-trips encrypted: creds and signal keys (Buffers intact), nothing readable on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-auth-'));
  const a = await useEncryptedAuthState(dir, KEY, lib);
  a.state.creds.registered = true;
  a.state.creds.me = { id: '14155550100:1@s.whatsapp.net' };
  await a.saveCreds();
  await a.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('secret-bytes'), public: new Uint8Array([9]) } }, 'app-state-sync-key': { AAA: { keyData: Buffer.from([7]) } } });

  for (const f of await readdir(dir)) {
    const raw = await readFile(join(dir, f), 'utf8');
    assert.doesNotMatch(raw, /14155550100|secret-bytes|registered/);
  }

  const b = await useEncryptedAuthState(dir, KEY, lib);
  assert.equal(b.state.creds.registered, true);
  assert.deepEqual(b.state.creds.noiseKey.private, Buffer.from([1, 2, 3]));
  const keys = await b.state.keys.get('pre-key', ['1', '2']);
  assert.deepEqual(keys['1'].private, Buffer.from('secret-bytes'));
  assert.deepEqual(keys['1'].public, Buffer.from([9]));
  assert.equal(keys['2'], null);
  const app = await b.state.keys.get('app-state-sync-key', ['AAA']);
  assert.deepEqual(app.AAA.wrapped.keyData, Buffer.from([7]));

  await b.state.keys.set({ 'pre-key': { '1': null } });
  assert.equal((await b.state.keys.get('pre-key', ['1']))['1'], null);
});

test('a wrong key fails loudly; clearing forgets the device (fresh creds)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-auth-'));
  const a = await useEncryptedAuthState(dir, KEY, lib);
  a.state.creds.registered = true;
  await a.saveCreds();
  await assert.rejects(useEncryptedAuthState(dir, 'x'.repeat(32), lib));
  await clearAuthState(dir);
  assert.equal((await useEncryptedAuthState(dir, KEY, lib)).state.creds.registered, false);
});
