import { createServer } from 'node:http';
import { Bridge } from './bridge.ts';
import { ChatwootClient } from './chatwoot.ts';
import { enabledPlatforms, loadConfig } from './config.ts';
import { createHandler } from './app.ts';
import { log } from './log.ts';
import { SlackSender, SlackUserOAuth } from './platforms/slack.ts';
import { AgentConnect } from './connect.ts';
import { ChatwootAppClient, KitaDeskClient } from './chatwoot.ts';
import { signConnectLink } from './links.ts';
import { TeamsIntegration } from './platforms/teams/index.ts';
import { SYNC_INTERVAL_MS } from './platforms/teams/subscriptions.ts';
import { ScopeCache } from './scope.ts';
import { GripLinks } from './griplinks.ts';
import { teamsLabel } from './platforms/teams/labels.ts';
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
  ? new SlackSender(cfg.slack.botToken, (id) => slackOAuth?.userToken(id))
  : undefined;
const teams = enabled.includes('teams') ? new TeamsIntegration(cfg.teams, cfg.publicUrl, store) : undefined;
// Viber and WhatsApp are mirrors: the desk never sends there (people reply in the apps themselves).
const senders: Partial<Record<Platform, Sender>> = { slack, teams: teams?.sender };

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
// After each refresh: team sync, then merge newly linked channel conversations into their account's.
let bridge: Bridge | undefined;
const scope = new ScopeCache({
  baseUrl: cfg.grip.baseUrl, apiKey: cfg.grip.apiKey, refreshMs: cfg.grip.scopeRefreshMs,
  onRefresh: async (inScope) => {
    void teamSync.run(inScope).catch((e) => log.error('teamsync_failed', { error: String(e?.message ?? e) }));
    await bridge?.linkChannels();
  },
});
// Staff typing in Slack/Teams are posted by the desk as the matching agent; merges (shared BRIDGE_LINK_SECRET).
const desk = cfg.linkSecret ? new KitaDeskClient(cfg.chatwootBaseUrl, cfg.linkSecret) : undefined;
// Teams channels/chats get "Team › Channel" / topic / members labels from Graph (service account token).
const labeler = teams
  ? (platform: Platform, ref: Record<string, unknown>) => (platform === 'teams' ? teamsLabel(teams.graph, ref, cfg.teams.kitaUserUpn) : Promise.resolve(undefined))
  : undefined;
bridge = new Bridge({ store, chatwoot: new ChatwootClient(cfg.chatwootBaseUrl), inbox: cfg.customers.inboxIdentifier, senders, publicUrl: cfg.publicUrl, app, desk, connectLink, scope, labeler });
// Desk "Link to customer": Grip link, then refresh scope (which runs linkChannels) right away.
const linkRefresh = async () => {
  if (!(await scope.refresh())) await bridge!.linkChannels();
};
const gripLinks = new GripLinks({ baseUrl: cfg.grip.baseUrl, apiKey: cfg.grip.apiKey, refresh: linkRefresh });
void scope.start();
const connect = cfg.linkSecret
  ? new AgentConnect({ linkSecret: cfg.linkSecret, teams, slack: slackOAuth, whatsappNumbers: cfg.whatsapp.numbers, deskUrl: cfg.chatwootBaseUrl })
  : undefined;
const whatsappOwnerApps = new Map(
  cfg.whatsapp.numbers
    .filter((n) => n.agentAccessToken && cfg.chatwootAccountId)
    .map((n) => [n.phoneNumberId, new ChatwootAppClient(cfg.chatwootBaseUrl, n.agentAccessToken!, cfg.chatwootAccountId)] as const),
);
const server = createServer(createHandler({ cfg, store, bridge, enabled, slack, teams, connect, whatsappOwnerApps, gripLinks, linkRefresh }));

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
