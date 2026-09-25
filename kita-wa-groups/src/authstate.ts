import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seal, unseal } from './crypto.ts';

/**
 * Baileys-compatible Buffer JSON (same wire shape as BufferJSON): Buffers/Uint8Arrays become
 * { type: 'Buffer', data: <base64> } and come back as Buffers.
 */
export const bufferReplacer = (_k: string, value: any) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer')
    return { type: 'Buffer', data: Buffer.from(value?.data ?? value).toString('base64') };
  return value;
};
export const bufferReviver = (_k: string, value: any) => {
  if (value && typeof value === 'object' && value.type === 'Buffer' && (typeof value.data === 'string' || Array.isArray(value.data)))
    return typeof value.data === 'string' ? Buffer.from(value.data, 'base64') : Buffer.from(value.data);
  // Uint8Arrays serialised as { "0": n, "1": n, ... } (Baileys' BufferJSON reads these too)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => /^\d+$/.test(k)) && Object.values(value).every((v) => typeof v === 'number')) return Buffer.from(Object.values(value) as number[]);
  }
  return value;
};

/** What the auth state needs from Baileys (injected so tests never load it). */
export interface AuthLib {
  initAuthCreds: () => any;
  /** proto.Message.AppStateSyncKeyData.fromObject */
  appStateSyncKey: (v: any) => any;
}

const fileName = (name: string) => `${name.replace(/\//g, '__').replace(/:/g, '-')}.enc`;

/**
 * Baileys auth state (creds + signal keys) as one AES-256-GCM sealed file per key, on the /data volume.
 * Writes are atomic (tmp + rename) and serialised per file.
 */
export async function useEncryptedAuthState(dir: string, key: string, lib: AuthLib) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(file: string, fn: () => Promise<T>): Promise<T> => {
    const p = (locks.get(file) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(file, p);
    return p;
  };
  const write = (name: string, data: unknown) =>
    locked(name, async () => {
      const path = join(dir, fileName(name));
      await writeFile(`${path}.tmp`, seal(key, JSON.stringify(data, bufferReplacer)), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
  const read = (name: string) =>
    locked(name, async () => {
      let sealed: string;
      try {
        sealed = await readFile(join(dir, fileName(name)), 'utf8');
      } catch {
        return null;
      }
      // A wrong key is a deployment bug: fail loudly rather than silently re-pairing.
      return JSON.parse(unseal(key, sealed), bufferReviver);
    });
  const remove = (name: string) => locked(name, () => rm(join(dir, fileName(name)), { force: true }));

  const creds = (await read('creds')) ?? lib.initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, any> = {};
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && v) v = lib.appStateSyncKey(v);
              out[id] = v;
            }),
          );
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<unknown>[] = [];
          for (const type in data) for (const id in data[type]) tasks.push(data[type][id] ? write(`${type}-${id}`, data[type][id]) : remove(`${type}-${id}`));
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

/** Logged out: forget the linked device entirely so the next start shows a fresh QR. */
export async function clearAuthState(dir: string) {
  for (const f of await readdir(dir).catch(() => [] as string[])) await rm(join(dir, f), { force: true, recursive: true });
}
