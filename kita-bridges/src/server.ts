import { createServer } from 'node:http';
import { Bridge } from './bridge.ts';
import { ChatwootClient } from './chatwoot.ts';
import { enabledPlatforms, loadConfig } from './config.ts';
import { createHandler } from './app.ts';
import { log } from './log.ts';
import { SlackSender } from './platforms/slack.ts';
import { TeamsSender, botFrameworkJwks } from './platforms/teams.ts';
import { ViberSender } from './platforms/viber.ts';
import { Store } from './store.ts';
import type { Platform, Sender } from './types.ts';

const cfg = loadConfig();
const enabled = enabledPlatforms(cfg);
const store = new Store(cfg.dbPath);
const slack = enabled.includes('slack') ? new SlackSender(cfg.slack.botToken) : undefined;
const teams = enabled.includes('teams') ? new TeamsSender(cfg.teams) : undefined;
const viber = enabled.includes('viber') ? new ViberSender(cfg.viber.authToken, { name: cfg.viber.botName, avatar: cfg.viber.botAvatar || undefined }) : undefined;
const senders: Partial<Record<Platform, Sender>> = { slack, teams, viber };

const bridge = new Bridge({ store, chatwoot: new ChatwootClient(cfg.chatwootBaseUrl), inboxes: cfg.inboxes, senders });
const server = createServer(createHandler({ cfg, bridge, enabled, slack, teams, jwks: botFrameworkJwks() }));

setInterval(() => store.pruneSeen(), 6 * 3600 * 1000).unref();
server.listen(cfg.port, () => log.info('listening', { port: cfg.port, platforms: enabled }));
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
