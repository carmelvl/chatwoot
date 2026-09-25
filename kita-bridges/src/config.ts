import type { Platform } from './types.ts';
import type { WhatsAppNumber } from './platforms/whatsapp.ts';

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const list = (k: string): string[] => env(k).split(',').map((s) => s.trim()).filter(Boolean);

export interface PlatformInbox {
  inboxIdentifier: string;
  webhookSecret: string;
}

export function loadConfig() {
  return {
    port: Number(env('PORT', '8080')),
    publicUrl: env('BRIDGE_PUBLIC_URL', 'https://support.internal.kita.ai/bridges').replace(/\/$/, ''),
    mediaTtlMs: Number(env('MEDIA_TTL_DAYS', '90')) * 24 * 3600 * 1000,
    dbPath: env('BRIDGE_DB_PATH', './data/bridges.sqlite'),
    chatwootBaseUrl: env('CHATWOOT_BASE_URL', 'http://rails:3000').replace(/\/$/, ''),
    // Application API (agent access token) for private notes, staff-typed sync and avatars. Optional.
    chatwootApiToken: env('CHATWOOT_API_ACCESS_TOKEN'),
    chatwootAccountId: env('CHATWOOT_ACCOUNT_ID'),
    /** Signs per-agent connect links. */
    linkSecret: env('BRIDGE_LINK_SECRET'),
    encryptionKey: env('BRIDGE_ENCRYPTION_KEY'),
    /** The single "Customers" API inbox: every platform posts here; its webhook is POST /chatwoot/customers. */
    customers: { inboxIdentifier: env('CHATWOOT_CUSTOMERS_INBOX_IDENTIFIER'), webhookSecret: env('CHATWOOT_CUSTOMERS_WEBHOOK_SECRET') } as PlatformInbox,
    grip: {
      baseUrl: env('GRIP_BASE_URL').replace(/\/$/, ''),
      apiKey: env('GRIP_API_KEY'),
      scopeRefreshMs: Number(env('SCOPE_REFRESH_SECONDS', '300')) * 1000,
      /** SCOPE_FILTER=on drops Grip's out_of_scope channels (live and history). off (default): everything shows. */
      scopeFilter: env('SCOPE_FILTER', 'off') === 'on',
    },
    backfill: {
      /** BACKFILL=off disables history import on join. */
      enabled: env('BACKFILL', 'on') !== 'off',
      /** Only import this many days of history (0 / unset = the whole history). */
      maxDays: Number(env('BACKFILL_MAX_DAYS', '0')) || 0,
      /** Slack: re-check every channel the bot is in (users.conversations) this often, catching joins missed while down. */
      reconcileMs: Number(env('BACKFILL_RECONCILE_SECONDS', '21600')) * 1000,
    },
    teamSync: {
      /** off | dry-run (default: log what would be added) | on */
      mode: env('TEAM_SYNC', 'dry-run'),
      /** Kita team emails. Blank = every active Chatwoot agent. */
      roster: list('TEAM_ROSTER').map((e) => e.toLowerCase()),
      exclude: (list('TEAM_ROSTER_EXCLUDE').length ? list('TEAM_ROSTER_EXCLUDE') : ['bridge@kita.ai']).map((e) => e.toLowerCase()),
    },
    whatsapp: {
      appSecret: env('WHATSAPP_APP_SECRET'),
      verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
      accessToken: env('WHATSAPP_ACCESS_TOKEN'),
      numbers: parseNumbers(env('WHATSAPP_NUMBERS', '[]')),
    },
    slack: {
      signingSecret: env('SLACK_SIGNING_SECRET'),
      botToken: env('SLACK_BOT_TOKEN'),
      internalTeamIds: list('SLACK_INTERNAL_TEAM_IDS'),
      allowedChannels: list('SLACK_ALLOWED_CHANNELS'),
      // Per-agent user OAuth (replies post as the real person). Optional.
      clientId: env('SLACK_CLIENT_ID'),
      clientSecret: env('SLACK_CLIENT_SECRET'),
    },
    teams: {
      tenantId: env('TEAMS_TENANT_ID'),
      clientId: env('TEAMS_CLIENT_ID'),
      clientSecret: env('TEAMS_CLIENT_SECRET'),
      kitaUserUpn: env('TEAMS_KITA_USER_UPN'),
      internalTenantIds: list('TEAMS_INTERNAL_TENANT_IDS').length ? list('TEAMS_INTERNAL_TENANT_IDS') : [env('TEAMS_TENANT_ID')].filter(Boolean),
      connectKey: env('TEAMS_CONNECT_KEY'),
      teamIds: list('TEAMS_TEAM_IDS'),
      extraChannels: list('TEAMS_EXTRA_CHANNELS'),
      messageFormat: (env('TEAMS_MESSAGE_FORMAT', 'auto') as 'auto' | 'html' | 'card'),
      encryptionKey: env('BRIDGE_ENCRYPTION_KEY'),
    },
    viber: {
      authToken: env('VIBER_AUTH_TOKEN'),
    },
  };
}

function parseNumbers(json: string): WhatsAppNumber[] {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('WHATSAPP_NUMBERS must be a JSON array');
  // inboxIdentifier / webhookSecret (per-number inboxes, before the Customers inbox) are accepted and ignored.
  for (const n of list) if (!n.phoneNumberId || !n.ownerName) throw new Error('each WHATSAPP_NUMBERS entry needs phoneNumberId and ownerName');
  return list;
}

export type Config = ReturnType<typeof loadConfig>;

export function enabledPlatforms(cfg: Config): Platform[] {
  const out: Platform[] = [];
  // Nothing is bridged without the Customers inbox.
  if (!cfg.customers.inboxIdentifier || !cfg.customers.webhookSecret) return out;
  if (cfg.slack.signingSecret && cfg.slack.botToken) out.push('slack');
  const t = cfg.teams;
  if (t.tenantId && t.clientId && t.clientSecret && t.kitaUserUpn && t.connectKey.length >= 16 && t.encryptionKey.length >= 16) out.push('teams');
  if (cfg.viber.authToken) out.push('viber');
  const w = cfg.whatsapp;
  if (w.numbers.length && w.appSecret && w.verifyToken && w.accessToken) out.push('whatsapp');
  return out;
}
