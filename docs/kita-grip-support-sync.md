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
- Tickets reuse `team_tasks`: `source = 'support'`, plus columns `chatwoot_conversation_id int`, `account_id uuid`, `support_priority text`. Add a unique index on `chatwoot_conversation_id` where `source = 'support'` (one ticket per conversation). Do NOT add a new tickets table.
- Conversations also log to the account's activity timeline: one `activities` row per conversation, upserted and never one per message. Use type `support` (extend the type check if one exists) with metadata `{chatwoot_conversation_id, platform, status}`.

## Grip API (Bearer `grip_` service key)
- `POST /api/v1/support/conversations`: upserts by `chatwoot_conversation_id`.
  - Body: `{chatwoot_conversation_id, channel_key, platform, channel_label, status, waiting_on, last_message_at, last_customer_message_at, last_message_preview, message_count, chatwoot_url}`.
  - Grip resolves `account_id` through `support_channel_links`, creating an unlinked row if the key is unknown.
  - It upserts the timeline activity and recomputes `accounts.support_status`.
  - Returns `{account_id, support_status}`.
- `POST /api/v1/support/tickets`: upserts by `chatwoot_conversation_id`.
  - Body: `{chatwoot_conversation_id, title, body, priority /* low|medium|high|urgent */, chatwoot_url}`.
  - Creates or updates the `team_tasks` row and recomputes the status.
  - Returns `{ticket_id, ticket_url}`.
- `PATCH /api/v1/support/tickets/:chatwoot_conversation_id`: `{status}`. Called when the conversation resolves or reopens; it never deletes.
- `GET /api/v1/support/channels?unlinked=true` and `PATCH /api/v1/support/channels/:id {account_id}`: linking, used by the Grip UI.

## Grip UI
- **Customers page:** show a Support status pill per account, and support that status as a filter and sort.
- **Account detail:** a Support section listing conversations (platform, last message preview, waiting on, a link out to the desk) and linked tickets.
- **Unlinked channels:** a small queue where an admin assigns each unlinked channel to an account.

## Tickets: fully automatic
1. On a new customer message in an open conversation, the sync service asks Claude (`claude-sonnet-5`, structured output) to classify it. It looks at the recent thread plus any existing ticket, and returns `{is_issue, title, priority, summary}`. An issue is a bug, a request, or something blocking the customer.
2. If it's an issue and the conversation has no ticket yet, the sync service creates it with `POST /support/tickets`. It then posts a Chatwoot **private note** with the Grip ticket link and adds label `ticket`. Customers never see private notes.
3. If a ticket already exists, later messages update its body and priority (for example, escalate to urgent) through the same upsert. They never create a duplicate.
4. When the conversation is resolved, the ticket is set to done. When it reopens, the ticket reopens.
5. Undo: if an agent adds label `not-a-ticket`, the ticket is set to status `dismissed` and the conversation is never auto-ticketed again. Log each dismissal so the classifier prompt can be tuned.
6. Idempotency and cost: classify at most once per new batch of customer messages (debounce about 60s per conversation), and skip conversations labelled `not-a-ticket`.
