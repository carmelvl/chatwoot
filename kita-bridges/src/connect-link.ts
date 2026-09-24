// Admin helper: prints a signed per-agent connect link.
//   node src/connect-link.ts <chatwoot-user-id> <email> [days]
import { loadConfig } from './config.ts';
import { signConnectLink } from './links.ts';

const [id, email, days] = process.argv.slice(2);
const cfg = loadConfig();
if (!id || !email || !cfg.linkSecret) {
  console.error('usage: BRIDGE_LINK_SECRET=... node src/connect-link.ts <chatwoot-user-id> <email> [days]');
  process.exit(1);
}
console.log(signConnectLink(cfg.linkSecret, cfg.publicUrl, { id: Number(id), email }, Number(days ?? 7)));
