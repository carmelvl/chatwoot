# kita-bridges

Lets customers talk to Kita natively in **Slack** (Slack Connect / shared channels), **Microsoft Teams**, **Viber** and **WhatsApp**. Every conversation lands in Chatwoot (the internal desk). For Slack and Teams, agent replies go back out on the same channel and thread, always from the agent's own connected account. **WhatsApp and Viber are mirrors**: the desk shows the conversations and centralises notifications, but it never sends there; people reply in the apps themselves.

**Customers never see Chatwoot.**
* Replies come from **the Kita team member who wrote them** (see [Who replies are from](#who-replies-are-from)). There's no "via" text and there are no Chatwoot links. Customers install nothing.
* Agent attachments are sent as native Slack files or Teams inline images. Any remaining file link points at the bridge's own `…/bridges/media/<random token>/<file>`, never at a Chatwoot URL.
* CSAT surveys and Chatwoot interactive messages are never forwarded.
* Contacts are created with no email or phone, so the desk can't email them. See [No emails to customers](#no-emails-to-customers).

## Why a bridge (and not a Chatwoot patch)

* Chatwoot has no Teams or Viber channel. Its Slack integration (`lib/integrations/slack/*`) goes the other way: Chatwoot posts each conversation into **one** Kita Slack channel so agents can reply from Slack. It only reads thread replies to threads that Chatwoot itself started (`Integrations::Hook.find_by(reference_id: channel)`, conversation found by `thread_ts`). Those replies become agent messages or private notes. It never takes in customer messages from shared channels.
* The upstream way to add a channel is an **API channel inbox** (`Channel::Api`). Messages come in through the public inbox API. Agent replies go out through the inbox webhook, signed `X-Chatwoot-Signature: sha256=HMAC(secret, "ts.body")` (`lib/webhooks/trigger.rb`). No core changes are needed, so upstream merges stay clean.
* **Node 24 + TypeScript, no dependencies.** Node runs `.ts` natively (type stripping) and includes `fetch`, `node:sqlite` and `node:test`. That means no `npm install`, no build step, a small image and a codebase you can audit in one sitting. Ruby would have meant a second Gemfile or a gem-heavy Microsoft SDK stack.

```
Slack Events API ─┐                        ┌─> POST /public/api/v1/inboxes/<id>/contacts|conversations|messages
Teams (Graph)     ├─> Caddy /bridges/* ─> bridges:8080 ─┤              (one API-channel inbox per platform)
Viber webhook ────┘         ▲              └─ SQLite /data: contacts, thread→conversation, reply refs, dedupe keys
                            └── Chatwoot API-inbox webhook (message_created, outgoing, non-private) ─> Slack thread / Teams thread or chat (as the Kita user)
```

| Platform | Contact identifier | Conversation = | Reply target |
|---|---|---|---|
| Slack | `slack:<user id>` per person; the channel is `slack-channel:slack:<channel id>` | one **channel** (threadKey = channel id). A resolved conversation is reopened by the next message, never replaced. | "Reply to" a message in the desk → `chat.postMessage` with `thread_ts` = that message's thread root; a plain reply → a new top-level channel message. Only as the agent (their own token); files via `files.completeUploadExternal` |
| Teams | `teams:<Entra user id>` per person; the channel/chat is `teams-channel:teams:<id>` | one **channel** (team + channel) or one **group chat**, reopened (not replaced) after resolution. | "Reply to" → Graph `POST …/messages/{root}/replies`; a plain reply → `POST …/channels/{id}/messages` (new post); chats → `POST /chats/{id}/messages`. Only as the agent (their own token); plain HTML, Adaptive Card only as a fallback |
| Viber | `viber:<user id>` | the user (Viber bots are 1:1) | none: mirror only, the desk never sends |

Endpoints (Caddy strips `/bridges`): `POST /slack/events`, `POST /teams/notifications` + `POST /teams/lifecycle` (Graph change and lifecycle notifications), `GET /teams/connect?key=…` + `/teams/connect/callback` (one-time sign-in), `POST /viber/webhook`, `GET|POST /whatsapp/webhook` (Cloud API; handshake + signed events), `POST /chatwoot/whatsapp/<phoneNumberId>`, `GET /connect` (+ `/connect/{slack,teams}/start`, `/connect/slack/callback`), `POST /chatwoot/{slack,teams,viber}`, `GET /media/<token>/<name>` (attachment proxy, expires after `MEDIA_TTL_DAYS`), `GET /healthz`.

**Safety and correctness**
* Every inbound request is verified before it's processed:
  * Slack: v0 HMAC, with a 5-minute replay window.
  * Teams: Graph validation-token handshake when a subscription is created, then a per-subscription random `clientState` (constant-time compare) on every notification. Unknown subscriptions or a wrong `clientState` are dropped before anything is fetched, and the message itself is always re-read from Graph with Kita's token.
  * Viber: HMAC of the raw body.
  * Chatwoot: inbox secret HMAC, with a 5-minute window.
* Loop prevention:
  * Only `message_created` + `outgoing` + non-private + `content_type: text` messages are sent out, and anything containing a `/survey/responses/` link is dropped.
  * Greeting and out-of-office messages are `template` messages and are never forwarded.
  * Everything the bridge writes is `incoming`, so it can never echo back.
  * Slack bot messages and the bot's own user are ignored.
  * Kita staff in shared channels (`SLACK_INTERNAL_TEAM_IDS`) are ignored.
  * Teams: messages from the Kita user, from Kita staff (members of `TEAMS_INTERNAL_TENANT_IDS`), from apps, and system events are ignored. Guests in Kita's tenant (`userType: Guest`) and users from other tenants count as customers. The ids of messages the bridge posts are also pre-marked as seen.
* Idempotency: platform retries are de-duplicated by event id (Slack `event_id`, Teams chat/channel + message id, Viber `message_token`, which is read from the raw body because it's 64-bit). Chatwoot webhook retries are de-duplicated by message id. A failed step releases its key so the retry can succeed.
* Outbound is synchronous: if a send fails, Chatwoot shows the agent's message as **failed**.
* **Who wrote each message.** A Slack/Teams conversation's contact is the channel itself ("#kita-tala"). Every message is authored by the person who wrote it: each speaker gets their own contact (name, and Slack profile photo as avatar) and the message is posted with `sender_identifier` (a Kita addition to Chatwoot's public inbox API: the sender must be a contact of the same inbox). No `**Name:**` prefixes.
* **Threads.** Every message the bridge creates carries `content_attributes.external_source` (`slack`/`teams`/`whatsapp`/`viber`, shown as a badge on the sender's avatar) and `external_thread.root` (the thread root, `<channel>:<ts>` / `<channel id>:<message id>`). A thread reply also carries `in_reply_to` = the desk message id of its root, so the desk shows the quoted parent with Chatwoot's native reply UI, and a "Thread · N replies" chip under the root. The bridge keeps platform id ↔ desk message id in the `messages` table (inbound messages and the agent replies it posts).
* **Store migration.** Before per-channel conversations, Slack/Teams rows in `conversations` were keyed per thread (`<channel>:<root ts>`, `channel:<team>:<channel>:<root>`). Those rows are test data: they are left alone and simply no longer matched; new messages use the channel keys and open one new conversation per channel.
* Attachments:
  * Inbound files (Slack `files:read`, Teams file/inline image, Viber media) are copied into Chatwoot. If a download fails, the link is added to the message instead of dropping it (agents see it; customers never do).
  * Outbound, Slack uploads native files (as the agent when connected). Teams embeds images inline (`hostedContents`, up to 3 MB) and sends other files as a named link to the bridge media URL.
* Logs contain ids only, never message bodies or tokens.

## Grip scope: only Customers-page accounts reach the desk

The desk only shows channels whose account is on Grip's **Customers** page (Active or Pending). The bridge asks Grip which channels are out of scope and drops their messages at the door.

* **Source.** `GET {GRIP_BASE_URL}/api/v1/support/scope` with `Authorization: Bearer {GRIP_API_KEY}` (the same `grip_` key grip-sync uses) returns `{ success, data: { in_scope, out_of_scope, generated_at } }` (a bare `{ in_scope, … }` is accepted too), lists of `channel_key`s (`slack:<channel>`, `teams:<channel or chat>`, `whatsapp:<E.164>`, `viber:<user>`). `src/scope.ts` caches it and refreshes every `SCOPE_REFRESH_SECONDS` (default 300).
* **Where.** Every inbound path: Slack events, Teams Graph notifications, WhatsApp `messages` **and** `smb_message_echoes`, Viber. The key is the same `channel_key` the bridge stamps on the conversation. If it's in `out_of_scope`, the message is dropped before any Chatwoot contact or conversation is created (and, for Slack and WhatsApp, before the user lookup or media download). One `out_of_scope_dropped` info log with the platform and key only, never content. The platform still gets its 200/202, so it doesn't retry.
* **Unknown keys pass.** A channel Grip hasn't linked yet isn't in either list, so it goes through and auto-link keeps working. If it then auto-links to a paused account, grip-sync resolves that conversation and labels it `out-of-scope`.
* **Fails open.** If a refresh fails, the last good list stays in effect. With no list yet (Grip down at boot), everything is let through.
* **Disabled** when `GRIP_BASE_URL` or `GRIP_API_KEY` is blank: everything is ingested, as before.
* **Outbound is unchanged.** Agents can still reply in a conversation that's already in the desk.
* **Mid-conversation changes.** Scope is checked per message, not per conversation. When an account is paused or closed in Grip, the next refresh (within `SCOPE_REFRESH_SECONDS`) puts its channel in `out_of_scope`, and **new customer messages in conversations that are already open stop arriving in the desk**; the open conversation just goes quiet. Dropped messages are not queued or replayed. If the account becomes Active or Pending again, new messages flow again from the next refresh.

## Team in every customer channel (`src/teamsync.ts`)

Every Kita team member should be in every **in-scope** customer channel, so nobody depends on one person being there. After each successful Grip scope refresh (same `SCOPE_REFRESH_SECONDS` cadence) the bridge adds missing team members. **It only adds; it never removes anyone.**

* **Mode.** `TEAM_SYNC=off|dry-run|on`, default **`dry-run`**: it resolves everything and logs `teamsync_would_add {channel_key, emails}` without a single write call. Check that output, then set `on`.
* **Which channels.** Grip's `in_scope` list plus `channels[]` rows with `in_scope: true`, minus anything in `out_of_scope`. `whatsapp:*` and `viber:*` are 1:1 and have no membership: skipped.
* **Roster.** `TEAM_ROSTER` (comma-separated emails). If unset: every active (confirmed) Chatwoot agent from `GET /agents` (needs `CHATWOOT_API_ACCESS_TOKEN` + `CHATWOOT_ACCOUNT_ID`), excluding bots and `TEAM_ROSTER_EXCLUDE` (default `bridge@kita.ai`).
* **Skip unchanged.** SQLite kv `teamsync:<channel_key>` holds a hash of the roster, written only after the channel synced cleanly. An unchanged channel costs no API call; a roster change re-checks every channel. Dry-run uses its own key (`teamsync.dry:<key>`), so switching to `on` still does the work.
* **Slack** (`slack:<channel>`, bot token):
  1. `users.lookupByEmail` per roster email (cached per process); `users_not_found` is logged as `teamsync_slack_user_not_found` and skipped.
  2. `conversations.members` (paginated). If the bot isn't a member (or a private channel returns `channel_not_found`), `teamsync_slack_bot_not_in_channel` is logged and the channel is skipped; run `/invite @Kita` there.
  3. `conversations.invite` for each missing user, one at a time, about 1.2s apart (Tier 3). `already_in_channel` counts as success. `cant_invite`, `restricted_action`, `user_is_restricted` and similar are final for that user and logged as `teamsync_slack_cant_invite`. `ratelimited` / HTTP 429 waits `Retry-After` seconds and retries (up to 3 times).
  * **Slack Connect.** The bot can invite Kita's own internal users into a shared channel it's in. Customer orgs whose policy restricts who can add people will answer `restricted_action`/`cant_invite`; that is logged, and someone on their side, or a Kita member with rights, adds the person manually.
  * Scopes (in `manifests/slack-app-manifest.yaml`): `channels:read`, `groups:read` (members), `channels:manage`, `groups:write` (invite), `users:read.email` (lookup). **Reinstall the app** after updating the manifest so the bot token gets them.
* **Teams** (`teams:<id>`, the Kita user's delegated Graph token):
  * A channel is recognised by the bridge's own Graph subscription for it, which gives the team id. Anything else is treated as a chat.
  * **Standard channel:** membership is inherited from the team, so missing people are added to the **team** (`POST /teams/{team}/members`). Requires the Kita user to be a team **owner**.
  * **Private or shared channel:** `POST /teams/{team}/channels/{channel}/members` (Graph only allows this for `private`/`shared`). Requires the Kita user to be a channel **owner**. Only Kita-hosted channels can be managed this way.
  * **Group chat:** `POST /chats/{id}/members` with `visibleHistoryStartDateTime: "0001-01-01T00:00:00Z"` (the whole history).
  * Current members are read first (`GET …/members`) and matched by Entra user id and email; roster emails are resolved with `GET /users/{email}` (404 is logged and skipped). Adds are about 2s apart (Microsoft's recommended buffer); 429/503 wait `Retry-After`. 409 (already a member) is success.
  * **403** means the Kita user isn't an owner there (or consent is missing): `teamsync_teams_forbidden` is logged with the fix, the channel stops for this run and is retried next refresh.
  * Delegated permissions (verified against Microsoft Graph v1.0 docs, 2026-09-24):
    * `TeamMember.ReadWrite.All`: [Add member to team](https://learn.microsoft.com/en-us/graph/api/team-post-members?view=graph-rest-1.0) (least privileged is `TeamMember.ReadWriteNonOwnerRole.All`, but [List team members](https://learn.microsoft.com/en-us/graph/api/team-list-members?view=graph-rest-1.0) needs `TeamMember.Read.All` or `TeamMember.ReadWrite.All`, so one permission covers both).
    * `ChannelMember.ReadWrite.All`: [Add member to channel](https://learn.microsoft.com/en-us/graph/api/channel-post-members?view=graph-rest-1.0) (only delegated option) and [List channel members](https://learn.microsoft.com/en-us/graph/api/channel-list-members?view=graph-rest-1.0).
    * `ChatMember.ReadWrite`: [Add member to a chat](https://learn.microsoft.com/en-us/graph/api/chat-post-members?view=graph-rest-1.0) (least privileged) and [List chat members](https://learn.microsoft.com/en-us/graph/api/chat-list-members?view=graph-rest-1.0).
* **Logs.** `teamsync_would_add`, `teamsync_added`, `teamsync_done {mode, roster, channels, skipped_unchanged, added, would_add, not_applicable}`; emails and ids only.

## Run and test locally

```bash
cd kita-bridges
npm test                       # node --test, 129 tests, no install step (Node >= 24)
cp .env.example .env && node src/server.ts
```

## Deploy (for later, not done yet)

The `bridges` service is in `docker-compose.kita.yaml` and the `/bridges/*` route is in `Caddyfile.kita`. On the host: create `kita-bridges/.env` (from `.env.example`), then run `docker compose -f docker-compose.kita.yaml up -d --build bridges caddy`. Each platform stays disabled until its variables are set (`GET /bridges/healthz` lists the enabled ones). Following the deploy rule, merge to `main` and push before deploying.

## Who replies are from

**Rule: nobody can send a message to a customer platform until they have connected their own account for it. There is never a fallback to a shared Kita identity.** The Slack bot and the Kita Teams user only **listen**; they never post agent replies.

| Channel | Agent has connected their account | Not connected, or their account isn't in that channel/chat |
|---|---|---|
| Slack | Posted **as the agent** (their user token: `chat:write`, `files:write`), natively in the Slack Connect thread | **Nothing is posted.** The webhook answers 422, so the desk marks the message failed, and the agent gets a private note |
| Teams | Posted **as the agent** (their delegated Graph token: `ChannelMessage.Send`, `ChatMessage.Send`) | **Nothing is posted** (same as Slack) |
| Viber | **Never sent from the desk.** Mirror only: desk replies get a private note, "Reply in Viber yourself — this inbox is a mirror", and the desk replaces the reply box with that notice (notes still work) | same |
| WhatsApp | **Never sent from the desk.** Each teammate replies from **their own** WhatsApp Business number on their phone; those replies (`smb_message_echoes`) show in the desk as that teammate. Desk replies get "Reply in WhatsApp yourself — this inbox is a mirror" | same |

* **"Not sent" note.** When a reply is refused, the bridge adds a **private note** (agents only): "Not sent — connect your Slack account first (Profile → Connect accounts)" plus their personal connect link, or "Not sent — you're not in this channel yet" when their account can't post there (Slack `not_in_channel` and similar, Graph 403/404). Automated messages (no agent) are refused the same way on Slack and Teams. The desk also blocks the public reply box until the agent has connected (private notes stay allowed).
* **Automated messages.** Messages with no agent (automations) go out as plain Kita with no prefix.
* **Staff typing directly in Slack/Teams.** If a Kita team member writes directly in Slack or Teams, outside the desk, the bridge mirrors it into the channel's conversation as an **outgoing** message **authored by that teammate's desk user**. The desk then shows the full thread. It's never treated as a customer message and never sent back out: it's marked `kita_bridge_origin` and its desk id is pre-marked as seen.
  * Slack: members of `SLACK_INTERNAL_TEAM_IDS`. Teams: members of `TEAMS_INTERNAL_TENANT_IDS`.
  * Matching: the Slack profile email (`users:read.email`) or the Graph `mail`/`userPrincipalName` is sent to the desk's `POST /api/v1/kita/staff_messages` (header `X-Kita-Bridge-Secret` = `BRIDGE_LINK_SECRET`), which posts the message as the agent with that email in the Kita account. The bridge never holds agent tokens.
  * No matching agent (or no email): the bridge's own desk user (`CHATWOOT_API_ACCESS_TOKEN`) posts it as "**Sam Lee (in Slack):** …".
  * A channel Kita starts (no conversation yet) opens its conversation with the channel as the contact.
* **Loop safety.** The platform echo of a reply the bridge posted (from an agent's account or the bot) is dropped in three ways:
  * by the message id (and Slack file ids) the send returned;
  * for the few seconds before that id is known, by a text fingerprint of what was just sent in that thread;
  * bot-authored Slack messages and the Kita Teams user are always ignored.

### Connecting accounts (each agent, once)
* In the desk: **Profile → Connect accounts** (and a one-time "Connect your accounts" prompt after login). The desk's `GET /kita/connect` redirects the signed-in agent to their personal link, `https://support.internal.kita.ai/bridges/connect?a=<chatwoot user id>&e=<email>&x=<expiry>&s=<signature>`, signed exactly like `src/links.ts` (a shared fixture, `test/fixtures/connect-link.json`, is checked by both the Ruby and the TypeScript tests).
* The page has one card per platform: **Slack** and **Microsoft Teams** (Connect / Reconnect, or "Not available yet" while that platform isn't configured), **WhatsApp** (your Business number is linked by an admin with a QR scan; shows the number when `WHATSAPP_NUMBERS` has your `agentEmail`) and **Viber** (mirror only: reply in Viber yourself; Kita only sees conversations with the Kita Viber bot). An expired or hand-typed link shows a friendly page pointing back to the desk.
* `GET /connect/status?a=<id>&e=<email>` returns `{ slack, teams, whatsapp, viber }` as JSON for the desk (`GET /api/v1/kita/connections` proxies it). It needs `X-Kita-Bridge-Secret` = `BRIDGE_LINK_SECRET` (server to server) or a signed link's params.
* **Other ways to get the link.**
  * The bridge puts it in the private "Not sent" note the first time the agent replies without being connected.
  * An admin can also mint one: `docker compose -f docker-compose.kita.yaml exec bridges node src/connect-link.ts <chatwoot-user-id> <email> [days]`.
  * Links are HMAC-signed with `BRIDGE_LINK_SECRET` and expire after 7 days.
* **Identity check.** The account the agent signs into must match their Chatwoot email:
  * Slack: the profile email, read with the bot's `users:read.email`.
  * Microsoft: the UPN or primary mail.
* **Storage.** Tokens are stored **encrypted** (AES-256-GCM, `BRIDGE_ENCRYPTION_KEY`) in the bridge's SQLite. The Kita Teams user and every agent have separate tokens.
* **Setup.**
  * Slack: set `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`, and add the redirect URL and user scopes to the Slack app (the manifest already has them). Reinstall the app once for the new `users:read.email` bot scope.
  * Teams: nothing extra. Agents use the same Entra app and redirect URI; the admin consent already granted covers `ChannelMessage.Send` / `ChatMessage.Send` for everyone.
  * Each agent must be a **member** of the customer channels and chats they reply in. Otherwise their replies fall back to Kita and they get a note.

### WhatsApp agent names (only if you also use Chatwoot's native WhatsApp inbox)
The coexistence mirror below doesn't need this: each teammate replies from their own number. If you ever run a *shared* number through Chatwoot's native WhatsApp inbox, it's one identity. To show who replied:
1. Each agent sets a signature under Chatwoot **Profile settings → Personal message signature**, e.g. `— Carmel, Kita`.
2. In any WhatsApp conversation, turn on the **signature** toggle in the reply box. Chatwoot remembers it per channel type.

Chatwoot appends the signature at the end of the message, so it isn't a leading "Carmel:" prefix, and it's per agent rather than enforced. Leave the signature **off** for the API inboxes (Slack/Teams): replies already come from the agent's own account.

## No emails to customers

Chatwoot only emails a contact about a conversation (`Messages::SendEmailNotificationService`) if **the contact has an email** and the API inbox has email continuity turned on. The bridge never sets email or phone on the contacts it creates, and a test enforces this. On top of that, Carmel should switch off or avoid the following:

1. **Email continuity on the API channel** must stay OFF. It's the account feature `email_continuity_on_api_channel` (off by default). Check it under Super Admin → Accounts → Kita → Features.
2. **Never add an email or phone to Slack/Teams/Viber contacts.** Don't merge them into contacts that have an email either: a merged contact keeps the email, and continuity would then apply.
3. On each of the three API inboxes, turn **CSAT** off (Inbox → Settings → CSAT). The bridge drops CSAT anyway, but that way agents don't expect survey results.
4. **Greeting and out-of-office messages** are template messages and are never delivered, so leave them off on these inboxes.
5. Don't use **Send conversation transcript**, and don't add automation rules or macros with *Send email to contact / transcript*, on these inboxes.
6. Leave "Enable HMAC identity validation" off (the bridge uses the public inbox API).

## Setup per platform

### 0. Chatwoot: one API inbox per platform (repeat for Slack, Teams, Viber; WhatsApp gets one per number, see section 4)
1. Go to Settings → Inboxes → Add Inbox → **API**. Name it `Slack` / `Teams` / `Viber`, and set the Webhook URL to `https://support.internal.kita.ai/bridges/chatwoot/slack` (or `teams` / `viber`).
   Use the public URL: Chatwoot's `SafeFetch` refuses private addresses such as `http://bridges:8080`, and we don't want to turn on `SAFE_FETCH_ALLOW_PRIVATE_NETWORK`.
2. Add the agents to the inbox.
3. From the inbox's Configuration tab, copy the **Inbox identifier** and **Webhook secret** into `CHATWOOT_<PLATFORM>_INBOX_IDENTIFIER` / `CHATWOOT_<PLATFORM>_WEBHOOK_SECRET`. Leave "Enable HMAC identity validation" **off** for these inboxes.

### 1. Slack (Slack Connect / shared channels)
1. Go to api.slack.com/apps → Create New App → **From an app manifest**, pick Kita's workspace and paste `manifests/slack-app-manifest.yaml`. This is a separate app from Chatwoot's built-in Slack integration. Don't connect that integration to customer channels.
   In Basic Information → Display Information, upload the Kita app icon; that's the avatar customers see. Optionally set `SLACK_BOT_ICON_URL` to a public square PNG of the Kita mark.
2. Install to Workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`, and from Basic Information copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.
3. Put Kita's team id (`T…`, shown in the workspace URL or in `auth.test`) in `SLACK_INTERNAL_TEAM_IDS`, so staff chatter in shared channels isn't ingested. You can also limit ingestion to specific channels with `SLACK_ALLOWED_CHANNELS`.
4. Once the bridge is live, open Event Subscriptions and confirm the Request URL shows **Verified**. The bridge answers Slack's challenge.
5. In each customer's Slack Connect channel, run `/invite @Kita`. Some customer orgs restrict external apps in shared channels, and their admin may need to allow it.
6. Behaviour: each channel is one Chatwoot conversation. Thread replies show as native replies to their root; an agent's "Reply to" goes into that thread, a plain reply is a new top-level message.

### 2. Microsoft Teams (Graph, as the "Kita" user; customers install nothing)

**How it works.** Everything lives in Kita's Microsoft 365 tenant. A licensed user named **Kita** is a member of the Kita-hosted shared channels (Teams Connect, where customers join from their own tenant), of Kita-tenant channels where customers are guests, and of group chats that include customers.
* **Inbound.** The bridge holds Microsoft Graph change-notification subscriptions:
  * one for all of Kita's chats: `/users/{kita}/chats/getAllMessages`, delegated `Chat.Read`
  * one per channel: `/teams/{team}/channels/{channel}/messages`, delegated `ChannelMessage.Read.All`
  * Channels are discovered from `teamwork/associatedTeams` every 15 minutes, so new channels are picked up automatically.
* **Fetching messages.** Subscriptions don't include resource data, so there's no encryption certificate to run or rotate. The bridge fetches each message by id, which costs one extra GET per message.
* **Subscription lifetime.** chatMessage subscriptions last at most 3 days (4,320 minutes). The bridge requests 4,200 minutes, renews any subscription with less than 12 hours left, and registers a lifecycle URL, which is required for anything over 1 hour:
  * `reauthorizationRequired` → renew
  * `subscriptionRemoved` → recreate
  * `missed` → resync
* **Outbound.** Graph delegated `ChannelMessage.Send` / `ChatMessage.Send` posts as the agent who wrote the reply. If they haven't connected, or can't post there, nothing is posted (see [Who replies are from](#who-replies-are-from)).
* **No polling.** Change notifications cover every channel and chat Kita belongs to, with an average latency under 10 seconds, so delta queries or polling aren't needed.

**Adaptive Cards: checked against the docs.** Microsoft's Graph reference for sending channel and chat messages and replies (checked 2026-09-24) sets no card-only rule for messages sent with delegated `ChannelMessage.Send` / `ChatMessage.Send`, including in shared channels. It supports HTML bodies, inline `hostedContents` images, and cards with `OpenUrl` actions. Pylon's note ("messages … to Teams Shared channels … appear as … Adaptive Cards … due to Microsoft limitations") comes from Microsoft restricting **bot/app** permissions in shared and private channels. Pylon also uses the card to show *which Pylon agent* replied. We don't need that: agents always post as themselves.
* The bridge therefore posts **plain HTML** everywhere.
* In **channels only**, it retries once as an Adaptive Card (from the same sender, carrying the same text) if Graph rejects the HTML with 400/403. Auth errors, throttling and 5xx never trigger the card retry.
* `TEAMS_MESSAGE_FORMAT=card` forces cards in channels; `html` disables the fallback.
* To confirm this in production, send one test reply into a real cross-tenant shared channel after connecting.

**Carmel's steps (all in Kita's tenant).** Agents then connect their own accounts from `/bridges/connect` (see [Connecting accounts](#connecting-accounts-each-agent-once)). Until they do, they can't reply in Teams (their replies fail with a private note).
1. **Create the Kita user.** In the Microsoft 365 admin center → Users → Add a user named `Kita` (e.g. `kita@kita.ai`) with its profile photo set to the Kita mark. Assign a **Microsoft Teams Essentials** license or higher; any license that includes Teams works. Exclude it from MFA prompts that would block the one-time sign-in, or complete MFA during that sign-in.
2. **Register the Entra app.** In the Entra admin center → App registrations → New registration: name it `Kita Support Bridge`, choose *Accounts in this organizational directory only*, and set the Redirect URI (type **Web**) to `https://support.internal.kita.ai/bridges/teams/connect/callback`.
   * Copy the Application (client) ID → `TEAMS_CLIENT_ID` and the Directory (tenant) ID → `TEAMS_TENANT_ID`.
   * Under Certificates & secrets → New client secret → `TEAMS_CLIENT_SECRET`. Note the expiry and set a reminder to rotate it.
   * Under API permissions → Add → Microsoft Graph → **Delegated**, add exactly: `offline_access`, `openid`, `profile`, `User.Read`, `User.ReadBasic.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Chat.Read`, `ChatMessage.Send`, plus for [team sync](#team-in-every-customer-channel-teamsync) `TeamMember.ReadWrite.All`, `ChannelMember.ReadWrite.All`, `ChatMember.ReadWrite`. Then click **Grant admin consent for Kita**. (Adding the team-sync permissions to an existing install: add them, grant admin consent, then re-run the connect flow in step 4 so the stored refresh token carries the new scopes.)
   * No application permissions, no Azure Bot, no Teams app manifest.
3. **Configure the bridge.** Set `TEAMS_KITA_USER_UPN`, a long random `TEAMS_CONNECT_KEY` and `BRIDGE_ENCRYPTION_KEY` (`openssl rand -base64 32` for each), plus the Teams API inbox identifier and secret. Deploy.
4. **Run the connect flow once.** In a private browser window, open `https://support.internal.kita.ai/bridges/teams/connect?key=<TEAMS_CONNECT_KEY>` and sign in **as the Kita user**. Any other account is refused. The page confirms "Connected as kita@…", the bridge stores the refresh token encrypted, and it creates the subscriptions.
   * `GET /bridges/healthz` shows `teamsConnected: true`.
   * Re-run this if the refresh token is revoked, the Kita user's password is reset, or the log shows `teams_reconnect_required`.
5. **Add the Kita user (and the agents who'll reply) to every customer conversation:**
   * Add Kita to each customer's **shared channel** (hosted in a Kita team). Easiest is to make Kita a member of the host team as well; otherwise list the channel in `TEAMS_EXTRA_CHANNELS` as `teamId/channelId`.
   * Add Kita to each Kita-tenant channel where customers are **guests**.
   * Add Kita to each **group chat** with customers.
   * New channels are picked up within 15 minutes; chats are picked up immediately.
6. **Staff messages.** Kita staff posting in those channels or chats are ignored automatically (members of Kita's tenant). Guests and external users are treated as customers.

### 3. Viber
1. Viber has closed self-serve bot creation. Bots now go through a Viber partner or the **Viber for Business** commercial program (`partners.viber.com`), and since 2024 bot-initiated and ongoing messaging is billed. Apply for a bot account named **Kita** with the Kita avatar, and confirm pricing for the Philippines.
2. Once the bot is approved, copy its **authentication token** → `VIBER_AUTH_TOKEN`. The bridge only receives (it never sends on Viber), so no sender name or avatar is configured.
3. Register the webhook after the bridge is live. It's a single call; Viber sends a signed `webhook` event that the bridge acknowledges:
   ```bash
   curl -X POST https://chatapi.viber.com/pa/set_webhook \
     -H "X-Viber-Auth-Token: $VIBER_AUTH_TOKEN" -H 'content-type: application/json' \
     -d '{"url":"https://support.internal.kita.ai/bridges/viber/webhook","event_types":["message","subscribed","unsubscribed","conversation_started"],"send_name":true,"send_photo":false}'
   ```
4. Share the bot link (`viber://pa?chatURI=<uri>`) or QR code with customers. Replies only reach users who have messaged or subscribed to the bot.

### 4. WhatsApp Business app coexistence (mirror)

**What it is (checked against Meta's docs, 2026-09-24).** Meta's *coexistence* onboarding connects a number that's already in use in the **WhatsApp Business app** to Cloud API, and the phone app keeps working. Customer messages arrive as the `messages` webhook. Anything the teammate sends from the phone app (or a supported companion device) arrives as `smb_message_echoes`. The bridge turns these into:
* `messages` → **incoming** message in that number's Chatwoot API inbox. The contact is `whatsapp:+<E.164>`, shared across numbers, and has no email or phone. The conversation gets `channel_key = whatsapp:+<E.164>` for the Grip sync.
* `smb_message_echoes` → **outgoing** message in the same conversation (it creates the conversation if the teammate messaged first), attributed to that number's owner:
  * natively, if the entry has `agentAccessToken` (that teammate's own Chatwoot token);
  * otherwise as "**Carmel Limcaoco:** …" through the bridge's token.
* **Echo types.** `revoke` and `edit` echoes aren't mirrored (the original stays).
* **Media.** Images, video, audio, documents and stickers are fetched with `GET /<media-id>` → download URL (bearer token) and attached. If that fails, the message still arrives without the file.
* **Ignored.** `statuses` are ignored. `history` (up to 180 days of past chats) and `smb_app_state_sync` (contacts) are **acknowledged but not imported**, so the desk starts from the day you connect. A backfill importer can be added later if needed.
* **Mirror only.** Nothing typed in the desk for these inboxes is ever sent (there is no send mode). The desk replaces the reply box with *"Reply in WhatsApp yourself — this inbox is a mirror"* (private notes still work), and a reply that gets through anyway only produces that private note.
* **Who wrote what.** Customer messages are authored by the customer contact; the teammate's phone replies are authored by their desk user when the number's entry has `agentEmail` (posted by the desk's staff endpoint), else by `agentAccessToken`, else by the bridge user as "**Owner:** …". Every message carries the WhatsApp badge (`external_source`).
* **Security.** Webhooks are verified with the `hub.challenge` handshake (`WHATSAPP_VERIFY_TOKEN`) and the `X-Hub-Signature-256` HMAC with the Meta **app secret**. Deliveries are de-duplicated on the `wamid`, so Meta's retries are harmless.
* **Multiple numbers.** Use one entry in `WHATSAPP_NUMBERS` and one Chatwoot API inbox per teammate's number. Optional `agentEmail` (the owner's desk email) and `displayPhoneNumber` show the number on that teammate's Connect accounts page. The inbox webhook URL is `…/bridges/chatwoot/whatsapp/<phoneNumberId>`.

**Native Chatwoot vs this bridge.** Chatwoot core (this fork) already supports coexistence in its **native WhatsApp Cloud inbox**. Its Embedded Signup has a *Coexistence* option, it subscribes to `messages` + `smb_message_echoes`, `WhatsappEventsJob` stores echoes as outgoing messages (`external_echo`, status delivered so they're never re-sent), and it handles Meta's BSUID identity rotation. What the native inbox does **not** do:
* **Mirror mode.** Anything an agent types in the desk is sent to the customer through Cloud API, and billed.
* **Owner attribution.** Echoes have no sender.
* **Grip `channel_key`.** Grip derives it from the phone number for native inboxes, so this matters less.

The bridge adds those three and uses one API inbox per number. Its BSUID handling is basic: it prefers the phone and uses the BSUID only when the phone is withheld, without core's rotation logic.
* **Recommendation:** use the bridge while "the desk must never send" is a hard rule.
* **Alternative:** if that rule relaxes, the native inbox is the lower-maintenance choice. Onboarding is identical, and core needs Chatwoot's installation config for WhatsApp Embedded Signup (Meta app id, configuration id, app secret) instead of the bridge's `WHATSAPP_*` settings.
* **Don't run both** on the same number: one webhook per app would split the stream.

**Constraints to know**
* **Business app required.** Only the **WhatsApp Business app** (version 2.24.17 or newer) can do coexistence. Personal WhatsApp isn't supported. Teammates on personal WhatsApp switch the number to WhatsApp Business on the same phone; WhatsApp carries existing chats over on that switch.
* **Throughput.** A coexistence number has a fixed throughput of **20 messages/second** per Meta's current coexistence docs, not the 80 mps of a Cloud-API-only number. That's irrelevant for 1:1 support.
* **Not supported on coexistence numbers:** group chats, disappearing and view-once messages, live location, broadcast lists (become read-only), calls, catalog/orders/status, and channels.
* **Companion devices.** Onboarding **unlinks companion devices**. WhatsApp for Windows and WearOS can't be relinked, and messages sent from them produce no echo webhook.
* **Phone must stay active.** Meta disconnects the number if the phone app isn't opened for about **14 days**, so each teammate should open WhatsApp Business at least every two weeks.
* **Pricing.** Messages sent from the phone app stay free. Only messages sent through Cloud API are billed, and mirror mode sends none.

**Who does the onboarding: Kita directly vs a BSP (trade-off)**
* **Direct (Kita becomes a Meta *Tech Provider*).** Coexistence is only offered through Embedded Signup by a Solution Partner or Tech Provider.
  * Pros: no middleman or monthly per-number fee, standard Cloud API webhooks (what this bridge implements), full control.
  * Cons: Meta Business verification, App Review for advanced `whatsapp_business_messaging` / `whatsapp_business_management` access, and hosting the Embedded Signup button. Expect days to weeks.
* **Through a BSP (e.g. 360dialog), which offers coexistence onboarding as a hosted flow.**
  * Pros: fastest path, and no App Review for Kita.
  * Cons: a monthly fee per number, and webhooks come via the BSP. The bridge verifies Meta's `X-Hub-Signature-256`, so a BSP that re-signs or forwards differently needs a small adapter, and media download goes through the BSP's API.
* **Recommendation:** go direct if Kita is willing to do Business verification plus App Review, since this code is ready for it. Use a BSP only if you need this live this month.

**Carmel's steps (direct route)**
1. **Meta Business verification.** In Business Manager → Security Center, verify Kita Technologies, Inc.
2. **Create the Meta app.** In developers.facebook.com → Create app → type *Business*, then add the **WhatsApp** product.
   * Under App settings → Basic, copy the **App secret** → `WHATSAPP_APP_SECRET`.
   * Create a **system user** with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions and generate a token → `WHATSAPP_ACCESS_TOKEN`.
3. **Configure the webhook.** Under WhatsApp → Configuration:
   * Callback URL: `https://support.internal.kita.ai/bridges/whatsapp/webhook`.
   * Verify token: any random string, also set as `WHATSAPP_VERIFY_TOKEN`. The bridge must be deployed first so the handshake succeeds.
   * Subscribe to the fields **`messages`**, **`smb_message_echoes`**, `history` and `smb_app_state_sync`.
4. **Become a Tech Provider** (App Review for advanced access) and create an **Embedded Signup** configuration with WhatsApp Business app onboarding (coexistence) enabled.
5. **Onboard each teammate once:**
   * Open the Embedded Signup link and choose *connect your existing WhatsApp Business app*.
   * On the phone, in WhatsApp Business, **scan the QR code** shown and approve sharing chats.
   * Record the resulting **phone number id**.
   * Within 24 hours, start the sync that Meta requires. The bridge ignores the payloads, but the calls keep the onboarding valid:
     `POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/smb_app_data` with `{"messaging_product":"whatsapp","sync_type":"smb_app_state_sync"}`, then again with `"sync_type":"history"`.
6. **Chatwoot inboxes.** Create one API inbox per number (e.g. "WhatsApp · Carmel") with the webhook URL `https://support.internal.kita.ai/bridges/chatwoot/whatsapp/<PHONE_NUMBER_ID>`. Add an entry to `WHATSAPP_NUMBERS` with the inbox identifier, webhook secret, owner name, and optionally the owner's own Chatwoot access token (Profile settings → Access token).
7. **Tell the team:** keep replying on the phone. The desk is a read-only mirror.

### Viber: mirror of the Kita bot only
* **The desk never sends on Viber**, not even through the bot. Customers' messages to the Kita Viber bot are surfaced in the desk (notifications are centralised there); desk replies are not sent and get the private note *"Reply in Viber yourself — this inbox is a mirror"*, and the reply box is replaced with that notice.
* **What Viber lets us see.** The Viber API only receives messages sent to a Viber **bot** or business account (the Chatbot API this bridge uses). It cannot read people's personal Viber chats, and there's no official API for a person's or a business account's own chats. So the mirror covers **only conversations customers have with the Kita Viber bot**, never teammates' personal Viber conversations.
* **Consequence.** A person can't answer *as the bot* from the Viber app, so a customer who writes to the Kita bot gets a reply only if a teammate contacts them from their own Viber, in a separate chat the bridge can't see.

## Limitations and next steps
* Teams non-image files go out as a link to the bridge media URL; native Teams files would need uploading to the channel's SharePoint (`Files.ReadWrite.All`).
* Teams: files customers share live in *their* SharePoint/OneDrive; agents get the link (the Kita user can't always read cross-tenant files). Inline images are copied.
* Teams: messages in a `missed` window, or sent while the bridge was down longer than the Graph retry window, aren't back-filled. Catch-up via delta would be the next step if this happens in practice.
* Teams: only channels hosted in Kita's tenant are watched. Channels a customer hosts and shares *into* Kita can't be subscribed with Kita's delegated token.
* Media links expire after `MEDIA_TTL_DAYS` (default 90). Slack files are native and don't expire.
* Message edits and deletes aren't synced in either direction.
