const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();

/** Digits only: "+63 917-123 4567" -> "639171234567". */
export const digits = (s: string) => s.replace(/\D/g, '');

/**
 * WA_GROUPS_KITA_NUMBERS="+639171234567=carmel@kita.ai,+14155550100": Kita staff numbers (optionally
 * with the desk agent's email). Their group messages show as Kita, never as External.
 */
export function parseKitaNumbers(raw: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [num, email] = part.split('=', 2).map((s) => s.trim());
    const d = digits(num);
    if (d.length < 6) throw new Error(`WA_GROUPS_KITA_NUMBERS: "${num}" is not a phone number`);
    out.set(d, email ? email.toLowerCase() : undefined);
  }
  return out;
}

export function loadConfig() {
  return {
    port: Number(env('PORT', '8090')),
    dataDir: env('WA_GROUPS_DATA_DIR', './data'),
    /** Auth state (the linked-device keys) is AES-256-GCM encrypted at rest with this. */
    encryptionKey: env('BRIDGE_ENCRYPTION_KEY'),
    /** Shared with kita-bridges and Rails: X-Kita-Bridge-Secret and signed pair links. */
    linkSecret: env('BRIDGE_LINK_SECRET'),
    /** kita-bridges, server to server (POST /internal/inbound). */
    bridgesUrl: env('BRIDGES_INTERNAL_URL', 'http://bridges:8080').replace(/\/$/, ''),
    /** This service as kita-bridges reaches it (media downloads). */
    internalUrl: env('WA_GROUPS_INTERNAL_URL', 'http://wa-groups:8090').replace(/\/$/, ''),
    kitaNumbers: parseKitaNumbers(env('WA_GROUPS_KITA_NUMBERS')),
    /** off (default): mirror only. on: desk replies post into the group as the Kita number. */
    send: env('WA_GROUPS_SEND', 'off') === 'on',
    joinsPerHour: Number(env('WA_GROUPS_JOINS_PER_HOUR', '5')),
    /** Import history the linked device receives (at pairing). */
    importHistory: env('WA_GROUPS_IMPORT_HISTORY', 'on') !== 'off',
    mediaMaxBytes: Number(env('WA_GROUPS_MEDIA_MAX_MB', '40')) * 1024 * 1024,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function assertConfig(cfg: Config) {
  if (cfg.encryptionKey.length < 16) throw new Error('BRIDGE_ENCRYPTION_KEY (>= 16 chars) is required');
  if (cfg.linkSecret.length < 16) throw new Error('BRIDGE_LINK_SECRET (>= 16 chars) is required');
}
