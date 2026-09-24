const env = (k: string, d = ''): string => (process.env[k] ?? d).trim();
const url = (k: string, d: string) => env(k, d).replace(/\/$/, '');

export function loadConfig() {
  return {
    port: Number(env('PORT', '8080')),
    dbPath: env('GRIP_SYNC_DB_PATH', './data/grip-sync.sqlite'),
    /** Secret of the Chatwoot account webhook (Settings > Integrations > Webhooks). Signs every delivery. */
    webhookSecret: env('CHATWOOT_WEBHOOK_SECRET'),
    chatwootBaseUrl: url('CHATWOOT_BASE_URL', 'http://rails:3000'),
    /** Public desk URL, used for the chatwoot_url links stored in Grip. */
    chatwootPublicUrl: url('CHATWOOT_PUBLIC_URL', 'https://support.internal.kita.ai'),
    chatwootApiToken: env('CHATWOOT_API_TOKEN'),
    gripBaseUrl: url('GRIP_BASE_URL', 'https://internal.kita.ai'),
    gripApiKey: env('GRIP_API_KEY'),
    anthropicApiKey: env('ANTHROPIC_API_KEY'),
    anthropicBaseUrl: url('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
    claudeModel: env('CLAUDE_MODEL', 'claude-sonnet-5'),
    /** Trailing debounce before classifying a batch of customer messages. */
    debounceMs: Number(env('CLASSIFY_DEBOUNCE_SECONDS', '60')) * 1000,
    /** A conversation that keeps talking is still classified after this long. */
    debounceMaxMs: Number(env('CLASSIFY_MAX_WAIT_SECONDS', '300')) * 1000,
    /** Kill switch: sync conversations but never classify or ticket. */
    ticketsEnabled: env('AUTO_TICKETS', 'true') !== 'false',
    /** Administrator access token for agents#index and custom_attribute_definitions (agent bot tokens can't call them). Optional. */
    chatwootAdminToken: env('CHATWOOT_ADMIN_TOKEN'),
    /** Owner in the desk: DRI attributes + assignment. */
    ownerSync: env('OWNER_SYNC', 'true') !== 'false',
    agentsRefreshMs: Number(env('AGENTS_REFRESH_SECONDS', '600')) * 1000,
  };
}

export type Config = ReturnType<typeof loadConfig>;

/** Which pieces can run with the current env. Missing secrets disable a piece instead of crashing. */
export function capabilities(cfg: Config) {
  const webhook = !!cfg.webhookSecret;
  const grip = !!cfg.gripApiKey;
  const tickets = webhook && grip && cfg.ticketsEnabled && !!cfg.anthropicApiKey && !!cfg.chatwootApiToken;
  const owners = webhook && grip && cfg.ownerSync && !!cfg.chatwootApiToken;
  return { webhook, grip, tickets, owners };
}
