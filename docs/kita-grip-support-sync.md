# Kita support desk ↔ Grip sync: contract

Chatwoot (support.internal.kita.ai) is where every account conversation lives: Slack, Teams, WhatsApp and Viber. Grip (internal.kita.ai, repo Kita-Technologies/kita-internal) is the source of truth for accounts and tickets. A sync service, `kita-grip-sync`, listens to Chatwoot webhooks and writes to Grip through Grip's REST API, authenticated with a `grip_` service API key.

## Channel identity
Every conversation has one `channel_key`:
- `slack:<channel_id>`: a customer's shared Slack channel.
- `teams:<chat_id | channel_id>`: a Teams group chat, or a shared or guest channel.
- `whatsapp:<E.164 phone>`: a WhatsApp contact (native Chatwoot inbox).
- `viber:<user_id>`: a Viber user.

The bridge stores the key on the Chatwoot conversation as custom attribute `channel_key`. For WhatsApp, the sync service derives it from the contact's phone number.

## Grip data (additive migration)
- `support_channel_links (id, channel_key text unique, account_id uuid null → accounts, label text, platform text, created_at)`
  - Maps a channel to an account. It's managed in Grip.
  - Rows with a null `account_id` are unlinked channels that Grip shows so they can be assigned.
- `support_conversations (id, chatwoot_conversation_id int unique, account_id uuid null, channel_key text, platform text, status text /* open|pending|resolved|snoozed */, waiting_on text /* kita|customer|none */, last_message_at timestamptz, last_customer_message_at timestamptz, last_message_preview text, message_count int, chatwoot_url text, updated_at timestamptz)`
- `accounts.support_status text` (and `support_status_updated_at`), derived by Grip whenever a conversation or ticket changes:
  - `none`: the account has no conversations.
  - `ok`: every conversation is resolved or waiting on the customer, and there are no open support tickets.
  - `waiting_on_kita`: at least one open conversation where the customer spoke last.
  - `open_ticket`: at least one open support ticket.
  - `at_risk`: waiting on Kita for more than 24 business hours, or an urgent ticket is open.
  - Precedence: at_risk > open_ticket > waiting_on_kita > ok > none.
- Tickets live in Grip's `support_tickets` (Grip PR #86), one per `(chatwoot_conversation_id, issue_key)`; a null `issue_key` is the conversation's default ticket. They show on Customer Success → Tickets.
- Conversations also log to the account's activity timeline: one `activities` row per conversation, upserted and never one per message. Use type `support` (extend the type check if one exists) with metadata `{chatwoot_conversation_id, platform, status}`.

## Grip API (Bearer `grip_` service key)
- `POST /api/v1/support/conversations`: upserts by `chatwoot_conversation_id`.
  - Body: `{chatwoot_conversation_id, channel_key, platform, channel_label, status, waiting_on, last_message_at, last_customer_message_at, last_message_preview, message_count, chatwoot_url}`.
  - Grip resolves `account_id` through `support_channel_links`, creating an unlinked row if the key is unknown.
  - It upserts the timeline activity and recomputes `accounts.support_status`.
  - Returns `{account_id, support_status}`.
- `POST /api/v1/support/tickets`: upserts by `(chatwoot_conversation_id, issue_key)`.
  - Body: `{chatwoot_conversation_id, issue_key?, title, body, priority /* low|medium|high|urgent */, chatwoot_url}`. Without `issue_key` it writes the conversation's default ticket.
  - A dismissed ticket is never recreated or edited.
  - Returns `{ticket_id, ticket_url, created, dismissed, issue_key}`.
- `PATCH /api/v1/support/tickets/:chatwoot_conversation_id`: `{status, issue_key?, all?}`. `issue_key` targets one thread's ticket, `all: true` every ticket of the conversation; nothing matched is a 404. It never deletes.
- `GET /api/v1/support/channels?unlinked=true` and `PATCH /api/v1/support/channels/:id {account_id}`: linking, used by the Grip UI.

## Grip UI
- **Customers page:** show a Support status pill per account, and support that status as a filter and sort.
- **Account detail:** a Support section listing conversations (platform, last message preview, waiting on, a link out to the desk) and linked tickets.
- **Unlinked channels:** a small queue where an admin assigns each unlinked channel to an account.

## Tickets: fully automatic, one per thread
A desk conversation is one customer (a Grip account): every bridged channel (Slack, Teams, WhatsApp and Viber mirrors) posts into it, and it holds many threads. Grip ships `support_tickets` with an optional `issue_key` (Grip PR #86, `lib/support.ts` `ticketInput` / `ticketStatusInput`), and grip-sync keeps **one ticket per thread**.

1. **Thread = issue.** A message's thread root is `content_attributes.in_reply_to` for a reply (kita-bridges sets it to the desk id of the root), else the message's own desk id. `issue_key = String(root desk message id)`. Deterministic, no model involved.
2. **Classify per thread.** A new public customer message (re)arms a trailing debounce for its thread (`classify:<conversation>:<root>`, about 60s, capped at 300s). The classifier (Claude or OpenAI, whichever grip-sync is configured with, structured output) gets that thread only (root plus its latest 40 replies) and that thread's existing ticket, and returns `{is_issue, is_new_issue, title, priority, summary, thread_title}`.
3. **Ticket.** If it's an issue: `POST /api/v1/support/tickets {chatwoot_conversation_id, issue_key, title, body, priority, chatwoot_url}` (upsert by `(conversation, issue_key)`; response `{ticket_id, ticket_url, created, dismissed, issue_key}`). The first time, a Chatwoot **private note** naming the thread (`Grip ticket created automatically for thread "Batch 14 scores missing" …`) plus label `ticket`. Same issue later: title/body/priority update, priority only goes up automatically. New issue inside the same thread (`is_new_issue`): overwritten, priority reset.
4. **Thread title.** `thread_title` is a 3–6 word name (e.g. "Batch 14 scores missing"), produced for every classified thread, issue or not. grip-sync posts it to the desk: `POST {CHATWOOT_BASE_URL}/api/v1/kita/threads` with header `X-Kita-Bridge-Secret: $BRIDGE_LINK_SECRET`, body `{conversation_id, root_message_id, title, ticket_id?, ticket_url?}` (ticket fields once the thread has a ticket). It re-posts only when the title or ticket link changed.
5. **Resolve.** Resolving the conversation sets every ticket of it done in one call: `PATCH /api/v1/support/tickets/:conversation_id {status: 'done', all: true}`. A reopen alone does not reopen tickets: a thread's next customer messages are classified, and only if they are an issue is that thread's done ticket overwritten and set back to todo (`PATCH {status: 'todo', issue_key}`).
6. **Undo stays conversation-wide.** Label `not-a-ticket` dismisses every ticket of the conversation (`PATCH {status: 'dismissed', all: true}`) and stops auto-ticketing for the whole conversation. Per-thread dismissal (a thread-level action in the desk) is future work. Each dismissal is logged locally for prompt tuning.
7. **Legacy tickets.** A conversation's ticket from before per-thread tickets is kept locally with issue key `''` (Grip's default ticket, sent without `issue_key`). It is closed by the next resolve (`all: true`) and never reused for a new thread.
8. Idempotency and cost: classify at most once per new batch of customer messages per thread; skip conversations labelled `not-a-ticket` or out of scope.
