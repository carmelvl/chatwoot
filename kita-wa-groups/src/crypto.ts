import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM, same format as kita-bridges/src/crypto.ts: iv.tag.ciphertext (base64url). */
export function seal(key: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function unseal(key: string, sealed: string): string {
  const [iv, tag, ct] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * Signed admin link to the pair page: ?x=<expiry unix s>&s=HEX(HMAC_SHA256(secret, "wa-groups-pair|<x>")).
 * Rails mints it (Kita::WaGroups.pair_url) so the bridge secret never reaches the browser.
 */
export const pairSignature = (secret: string, exp: string) => createHmac('sha256', secret).update(`wa-groups-pair|${exp}`).digest('hex');

export function verifyPairLink(secret: string, params: URLSearchParams, now = Date.now()): boolean {
  const x = params.get('x') ?? '';
  const s = params.get('s') ?? '';
  if (!secret || !/^\d+$/.test(x) || Number(x) * 1000 < now) return false;
  return safeEqual(s, pairSignature(secret, x));
}
