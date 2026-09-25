# kita-grip-sync

Keeps Grip (internal.kita.ai) in step with the support desk (support.internal.kita.ai). Every Chatwoot conversation becomes a `support_conversations` row in Grip, which rolls up into each account's support status. Customer issues become Grip tickets automatically, **one per thread**, and every thread gets a short AI title on the desk. The contract is [`docs/kita-grip-support-sync.md`](../docs/kita-grip-support-sync.md).

**Nothing this service does is visible to customers.** It writes only to Grip and, in Chatwoot, only **private notes** and **labels**. The bridges never forward private messages.

## Architecture

```
Chatwoot account webhook ──> Caddy /grip-sync/* ──> grip-sync:8080  POST /chatwoot/webhook
 (message_created,                                   │ 1. verify HMAC signature, dedupe X-Chatwoot-Delivery
  conversation_created,                              │ 2. ingest(): fold the event into a local snapshot (SQLite), enqueue jobs, 200
  conversation_status_changed,                       ▼
  conversation_updated)                   durable job queue (SQLite /data), runner ticks every 1s
                                            sync:<id>          POST  internal.kita.ai/api/v1/support/conversations
                                            classify:<id>:<root>      Claude or OpenAI (JSON schema) → POST /api/v1/support/tickets {issue_key}
                                            thread:<id>:<root>        desk POST /api/v1/kita/threads {title, ticket link/priority/status/owner}
                                            announce:<id>:<key>       Chatwoot private note (thread title + ticket link) + label `ticket`
                                            note:<id>:<key>           Chatwoot private note (priority escalated / new issue)
                                            ticket_status:<id>        PATCH /api/v1/support/tickets/:id {done|dismissed, all: true}
                                            ticket_status:<id>:<key>  PATCH /api/v1/support/tickets/:id {todo, issue_key}
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
  * Grip upserts tickets by `(chatwoot_conversation_id, issue_key)`, so a retried create can't make a second ticket. Locally, only the single-flight classify job of a thread creates its ticket.
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
* **Automatic tickets, one per thread** (contract section "Tickets: fully automatic, one per thread"). A desk conversation is one customer: every bridged channel and many threads. A message's **thread root** is `content_attributes.in_reply_to` for replies, else the message itself; `issue_key = String(root desk message id)`.
  1. A public customer message in a non-resolved conversation (re)arms a trailing debounce **for its thread** (`classify:<conversation>:<root>`): 60s after the last message, capped at 300s after the first unclassified one.
  2. The classify job skips the call if no customer message arrived in that thread since its last classification. Otherwise it sends the thread (root + latest 40 replies) plus the thread's existing ticket to the classifier (Anthropic when `ANTHROPIC_API_KEY` is set, else OpenAI; both with a strict JSON schema `{is_issue, is_new_issue, title, priority, summary, thread_title}`).
     The transcript is wrapped in `<thread>` and treated as data. Each line carries the sender's name; replies are marked `(thread reply)`.
  3. **Thread title.** `thread_title` (3–6 words, e.g. "Batch 14 scores missing") comes back on every classification, issue or not. When it changed, or the thread's ticket link changed, a `thread` job posts `POST {CHATWOOT_BASE_URL}/api/v1/kita/threads` (header `X-Kita-Bridge-Secret: $BRIDGE_LINK_SECRET`) with `{conversation_id, root_message_id, title, ticket_id?, ticket_url?, ticket_priority?, ticket_status?, ticket_owner?, ticket_display_id?}`. Grip's `POST`/`PATCH /support/tickets` responses may carry `display_id` (e.g. `KT-142`), `priority`, `status`, `assignee_name` and `assignee_email`; they are kept per ticket (`tickets.grip`) and win when present. Otherwise priority and status are what this service last set (status in Grip's words: `open`, `resolved`, `dismissed`) and the owner is the account's DRI. Owner and display id are always sent, `null` when unknown, so a cleared value clears in the desk. The desk shows no SLA, so Grip's `sla_due_at` is not forwarded. What was last posted (title + a signature of the ticket fields) is kept per thread, so an unchanged thread costs no desk call; a status change or a new DRI re-posts.
  * **Desk → Grip.** "Resolve thread and ticket" in the desk calls `POST /kita/tickets/status` here (header `X-Kita-Bridge-Secret: $BRIDGE_LINK_SECRET`, body `{conversation_id, root_message_id, status: done|todo}`; the desk reaches it at `GRIP_SYNC_INTERNAL_URL`, default `http://grip-sync:8080`). It enqueues that thread's `ticket_status` job (`PATCH {status, issue_key}`); 404 when the thread has no ticket.
  4. If it's an issue and the thread has no ticket yet: `POST /support/tickets` with `issue_key`, then a private note naming the thread (`Grip ticket created automatically for thread "…" (high): **title**` + link), then label `ticket` (once per conversation in practice: the label is read-merge-write).
  5. **Within a thread the ticket is the latest open issue:** same issue (`is_new_issue: false`): title, summary and priority update; priority only goes **up** automatically, and an escalation adds a private note. Different issue in the same thread: overwritten, priority **reset**, private note naming the previous title. The classifier never closes tickets.
  6. When the conversation resolves, **every** ticket of it goes to `done` in one `PATCH {status: 'done', all: true}`. Reopening does not flip tickets back: a thread's next classification decides. If its new customer messages are an issue, that thread's done ticket is overwritten, set to `todo` (`PATCH {status: 'todo', issue_key}`), and a "ticket reopened" note is posted. Snoozed changes nothing.
  7. When label `not-a-ticket` is added (still **conversation-wide**; per-thread dismissal is future work):
     * every pending thread classification is cancelled;
     * every ticket of the conversation is PATCHed `{status: 'dismissed', all: true}`;
     * the conversation is marked dismissed **forever**, even if the label is later removed;
     * each dismissed ticket is written to the `dismissals` table (issue key, title, priority, summary and its thread) for prompt tuning, plus a `ticket_dismissed` log line.
  8. **Local state:** `tickets` is keyed by `(conversation_id, issue_key)` and `threads` by `(conversation_id, root_id)`. Older databases migrate in place on start: the one ticket per conversation keeps issue key `''` (Grip's default ticket, sent without `issue_key`; closed by the next resolve, never reused), and old messages become their own thread roots.
  9. The dismissal state is checked again after the Claude call and after the ticket POST, so a `not-a-ticket` that lands mid-flight still wins.
* **Out-of-scope accounts.** Grip's `POST /support/conversations` answers `in_scope: boolean`, flat or inside Grip's `{ success, data }` envelope (false when the linked account isn't on Grip's Customers page: paused, closed, or no pilot). kita-bridges already drops messages from channels Grip lists as out of scope; this catches what slips through, e.g. a brand-new channel that auto-linked to a paused account.
  * On the first `in_scope: false` for a conversation: the pending classification is cancelled, the conversation is resolved (`POST …/conversations/:id/toggle_status {status: resolved}`) and gets label `out-of-scope` (read-merge-write, existing labels kept). No note, no ticket, and it is never classified while out of scope.
  * Once per conversation: a flag in SQLite means later messages don't resolve or relabel it again (if the customer writes again, Chatwoot reopens it and it stays open). Both calls are idempotent, so a retried job is safe.
  * If Grip later answers `in_scope: true` (the account became Active or Pending), the block is lifted and new customer messages classify again. The conversation is **not** reopened and the label is left as history.
  * A Grip that doesn't send `in_scope` yet changes nothing.
* **Owner in the desk.** Grip's `POST /support/conversations` also answers `dri_email`, `dri_name`, `sales_owner_email` and `account_name` (flat or in `{ success, data }`). After each upsert that carries them, an `owner:<id>` job (`src/owner.ts`):
  * sets conversation custom attributes through `POST …/conversations/:id/custom_attributes` with `merge: true` (so `channel_key` and the other bridge attributes are kept): `account_owner` (DRI name, else email), `account_owner_email`, `sales_owner`, `grip_account`. What was last written is kept in SQLite (`owners` table) and **only changed keys are sent**; an unchanged conversation costs no Chatwoot call. Empty values are skipped, never cleared.
  * assigns the conversation (`POST …/assignments {assignee_id}`) to the Chatwoot agent whose email matches `dri_email` (case-insensitive). The agent list (`GET /agents`) is cached for `AGENTS_REFRESH_SECONDS` (a miss refreshes at most once a minute).
  * assigns **only** when the conversation is unassigned or still assigned to the agent this service assigned (tracked in SQLite). Before assigning it reads the live assignee (`GET …/conversations/:id`), so a human's reassignment is never overridden; that decision is remembered, so it is not re-checked until the DRI changes.
  * a DRI who isn't a Chatwoot agent still gets the attributes, and `dri_not_agent` is logged. Out-of-scope conversations (`in_scope: false`) get the attributes but are never assigned.
  * token scope: the agent bot token may call `conversations#show/custom_attributes` and `assignments#create`, but **not** `agents#index` or `custom_attribute_definitions`. Set `CHATWOOT_ADMIN_TOKEN` (an administrator's access token) for those. Without it, attributes are still written, assignment is skipped and `agents_unavailable` is logged once.
  * the attribute definitions are created on first use if the admin token allows it; otherwise `attribute_definitions_missing` is logged and you create them once (Setup checklist, step 2b).
* **Loop safety.** The service's own notes come back as `message_created` with `private: true` and are ignored for counting and classification. The `ticket` label comes back as `conversation_updated` and changes nothing.
* **Logs contain ids and event kinds only**, never message bodies or tokens. Message text lives only in the local SQLite volume (last 500 public messages per conversation) so the classifier has context.

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
| `OPENAI_API_KEY` / `OPENAI_MODEL` | none / `gpt-5-mini` | Classifier when no Anthropic key is set |
| `BRIDGE_LINK_SECRET` | none (needed for thread titles) | Shared secret (same as kita-bridges) for the desk's `POST /api/v1/kita/threads` |
| `CLASSIFY_DEBOUNCE_SECONDS` / `CLASSIFY_MAX_WAIT_SECONDS` | `60` / `300` | Debounce window and its cap |
| `AUTO_TICKETS` | `true` | `false` = sync conversations only |
| `CHATWOOT_ADMIN_TOKEN` | none | Administrator access token for `agents#index` + `custom_attribute_definitions` (bot tokens can't call them). Needed for owner assignment |
| `OWNER_SYNC` | `true` | `false` = no owner attributes or assignment |
| `AGENTS_REFRESH_SECONDS` | `600` | Agent list cache lifetime |
| `GRIP_SYNC_DB_PATH`, `PORT`, `LOG_LEVEL` | `/data/grip-sync.sqlite`, `8080`, `info` | |

Owner in the desk runs when the webhook, Grip and `CHATWOOT_API_TOKEN` are set and `OWNER_SYNC` isn't `false`. If `GRIP_API_KEY` is missing, nothing is synced. If the Anthropic key or the Chatwoot token is missing (or `AUTO_TICKETS=false`), conversations still sync but no tickets are made. If `BRIDGE_LINK_SECRET` is missing, tickets still work but no thread titles or ticket links reach the desk. `/healthz` shows `{webhook, grip, tickets, owners, threads}`.

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
* one ticket per thread: distinct `issue_key`s in one conversation, per-thread transcripts, notes naming the thread, titles + ticket links posted to the desk with the secret, title re-posted only when it changed, resolve as one `all: true` PATCH;
* migration of an old one-ticket-per-conversation database;
* a new distinct issue overwriting the ticket (priority reset), sender names and thread-reply markers in the transcript;
* resolve, bare reopen (ticket stays done), and reopen by a new issue (overwrite + todo);
* dismissal before and after a ticket exists;
* out-of-scope resolve + label, no classification, and recovery when back in scope;
* owner in the desk: assignment when unassigned or still on the previous DRI we set, manual reassignments kept, DRI not an agent, bot token without agents access, out-of-scope never assigned, only changed attribute values written, attribute definitions created once;
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

Agent bot tokens may call `messages#create`, `labels#index/create` and `conversations#toggle_status` (`AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS`), which is all this service uses. Notes show up authored by "Kita Grip Sync". Alternatively, use an administrator's access token from Profile settings.

4. Create the labels `ticket`, `not-a-ticket` and `out-of-scope` (Settings → Labels) so agents can pick `not-a-ticket` from the sidebar and filter on `out-of-scope`.

### 2b. Chatwoot: owner attribute definitions (one time)

The values are written without them, but the sidebar only shows attributes that have a definition. With `CHATWOOT_ADMIN_TOKEN` set the service creates them itself. Otherwise run once on the server (`docker compose -f docker-compose.kita.yaml exec rails bundle exec rails runner '…'`, account id 1):

```ruby
account = Account.find(1)
[
  ['account_owner',       'Account owner',       'Grip DRI for this account (set by kita-grip-sync)'],
  ['account_owner_email', 'Account owner email', 'Grip DRI email (set by kita-grip-sync)'],
  ['sales_owner',         'Sales owner',         'Grip sales owner email (set by kita-grip-sync)'],
  ['grip_account',        'Grip account',        'Grip account name (set by kita-grip-sync)'],
].each do |key, name, desc|
  account.custom_attribute_definitions.find_or_create_by!(attribute_key: key, attribute_model: :conversation_attribute) do |d|
    d.attribute_display_name = name
    d.attribute_display_type = :text
    d.attribute_description = desc
  end
end
```

For assignment, also set `CHATWOOT_ADMIN_TOKEN` (Profile settings → Access token of an administrator), since the bot token can't list agents.

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
