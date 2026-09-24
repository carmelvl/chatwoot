# kita-bridges

Lets customers talk to Kita natively in **Slack** (Slack Connect / shared channels), **Microsoft Teams** and **Viber**. Every conversation lands in Chatwoot (the internal desk), and agent replies go back out on the same channel and thread. WhatsApp is native to Chatwoot and isn't handled here.

**Customers never see Chatwoot.**
* Replies arrive as normal messages from **Kita**: a bot in Slack and Viber, and in Teams the licensed Kita user in Kita's own Microsoft 365 tenant. Customers install nothing. There are no agent names, no "via" text and no Chatwoot links.
* Agent attachments are sent as native Slack files, Viber picture/file messages, or Teams inline images. Any remaining file link points at the bridge's own `…/bridges/media/<random token>/<file>`, never at a Chatwoot URL.
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
                            └── Chatwoot API-inbox webhook (message_created, outgoing, non-private) ─> Slack thread / Teams thread or chat (as the Kita user) / Viber user
```

| Platform | Contact identifier | Conversation = | Reply target |
|---|---|---|---|
| Slack | `slack:<user id>` | one **thread** (`channel:root ts`). A top-level message opens a new conversation and replies in its thread append to it. Shared channels carry many unrelated topics, and a thread is Slack's natural unit for one issue. | `chat.postMessage` with `thread_ts`, as **Kita** (`SLACK_BOT_NAME`/`SLACK_BOT_ICON_URL`); files via `files.completeUploadExternal` |
| Teams | `teams:<Entra user id>` | a **channel thread** (team + channel + root message id), or a **chat**. A chat is long-lived, so once its conversation is resolved the next message opens a new one (the bridge tracks `conversation_status_changed`). | Graph `POST …/messages/{root}/replies` or `POST /chats/{id}/messages` as the Kita user; plain HTML, Adaptive Card only as a fallback |
| Viber | `viber:<user id>` | the user (Viber bots are 1:1) | `pa/send_message` |

Endpoints (Caddy strips `/bridges`): `POST /slack/events`, `POST /teams/notifications` + `POST /teams/lifecycle` (Graph change and lifecycle notifications), `GET /teams/connect?key=…` + `/teams/connect/callback` (one-time sign-in), `POST /viber/webhook`, `POST /chatwoot/{slack,teams,viber}`, `GET /media/<token>/<name>` (attachment proxy, expires after `MEDIA_TTL_DAYS`), `GET /healthz`.

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
* A Chatwoot conversation has a single contact. When a second person writes in the same Slack or Teams thread, they still get their own contact, but their message goes into the thread's conversation prefixed with `**Name:**`.
* Attachments:
  * Inbound files (Slack `files:read`, Teams file/inline image, Viber media) are copied into Chatwoot. If a download fails, the link is added to the message instead of dropping it (agents see it; customers never do).
  * Outbound, Slack uploads native files. Viber sends picture/file messages. Teams embeds images inline (`hostedContents`, up to 3 MB) and sends other files as a named link to the bridge media URL.
* Logs contain ids only, never message bodies or tokens.

## Run and test locally

```bash
cd kita-bridges
npm test                       # node --test, 58 tests, no install step (Node >= 24)
cp .env.example .env && node src/server.ts
```

## Deploy (for later, not done yet)

The `bridges` service is in `docker-compose.kita.yaml` and the `/bridges/*` route is in `Caddyfile.kita`. On the host: create `kita-bridges/.env` (from `.env.example`), then run `docker compose -f docker-compose.kita.yaml up -d --build bridges caddy`. Each platform stays disabled until its variables are set (`GET /bridges/healthz` lists the enabled ones). Following the deploy rule, merge to `main` and push before deploying.

## No emails to customers

Chatwoot only emails a contact about a conversation (`Messages::SendEmailNotificationService`) if **the contact has an email** and the API inbox has email continuity turned on. The bridge never sets email or phone on the contacts it creates, and a test enforces this. On top of that, Carmel should switch off or avoid the following:

1. **Email continuity on the API channel** must stay OFF. It's the account feature `email_continuity_on_api_channel` (off by default). Check it under Super Admin → Accounts → Kita → Features.
2. **Never add an email or phone to Slack/Teams/Viber contacts.** Don't merge them into contacts that have an email either: a merged contact keeps the email, and continuity would then apply.
3. On each of the three API inboxes, turn **CSAT** off (Inbox → Settings → CSAT). The bridge drops CSAT anyway, but that way agents don't expect survey results.
4. **Greeting and out-of-office messages** are template messages and are never delivered, so leave them off on these inboxes.
5. Don't use **Send conversation transcript**, and don't add automation rules or macros with *Send email to contact / transcript*, on these inboxes.
6. Leave "Enable HMAC identity validation" off (the bridge uses the public inbox API).

## Setup per platform

### 0. Chatwoot: one API inbox per platform (repeat for Slack, Teams, Viber)
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
6. Behaviour: each new top-level customer message opens a Chatwoot conversation, and agent replies arrive in that message's thread.

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
* **Outbound.** Graph delegated `ChannelMessage.Send` / `ChatMessage.Send` posts as the Kita user.
* **No polling.** Change notifications cover every channel and chat Kita belongs to, with an average latency under 10 seconds, so delta queries or polling aren't needed.

**Adaptive Cards: checked against the docs.** Microsoft's Graph reference for sending channel and chat messages and replies (checked 2026-09-24) sets no card-only rule for messages sent with delegated `ChannelMessage.Send` / `ChatMessage.Send`, including in shared channels. It supports HTML bodies, inline `hostedContents` images, and cards with `OpenUrl` actions. Pylon's note ("messages … to Teams Shared channels … appear as … Adaptive Cards … due to Microsoft limitations") comes from Microsoft restricting **bot/app** permissions in shared and private channels. Pylon also uses the card to show *which Pylon agent* replied, which we deliberately don't do.
* The bridge therefore posts **plain HTML** everywhere.
* In **channels only**, it retries once as an Adaptive Card (still sent by the Kita user, with no agent name) if Graph rejects the HTML with 400/403. Auth errors, throttling and 5xx never trigger the card retry.
* `TEAMS_MESSAGE_FORMAT=card` forces cards in channels; `html` disables the fallback.
* To confirm this in production, send one test reply into a real cross-tenant shared channel after connecting.

**Carmel's steps (all in Kita's tenant):**
1. **Create the Kita user.** In the Microsoft 365 admin center → Users → Add a user named `Kita` (e.g. `kita@kita.ai`) with its profile photo set to the Kita mark. Assign a **Microsoft Teams Essentials** license or higher; any license that includes Teams works. Exclude it from MFA prompts that would block the one-time sign-in, or complete MFA during that sign-in.
2. **Register the Entra app.** In the Entra admin center → App registrations → New registration: name it `Kita Support Bridge`, choose *Accounts in this organizational directory only*, and set the Redirect URI (type **Web**) to `https://support.internal.kita.ai/bridges/teams/connect/callback`.
   * Copy the Application (client) ID → `TEAMS_CLIENT_ID` and the Directory (tenant) ID → `TEAMS_TENANT_ID`.
   * Under Certificates & secrets → New client secret → `TEAMS_CLIENT_SECRET`. Note the expiry and set a reminder to rotate it.
   * Under API permissions → Add → Microsoft Graph → **Delegated**, add exactly: `offline_access`, `openid`, `profile`, `User.Read`, `User.ReadBasic.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Chat.Read`, `ChatMessage.Send`. Then click **Grant admin consent for Kita**.
   * No application permissions, no Azure Bot, no Teams app manifest.
3. **Configure the bridge.** Set `TEAMS_KITA_USER_UPN`, a long random `TEAMS_CONNECT_KEY` and `BRIDGE_ENCRYPTION_KEY` (`openssl rand -base64 32` for each), plus the Teams API inbox identifier and secret. Deploy.
4. **Run the connect flow once.** In a private browser window, open `https://support.internal.kita.ai/bridges/teams/connect?key=<TEAMS_CONNECT_KEY>` and sign in **as the Kita user**. Any other account is refused. The page confirms "Connected as kita@…", the bridge stores the refresh token encrypted, and it creates the subscriptions.
   * `GET /bridges/healthz` shows `teamsConnected: true`.
   * Re-run this if the refresh token is revoked, the Kita user's password is reset, or the log shows `teams_reconnect_required`.
5. **Add the Kita user to every customer conversation:**
   * Add Kita to each customer's **shared channel** (hosted in a Kita team). Easiest is to make Kita a member of the host team as well; otherwise list the channel in `TEAMS_EXTRA_CHANNELS` as `teamId/channelId`.
   * Add Kita to each Kita-tenant channel where customers are **guests**.
   * Add Kita to each **group chat** with customers.
   * New channels are picked up within 15 minutes; chats are picked up immediately.
6. **Staff messages.** Kita staff posting in those channels or chats are ignored automatically (members of Kita's tenant). Guests and external users are treated as customers.

### 3. Viber
1. Viber has closed self-serve bot creation. Bots now go through a Viber partner or the **Viber for Business** commercial program (`partners.viber.com`), and since 2024 bot-initiated and ongoing messaging is billed. Apply for a bot account named **Kita** with the Kita avatar, and confirm pricing for the Philippines.
2. Once the bot is approved, copy its **authentication token** → `VIBER_AUTH_TOKEN`. `VIBER_BOT_NAME` defaults to `Kita` (28 characters max). Set `VIBER_BOT_AVATAR` to a public URL of the Kita mark (sent with every message).
3. Register the webhook after the bridge is live. It's a single call; Viber sends a signed `webhook` event that the bridge acknowledges:
   ```bash
   curl -X POST https://chatapi.viber.com/pa/set_webhook \
     -H "X-Viber-Auth-Token: $VIBER_AUTH_TOKEN" -H 'content-type: application/json' \
     -d '{"url":"https://support.internal.kita.ai/bridges/viber/webhook","event_types":["message","subscribed","unsubscribed","conversation_started"],"send_name":true,"send_photo":false}'
   ```
4. Share the bot link (`viber://pa?chatURI=<uri>`) or QR code with customers. Replies only reach users who have messaged or subscribed to the bot.

## Limitations and next steps
* Teams non-image files go out as a link to the bridge media URL; native Teams files would need uploading to the channel's SharePoint (`Files.ReadWrite.All`).
* Teams: files customers share live in *their* SharePoint/OneDrive; agents get the link (the Kita user can't always read cross-tenant files). Inline images are copied.
* Teams: messages in a `missed` window, or sent while the bridge was down longer than the Graph retry window, aren't back-filled. Catch-up via delta would be the next step if this happens in practice.
* Teams: only channels hosted in Kita's tenant are watched. Channels a customer hosts and shares *into* Kita can't be subscribed with Kita's delegated token.
* Media links expire after `MEDIA_TTL_DAYS` (default 90). Slack files are native and don't expire.
* Message edits and deletes aren't synced in either direction.
