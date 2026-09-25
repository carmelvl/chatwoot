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
3. If a ticket already exists, later messages update it through the same upsert and never create a duplicate. Since kita-bridges keeps one conversation per Slack channel, Teams channel or Teams group chat (Viber and WhatsApp are already one per chat), the single ticket describes the **latest open issue**: the classifier also returns `is_new_issue`. Same issue: title, body and priority update, and priority only goes up automatically. New issue: title and body are overwritten and priority is reset to the new issue's own.
4. When the conversation is resolved, the ticket is set to done. A reopen alone does not reopen the ticket: the next customer messages are classified, and only if they are an issue is the done ticket overwritten with it and set back to todo.
5. Undo: if an agent adds label `not-a-ticket`, the ticket is set to status `dismissed` and the conversation is never auto-ticketed again. Log each dismissal so the classifier prompt can be tuned.
6. Idempotency and cost: classify at most once per new batch of customer messages (debounce about 60s per conversation), and skip conversations labelled `not-a-ticket`.

## Next: one ticket per issue (Grip change, not yet built)

Today Grip holds at most one support ticket per conversation, so on a per-channel conversation earlier issues are overwritten (see Tickets, step 3). To keep one ticket per distinct issue, Grip keys tickets by `(chatwoot_conversation_id, issue_key)`.

### Data (additive migration)
Assumptions: tickets stay in `team_tasks` with `source = 'support'` and the unique index from the section above exists. The index name below is assumed; use the real one.

```sql
alter table team_tasks add column support_issue_key text;               -- null = the conversation's legacy/default ticket
drop index if exists team_tasks_support_conversation_uidx;               -- unique (chatwoot_conversation_id) where source = 'support'
create unique index team_tasks_support_issue_uidx
  on team_tasks (chatwoot_conversation_id, coalesce(support_issue_key, ''))
  where source = 'support';
create index team_tasks_support_conversation_idx
  on team_tasks (chatwoot_conversation_id) where source = 'support';     -- list tickets per conversation
```

Existing rows keep `support_issue_key = null`, which is the same slot a request without `issue_key` writes to. No backfill is needed.

### API
- `POST /api/v1/support/tickets`
  - Body gains an optional `issue_key` (string, at most 200 chars): `{chatwoot_conversation_id, issue_key?, title, body, priority, chatwoot_url}`.
  - Upserts by `(chatwoot_conversation_id, coalesce(issue_key, ''))`. When `issue_key` is absent or null, the behaviour is exactly today's: one ticket per conversation.
  - Returns `{ticket_id, ticket_url, issue_key, created: boolean}`. `created` tells grip-sync whether to post the "ticket created" note.
- `PATCH /api/v1/support/tickets/:chatwoot_conversation_id`: `{status, issue_key?}`.
  - With `issue_key`, it changes only that ticket.
  - Without it, it keeps today's meaning for the null-key ticket. It also accepts `{status: 'done', all: true}` so a conversation resolve closes every open ticket of the conversation.
  - Unknown `(conversation, issue_key)` returns `404`, which grip-sync treats as non-retryable.
- `accounts.support_status` counts every open support ticket of the account, so no rule changes.
- Account detail lists several tickets per conversation. Group them under the conversation, newest first.

### How grip-sync derives `issue_key`
1. **Slack or Teams thread root, when there is one.** A message with `content_attributes.external_thread.root` (or `in_reply_to`) belongs to the issue `thread:<root>`. A top-level message that later gets replies is its own root (`thread:<its platform ts/id>`, which kita-bridges sends as `external_thread.root` on the root as well). One thread is one issue, which is deterministic and needs no model.
2. **Otherwise (top-level channel messages, Viber, WhatsApp) the classifier decides.** The classifier gets the conversation's open tickets (`issue_key`, title, summary) and returns `{is_issue, is_new_issue, issue_key_ref, title, priority, summary}`. `issue_key_ref` is one of the given keys when it continues an open issue. When `is_new_issue` is true, grip-sync mints `msg:<chatwoot message id of the first customer message of the new issue>`. The key is stable because it is minted once, stored locally (grip-sync `tickets` table keyed by `(conversation_id, issue_key)`) and never re-derived from text.
3. Resolving a conversation marks all of its tickets done. A new message after that starts a new issue unless the classifier points at an existing key.
4. `not-a-ticket` dismisses the tickets of the whole conversation, as today. Per-issue dismissal needs a separate label or action later.

### Rollout order
1. Grip: ship the migration and the optional `issue_key` on both endpoints. With no `issue_key` nothing changes, so it is safe to deploy first.
2. kita-bridges: make sure `external_thread.root` is set on thread roots as well as on replies. The bridge change already sends it on replies.
3. grip-sync: store tickets per `(conversation, issue_key)`, send `issue_key`, and switch resolve to `{status: 'done', all: true}`. The existing null-key ticket of each conversation stays the "legacy" issue; it is closed on the next resolve and never reused for a new issue.
4. Grip UI: list several tickets per conversation.
