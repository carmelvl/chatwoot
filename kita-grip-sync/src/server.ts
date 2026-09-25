import { createServer } from 'node:http';
import { createHandler } from './app.ts';
import { ChatwootApi, KitaDesk } from './chatwoot.ts';
import { ClaudeClassifier, OpenAIClassifier } from './claude.ts';
import { capabilities, loadConfig } from './config.ts';
import { GripClient } from './grip.ts';
import { log } from './log.ts';
import { Owners } from './owner.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';

const cfg = loadConfig();
const caps = capabilities(cfg);
const store = new Store(cfg.dbPath);
const botApi = cfg.chatwootApiToken ? new ChatwootApi(cfg.chatwootBaseUrl, cfg.chatwootApiToken) : undefined;
const owners = caps.owners && botApi
  ? new Owners({ store, chatwoot: botApi, directory: cfg.chatwootAdminToken ? new ChatwootApi(cfg.chatwootBaseUrl, cfg.chatwootAdminToken) : undefined, agentsRefreshMs: cfg.agentsRefreshMs })
  : undefined;
const sync = new Sync({
  store,
  owners,
  grip: caps.grip ? new GripClient(cfg.gripBaseUrl, cfg.gripApiKey) : undefined,
  chatwoot: caps.tickets ? botApi : undefined,
  desk: caps.threads ? new KitaDesk(cfg.chatwootBaseUrl, cfg.bridgeLinkSecret) : undefined,
  // Anthropic when its key is set, otherwise OpenAI.
  claude: !caps.tickets
    ? undefined
    : cfg.anthropicApiKey
      ? new ClaudeClassifier({ apiKey: cfg.anthropicApiKey, model: cfg.claudeModel, baseUrl: cfg.anthropicBaseUrl })
      : new OpenAIClassifier({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel }),
  publicUrl: cfg.chatwootPublicUrl,
  debounceMs: cfg.debounceMs,
  debounceMaxMs: cfg.debounceMaxMs,
});

const tick = () => void sync.runDue().catch((e) => log.error('runner_failed', { error: String(e?.message ?? e) }));
const server = createServer(createHandler({ webhookSecret: cfg.webhookSecret, deskSecret: cfg.bridgeLinkSecret, sync, kick: tick, health: () => caps }));

setInterval(tick, 1000).unref();
setInterval(() => store.pruneSeen(), 6 * 3600 * 1000).unref();
server.listen(cfg.port, () => log.info('listening', { port: cfg.port, ...caps }));
if (!caps.webhook) log.warn('CHATWOOT_WEBHOOK_SECRET unset: every webhook will be rejected');
for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, () => server.close(() => { store.close(); process.exit(0); }));
