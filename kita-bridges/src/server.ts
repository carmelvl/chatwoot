import { createServer } from 'node:http';
import { Bridge } from './bridge.ts';
import { ChatwootClient } from './chatwoot.ts';
import { enabledPlatforms, loadConfig } from './config.ts';
import { createHandler } from './app.ts';
import { log } from './log.ts';
import { SlackSender } from './platforms/slack.ts';
import { TeamsIntegration } from './platforms/teams/index.ts';
import { SYNC_INTERVAL_MS } from './platforms/teams/subscriptions.ts';
import { ViberSender } from './platforms/viber.ts';
import { Store } from './store.ts';
import type { Platform, Sender } from './types.ts';

const cfg = loadConfig();
const enabled = enabledPlatforms(cfg);
const store = new Store(cfg.dbPath);
const slack = enabled.includes('slack') ? new SlackSender(cfg.slack.botToken, { name: cfg.slack.botName, iconUrl: cfg.slack.botIconUrl || undefined }) : undefined;
const teams = enabled.includes('teams') ? new TeamsIntegration(cfg.teams, cfg.publicUrl, store) : undefined;
const viber = enabled.includes('viber') ? new ViberSender(cfg.viber.authToken, { name: cfg.viber.botName, avatar: cfg.viber.botAvatar || undefined }) : undefined;
const senders: Partial<Record<Platform, Sender>> = { slack, teams: teams?.sender, viber };

const bridge = new Bridge({ store, chatwoot: new ChatwootClient(cfg.chatwootBaseUrl), inboxes: cfg.inboxes, senders, publicUrl: cfg.publicUrl });
const server = createServer(createHandler({ cfg, store, bridge, enabled, slack, teams }));

// Keep Graph subscriptions alive (renewed well before the 3-day cap) and pick up newly joined channels.
if (teams) {
  const syncTeams = () => teams.sync().catch((e) => log.error('teams_sync_failed', { error: String(e?.message ?? e) }));
  setTimeout(syncTeams, 5_000).unref();
  setInterval(syncTeams, SYNC_INTERVAL_MS).unref();
}

setInterval(() => {
  store.pruneSeen();
  store.pruneMedia(cfg.mediaTtlMs);
}, 6 * 3600 * 1000).unref();
server.listen(cfg.port, () => log.info('listening', { port: cfg.port, platforms: enabled }));
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
