import type { Platform } from './types.ts';

const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const list = (k: string): string[] => env(k).split(',').map((s) => s.trim()).filter(Boolean);

export interface PlatformInbox {
  inboxIdentifier: string;
  webhookSecret: string;
}

export function loadConfig() {
  const inbox = (p: Platform): PlatformInbox => ({
    inboxIdentifier: env(`CHATWOOT_${p.toUpperCase()}_INBOX_IDENTIFIER`),
    webhookSecret: env(`CHATWOOT_${p.toUpperCase()}_WEBHOOK_SECRET`),
  });
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
    inboxes: { slack: inbox('slack'), teams: inbox('teams'), viber: inbox('viber') } as Record<Platform, PlatformInbox>,
    slack: {
      signingSecret: env('SLACK_SIGNING_SECRET'),
      botToken: env('SLACK_BOT_TOKEN'),
      internalTeamIds: list('SLACK_INTERNAL_TEAM_IDS'),
      allowedChannels: list('SLACK_ALLOWED_CHANNELS'),
      botName: env('SLACK_BOT_NAME', 'Kita'),
      botIconUrl: env('SLACK_BOT_ICON_URL'),
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
      botName: env('VIBER_BOT_NAME', 'Kita'),
      botAvatar: env('VIBER_BOT_AVATAR'),
      prefixAgentName: env('VIBER_PREFIX_AGENT_NAME', 'true') !== 'false',
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function enabledPlatforms(cfg: Config): Platform[] {
  const out: Platform[] = [];
  const ok = (p: Platform) => cfg.inboxes[p].inboxIdentifier && cfg.inboxes[p].webhookSecret;
  if (ok('slack') && cfg.slack.signingSecret && cfg.slack.botToken) out.push('slack');
  const t = cfg.teams;
  if (ok('teams') && t.tenantId && t.clientId && t.clientSecret && t.kitaUserUpn && t.connectKey.length >= 16 && t.encryptionKey.length >= 16) out.push('teams');
  if (ok('viber') && cfg.viber.authToken) out.push('viber');
  return out;
}
