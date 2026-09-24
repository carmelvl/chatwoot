import { createServer } from 'node:http';
import { Bridge } from './bridge.ts';
import { ChatwootClient } from './chatwoot.ts';
import { enabledPlatforms, loadConfig } from './config.ts';
import { createHandler } from './app.ts';
import { log } from './log.ts';
import { SlackSender, SlackUserOAuth } from './platforms/slack.ts';
import { AgentConnect } from './connect.ts';
import { ChatwootAppClient } from './chatwoot.ts';
import { signConnectLink } from './links.ts';
import { TeamsIntegration } from './platforms/teams/index.ts';
import { SYNC_INTERVAL_MS } from './platforms/teams/subscriptions.ts';
import { ViberSender } from './platforms/viber.ts';
import { WhatsAppSender } from './platforms/whatsapp.ts';
import { ScopeCache } from './scope.ts';
import { Store } from './store.ts';
import { parseTeamSyncMode, rosterSource, SlackMembership, TeamSync, TeamsMembership } from './teamsync.ts';
import type { Platform, Sender } from './types.ts';

const cfg = loadConfig();
const enabled = enabledPlatforms(cfg);
const store = new Store(cfg.dbPath);
const slackOAuth =
  enabled.includes('slack') && cfg.slack.clientId && cfg.slack.clientSecret && cfg.encryptionKey
    ? new SlackUserOAuth({ clientId: cfg.slack.clientId, clientSecret: cfg.slack.clientSecret, redirectUri: `${cfg.publicUrl}/connect/slack/callback`, botToken: cfg.slack.botToken, encryptionKey: cfg.encryptionKey }, store)
    : undefined;
const slack = enabled.includes('slack')
  ? new SlackSender(cfg.slack.botToken, { name: cfg.slack.botName, iconUrl: cfg.slack.botIconUrl || undefined }, fetch, (id) => slackOAuth?.userToken(id))
  : undefined;
const teams = enabled.includes('teams') ? new TeamsIntegration(cfg.teams, cfg.publicUrl, store) : undefined;
const viber = enabled.includes('viber') ? new ViberSender(cfg.viber.authToken, { name: cfg.viber.botName, avatar: cfg.viber.botAvatar || undefined }, fetch, cfg.viber.prefixAgentName) : undefined;
const whatsapp = enabled.includes('whatsapp') && cfg.whatsapp.mode === 'send' ? new WhatsAppSender(cfg.whatsapp.accessToken, cfg.whatsapp.prefixAgentName) : undefined;
const senders: Partial<Record<Platform, Sender>> = { slack, teams: teams?.sender, viber, whatsapp };

const app = cfg.chatwootApiToken && cfg.chatwootAccountId ? new ChatwootAppClient(cfg.chatwootBaseUrl, cfg.chatwootApiToken, cfg.chatwootAccountId) : undefined;
const connectLink = cfg.linkSecret ? (a: { id: number; email?: string }) => (a.email ? signConnectLink(cfg.linkSecret, cfg.publicUrl, { id: a.id, email: a.email }) : undefined) : undefined;
// Team in every customer channel: runs after each Grip scope refresh (TEAM_SYNC=off|dry-run|on, default dry-run).
const teamSync = new TeamSync({
  mode: parseTeamSyncMode(cfg.teamSync.mode),
  store,
  roster: rosterSource({ emails: cfg.teamSync.roster, exclude: cfg.teamSync.exclude, listAgents: app ? () => app.listAgents() : undefined }),
  slack: enabled.includes('slack') ? new SlackMembership({ botToken: cfg.slack.botToken }) : undefined,
  teams: teams ? new TeamsMembership({ graph: teams.graph, store }) : undefined,
});
// Grip scope (fails open; disabled when GRIP_* is unset). First refresh runs in the background.
const scope = new ScopeCache({
  baseUrl: cfg.grip.baseUrl, apiKey: cfg.grip.apiKey, refreshMs: cfg.grip.scopeRefreshMs,
  onRefresh: (inScope) => void teamSync.run(inScope).catch((e) => log.error('teamsync_failed', { error: String(e?.message ?? e) })),
});
void scope.start();
const bridge = new Bridge({ store, chatwoot: new ChatwootClient(cfg.chatwootBaseUrl), inboxes: cfg.inboxes, senders, publicUrl: cfg.publicUrl, app, connectLink, scope });
const connect = cfg.linkSecret && (teams || slackOAuth) ? new AgentConnect({ linkSecret: cfg.linkSecret, teams, slack: slackOAuth }) : undefined;
const whatsappOwnerApps = new Map(
  cfg.whatsapp.numbers
    .filter((n) => n.agentAccessToken && cfg.chatwootAccountId)
    .map((n) => [n.phoneNumberId, new ChatwootAppClient(cfg.chatwootBaseUrl, n.agentAccessToken!, cfg.chatwootAccountId)] as const),
);
const server = createServer(createHandler({ cfg, store, bridge, enabled, slack, teams, connect, whatsappOwnerApps }));

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
  process.on(sig, () => server.close(() => { scope.stop(); store.close(); process.exit(0); }));
