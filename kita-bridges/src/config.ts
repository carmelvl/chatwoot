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
    inboxes: { slack: inbox('slack'), teams: inbox('teams'), viber: inbox('viber') } as Record<Platform, PlatformInbox>,
    slack: {
      signingSecret: env('SLACK_SIGNING_SECRET'),
      botToken: env('SLACK_BOT_TOKEN'),
      internalTeamIds: list('SLACK_INTERNAL_TEAM_IDS'),
      allowedChannels: list('SLACK_ALLOWED_CHANNELS'),
      botName: env('SLACK_BOT_NAME', 'Kita'),
      botIconUrl: env('SLACK_BOT_ICON_URL'),
    },
    teams: {
      appId: env('TEAMS_APP_ID'),
      appPassword: env('TEAMS_APP_PASSWORD'),
      tenantId: env('TEAMS_APP_TENANT_ID'),
    },
    viber: {
      authToken: env('VIBER_AUTH_TOKEN'),
      botName: env('VIBER_BOT_NAME', 'Kita'),
      botAvatar: env('VIBER_BOT_AVATAR'),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

export function enabledPlatforms(cfg: Config): Platform[] {
  const out: Platform[] = [];
  const ok = (p: Platform) => cfg.inboxes[p].inboxIdentifier && cfg.inboxes[p].webhookSecret;
  if (ok('slack') && cfg.slack.signingSecret && cfg.slack.botToken) out.push('slack');
  if (ok('teams') && cfg.teams.appId && cfg.teams.appPassword) out.push('teams');
  if (ok('viber') && cfg.viber.authToken) out.push('viber');
  return out;
}
