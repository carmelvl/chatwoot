# kita-grip-sync

Keeps Grip (internal.kita.ai) in step with the support desk (support.internal.kita.ai). Every Chatwoot conversation becomes a `support_conversations` row in Grip, which rolls up into each account's support status. Customer issues become Grip tickets automatically. The contract is [`docs/kita-grip-support-sync.md`](../docs/kita-grip-support-sync.md).

**Nothing this service does is visible to customers.** It writes only to Grip and, in Chatwoot, only **private notes** and **labels**. The bridges never forward private messages.

## Architecture

```
Chatwoot account webhook ──> Caddy /grip-sync/* ──> grip-sync:8080  POST /chatwoot/webhook
 (message_created,                                   │ 1. verify HMAC signature, dedupe X-Chatwoot-Delivery
  conversation_created,                              │ 2. ingest(): fold the event into a local snapshot (SQLite), enqueue jobs, 200
  conversation_status_changed,                       ▼
  conversation_updated)                   durable job queue (SQLite /data), runner ticks every 1s
                                            sync:<id>          POST  internal.kita.ai/api/v1/support/conversations
                                            classify:<id>      Claude (claude-sonnet-5, JSON schema) → POST /api/v1/support/tickets
                                            announce:<id>      Chatwoot private note (ticket link) + label `ticket`
                                            note:<id>          Chatwoot private note (priority escalated)
                                            ticket_status:<id> PATCH /api/v1/support/tickets/:id {done|todo|dismissed}
```

Like `kita-bridges`, it is **Node 24 + TypeScript with no dependencies**: Node strips the types, and `fetch`, `node:sqlite` and `node:test` are built in. There is no install step and no build step.

### Design choices

* **Ack first, work later.** Chatwoot account webhooks are fire-and-forget: 5s timeout, no retry (`Webhooks::Trigger#handle_failure` only logs). So the handler does only local work before answering 200:
  * verify the signature;
  * fold the payload into a SQLite snapshot of the conversation;
  * enqueue jobs.
  All network calls happen later in the job runner, and a Grip or Claude outage never loses an event.
* **Jobs are keyed per conversation and read the latest snapshot when they run.**
  * A burst of 10 events costs one Grip upsert.
  * A retry that lands late still sends current state, never stale state.
  * Every upsert bumps a job `version`. A run that was overtaken by newer events never deletes the newer job.
* **Retries.** Network errors, 408, 425, 429 and 5xx are retried with exponential backoff and jitter (5s, 10s, 20s … up to 1h), for at most 10 attempts. Any other 4xx marks the job `dead` (kept in the `jobs` table with `last_error`). The next event for that conversation revives it.
* **Idempotency.**
  * Webhook deliveries are deduped by `X-Chatwoot-Delivery`.
  * Messages are deduped by message id, so a replay never double-counts `message_count`.
  * Grip upserts tickets by `chatwoot_conversation_id`, so a retried create can't make a second ticket. Locally, only the single-flight classify job creates tickets.
  * The note and the label are flagged separately. A retry after a partial failure never posts the note twice.
* **Conversation state is tracked from webhooks.** This covers `message_count`, last message, last customer message, the preview, and who spoke last. Only public messages count: incoming = customer; outgoing or template = Kita. Private notes and activities are ignored. `message_count` counts messages seen since the service started watching the conversation.
* **waiting_on:**
  * `none` if the conversation is resolved or has no messages;
  * `kita` if the customer spoke last;
  * `customer` if Kita spoke last.
  Grip derives `accounts.support_status` from this.
* **channel_key:**
  * Uses the conversation custom attribute `channel_key` set by kita-bridges.
  * Otherwise, for native WhatsApp inboxes (`Channel::Whatsapp`, or Twilio's WhatsApp medium), it's `whatsapp:<E.164>` from the contact phone, with the WhatsApp `source_id` as a fallback.
  * Phones without a leading `+` are never guessed into a country code.
  * Conversations with no key (web widget, email…) are not synced; the service logs `no_channel_key`.
  * `channel_label` is the `channel_label` custom attribute if the bridge sets one, otherwise the contact name.
* **Automatic tickets** (contract section "Tickets: fully automatic"):
  1. A public customer message in a non-resolved conversation (re)arms a trailing debounce: 60s after the last message, capped at 300s after the first unclassified one.
  2. The classify job skips the call if no customer message arrived since the last classification. Otherwise it sends the last 40 public messages plus any existing ticket to Claude:
     * `POST /v1/messages`, model `claude-sonnet-5`, `effort: low`;
     * `output_config.format` = JSON schema `{is_issue, title, priority, summary}`.
     The transcript is wrapped in `<thread>` and treated as data.
  3. If it's an issue and there's no ticket yet: `POST /support/tickets`, then a private note with the Grip link, then label `ticket`.
  4. If a ticket exists, the same upsert updates the title, summary and priority. Priority only ever goes **up** automatically; an escalation adds a short private note. The classifier never closes tickets.
  5. When the conversation resolves, the ticket goes to `done`. When it reopens (`open`/`pending`), the ticket goes to `todo`. Snoozed changes nothing.
  6. When label `not-a-ticket` is added:
     * the pending classification is cancelled;
     * the ticket (if any) is PATCHed to `dismissed`;
     * the conversation is marked dismissed **forever**, even if the label is later removed;
     * the dismissal is written to the `dismissals` table (ticket title, priority, summary and the thread) for prompt tuning, plus a `ticket_dismissed` log line.
  7. The dismissal state is checked again after the Claude call and after the ticket POST, so a `not-a-ticket` that lands mid-flight still wins.
* **Loop safety.** The service's own notes come back as `message_created` with `private: true` and are ignored for counting and classification. The `ticket` label comes back as `conversation_updated` and changes nothing.
* **Logs contain ids and event kinds only**, never message bodies or tokens. Message text lives only in the local SQLite volume (last 40 public messages per conversation) so the classifier has context.

Endpoints (Caddy strips `/grip-sync`): `POST /chatwoot/webhook` and `GET /healthz`, which reports which parts are enabled.

### Signature

Account webhooks **are** signed. `WebhookListener#deliver_account_webhooks` passes `webhook.secret` to `Webhooks::Trigger`, which sends:

```
X-Chatwoot-Timestamp: <unix seconds>
X-Chatwoot-Signature: sha256=HEX(HMAC_SHA256(webhook secret, "<timestamp>.<raw body>"))
X-Chatwoot-Delivery:  <uuid>
```

The service rejects missing or incorrect signatures, and any timestamp more than 5 minutes from now, with `401`. If `CHATWOOT_WEBHOOK_SECRET` is empty, it rejects everything. No secret path token is needed.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `CHATWOOT_WEBHOOK_SECRET` | none (required) | Secret of the account webhook; verifies every delivery |
| `CHATWOOT_API_TOKEN` | none (needed for tickets) | Agent bot (or admin) access token, used for private notes and labels |
| `CHATWOOT_BASE_URL` | `http://rails:3000` | Chatwoot API base inside compose |
| `CHATWOOT_PUBLIC_URL` | `https://support.internal.kita.ai` | Used to build `chatwoot_url` links |
| `GRIP_BASE_URL` | `https://internal.kita.ai` | Grip |
| `GRIP_API_KEY` | none (required) | `grip_…` service key (Bearer) |
| `ANTHROPIC_API_KEY` | none (needed for tickets) | Claude API key |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Classifier model |
| `CLASSIFY_DEBOUNCE_SECONDS` / `CLASSIFY_MAX_WAIT_SECONDS` | `60` / `300` | Debounce window and its cap |
| `AUTO_TICKETS` | `true` | `false` = sync conversations only |
| `GRIP_SYNC_DB_PATH`, `PORT`, `LOG_LEVEL` | `/data/grip-sync.sqlite`, `8080`, `info` | |

If `GRIP_API_KEY` is missing, nothing is synced. If the Anthropic key or the Chatwoot token is missing (or `AUTO_TICKETS=false`), conversations still sync but no tickets are made. `/healthz` shows `{webhook, grip, tickets}`.

## Run and test locally

```bash
cd kita-grip-sync
npm test                       # node --test, no install step (Node >= 24)
cp .env.example .env && node src/server.ts
```

The tests use recorded Chatwoot webhook payloads (`test/fixtures/`) and one injected `fetch` that stubs Grip, the Chatwoot API and Claude. No network is involved. They cover:
* channel_key derivation;
* waiting_on;
* debounce and its cap;
* ticket create-once, update and escalation;
* resolve and reopen;
* dismissal before and after a ticket exists;
* loop safety;
* retries, backoff and dead jobs;
* signature checks over real HTTP.

## Setup checklist

Deploy follows the repo rule: merge to `main` and push first. Then `docker compose -f docker-compose.kita.yaml up -d --build grip-sync caddy`.

### 1. Grip: mint a `grip_` service key

Grip stores only the SHA-256 hex digest of each key in `public.service_api_keys` (migration `062_service_api_keys.sql`). `apps/web/src/lib/auth.ts` hashes the full bearer token, including the `grip_` prefix, and looks it up. Generate the key locally so the plaintext never reaches SQL history:

```bash
KEY="grip_$(openssl rand -hex 32)"
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)
echo "GRIP_API_KEY=$KEY"      # → kita-grip-sync/.env on the server (and your password manager). Shown once.
echo "$HASH"
```

Then, in the Supabase SQL editor for the Grip project:

```sql
insert into public.service_api_keys (name, email, key_hash)
values ('kita-grip-sync', 'grip-sync@usekita.com', '<HASH>');
-- revoke: update public.service_api_keys set revoked_at = now() where name = 'kita-grip-sync';
```

(`email` is the identity Grip attributes the writes to; use whichever service address you use for the other bots.) Grip must already have the support migration and the `/api/v1/support/*` routes from the contract deployed.

### 2. Chatwoot: agent bot token (for private notes and labels)

1. Go to Settings → Bots → **Add bot**. Name it `Kita Grip Sync`. Leave the webhook URL empty.
2. **Do not connect it to any inbox.** A connected bot takes over new conversations as `pending`.
3. Open the bot and copy its **access token**. That is `CHATWOOT_API_TOKEN`.

Agent bot tokens may call `messages#create` and `labels#index/create` (`AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS`), which is all this service uses. Notes show up authored by "Kita Grip Sync". Alternatively, use an administrator's access token from Profile settings.

4. Create the labels `ticket` and `not-a-ticket` (Settings → Labels) so agents can pick `not-a-ticket` from the sidebar.

### 3. Chatwoot: account webhook

1. Go to Settings → Integrations → Webhooks → **Add new webhook**.
2. Set the URL to `https://support.internal.kita.ai/grip-sync/chatwoot/webhook`. Use the public URL: Chatwoot's `SafeFetch` blocks private addresses such as `http://grip-sync:8080` unless `SAFE_FETCH_ALLOW_PRIVATE_NETWORK` is set.
3. Select these events: **Conversation Created**, **Conversation Status Changed**, **Conversation Updated**, **Message Created**.
4. Save. Copy the webhook **secret** (shown after creating, or through the edit form's copy button) into `CHATWOOT_WEBHOOK_SECRET`.

### 4. Anthropic key

Create a key for the Kita workspace in the Anthropic Console (console.anthropic.com → API keys) and name it `kita-grip-sync`. Put it in `ANTHROPIC_API_KEY`. The service calls `https://api.anthropic.com/v1/messages` with `claude-sonnet-5`, at most once per batch of customer messages.

### 5. Verify

* `curl https://support.internal.kita.ai/grip-sync/healthz` should return `{"ok":true,"webhook":true,"grip":true,"tickets":true}`.
* Send a test message in a bridged Slack channel. Within a few seconds `docker compose logs grip-sync` shows `conversation_synced`, and after about 60s `classified`.
* To inspect state: `docker compose exec grip-sync node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/grip-sync.sqlite');console.log(d.prepare('select key,attempts,dead,last_error from jobs').all())"`.
