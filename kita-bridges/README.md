# kita-bridges

Lets customers talk to Kita natively in **Slack** (Slack Connect / shared channels), **Microsoft Teams** and **Viber**. Every conversation lands in Chatwoot (the internal desk), and agent replies go back out on the same channel and thread. WhatsApp is native to Chatwoot and isn't handled here.

**Customers never see Chatwoot.**
* Replies arrive as normal messages from a bot named **Kita**. There are no agent names, no "via" text and no Chatwoot links.
* Agent attachments are sent as native Slack files, Viber picture/file messages, or Teams images. Any remaining file link points at the bridge's own `…/bridges/media/<random token>/<file>`, never at a Chatwoot URL.
* CSAT surveys and Chatwoot interactive messages are never forwarded.
* Contacts are created with no email or phone, so the desk can't email them. See [No emails to customers](#no-emails-to-customers).

## Why a bridge (and not a Chatwoot patch)

* Chatwoot has no Teams or Viber channel. Its Slack integration (`lib/integrations/slack/*`) goes the other way: Chatwoot posts each conversation into **one** Kita Slack channel so agents can reply from Slack. It only reads thread replies to threads that Chatwoot itself started (`Integrations::Hook.find_by(reference_id: channel)`, conversation found by `thread_ts`). Those replies become agent messages or private notes. It never takes in customer messages from shared channels.
* The upstream way to add a channel is an **API channel inbox** (`Channel::Api`). Messages come in through the public inbox API. Agent replies go out through the inbox webhook, signed `X-Chatwoot-Signature: sha256=HMAC(secret, "ts.body")` (`lib/webhooks/trigger.rb`). No core changes are needed, so upstream merges stay clean.
* **Node 24 + TypeScript, no dependencies.** Node runs `.ts` natively (type stripping) and includes `fetch`, `node:sqlite` and `node:test`. That means no `npm install`, no build step, a small image and a codebase you can audit in one sitting. Ruby would have meant a second Gemfile or a gem-heavy Bot Framework stack.

```
Slack Events API ─┐                        ┌─> POST /public/api/v1/inboxes/<id>/contacts|conversations|messages
Teams (Azure Bot) ├─> Caddy /bridges/* ─> bridges:8080 ─┤              (one API-channel inbox per platform)
Viber webhook ────┘         ▲              └─ SQLite /data: contacts, thread→conversation, reply refs, dedupe keys
                            └── Chatwoot API-inbox webhook (message_created, outgoing, non-private) ─> Slack thread / Teams conversation / Viber user
```

| Platform | Contact identifier | Conversation = | Reply target |
|---|---|---|---|
| Slack | `slack:<user id>` | one **thread** (`channel:root ts`). A top-level message opens a new conversation and replies in its thread append to it. Shared channels carry many unrelated topics, and a thread is Slack's natural unit for one issue. | `chat.postMessage` with `thread_ts`, as **Kita** (`SLACK_BOT_NAME`/`SLACK_BOT_ICON_URL`); files via `files.completeUploadExternal` |
| Teams | `teams:<AAD object id>` | Teams `conversation.id`. That's a channel reply chain (`;messageid=`), a group chat, or a 1:1 chat. | Proactive send to the stored conversation reference (`serviceUrl` + id) |
| Viber | `viber:<user id>` | the user (Viber bots are 1:1) | `pa/send_message` |

Endpoints (Caddy strips `/bridges`): `POST /slack/events`, `POST /teams/messages`, `POST /viber/webhook`, `POST /chatwoot/{slack,teams,viber}`, `GET /media/<token>/<name>` (attachment proxy, expires after `MEDIA_TTL_DAYS`), `GET /healthz`.

**Safety and correctness**
* Every inbound request is verified before it's processed:
  * Slack: v0 HMAC, with a 5-minute replay window.
  * Teams: Bot Framework JWT. RS256 checked against the published JWKS, plus issuer, audience = app id, expiry, and the `serviceurl` claim.
  * Viber: HMAC of the raw body.
  * Chatwoot: inbox secret HMAC, with a 5-minute window.
* Loop prevention:
  * Only `message_created` + `outgoing` + non-private + `content_type: text` messages are sent out, and anything containing a `/survey/responses/` link is dropped.
  * Greeting and out-of-office messages are `template` messages and are never forwarded.
  * Everything the bridge writes is `incoming`, so it can never echo back.
  * Slack bot messages and the bot's own user are ignored.
  * Kita staff in shared channels (`SLACK_INTERNAL_TEAM_IDS`) are ignored.
  * Teams bot activities are ignored.
* Idempotency: platform retries are de-duplicated by event id (Slack `event_id`, Teams activity id, Viber `message_token`, which is read from the raw body because it's 64-bit). Chatwoot webhook retries are de-duplicated by message id. A failed step releases its key so the retry can succeed.
* Outbound is synchronous: if a send fails, Chatwoot shows the agent's message as **failed**.
* A Chatwoot conversation has a single contact. When a second person writes in the same Slack or Teams thread, they still get their own contact, but their message goes into the thread's conversation prefixed with `**Name:**`.
* Attachments:
  * Inbound files (Slack `files:read`, Teams file/inline image, Viber media) are copied into Chatwoot. If a download fails, the link is added to the message instead of dropping it (agents see it; customers never do).
  * Outbound, Slack uploads native files. Viber sends picture/file messages. Teams sends images as attachments and other files as a named link to the bridge media URL.
* Logs contain ids only, never message bodies or tokens.

## Run and test locally

```bash
cd kita-bridges
npm test                       # node --test, 45 tests, no install step (Node >= 24)
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

### 2. Microsoft Teams (Azure Bot)
1. In the Azure portal, go to Create resource → **Azure Bot**.
   * Name the bot handle and display name **Kita**.
   * Type of App: **Single Tenant**. This is Microsoft's current default; new multi-tenant bot registrations are deprecated.
   * Creation type: "Create new Microsoft App ID".
   * Pricing: F0 is enough (Teams is a standard channel).
2. Under Bot → Configuration:
   * Set the Messaging endpoint to `https://support.internal.kita.ai/bridges/teams/messages`.
   * Copy the **Microsoft App ID** → `TEAMS_APP_ID` and the **App Tenant ID** → `TEAMS_APP_TENANT_ID`.
3. Go to the linked App registration → Certificates & secrets → **New client secret** → `TEAMS_APP_PASSWORD`. Note the expiry and set a reminder to rotate it.
4. Under Bot → Channels, add **Microsoft Teams** and accept the terms.
5. Build the Teams app package:
   * Copy `manifests/teams-app-manifest.json` to `manifest.json` and replace both `REPLACE_WITH_TEAMS_APP_ID` with the App ID.
   * Add `color.png` (192×192, the Kita mark; this is the bot avatar customers see) and `outline.png` (32×32, transparent white).
   * Zip the three files together (flat, no folder).
   * The RSC permissions let the bot see channel and chat messages without being @-mentioned.
6. Distribute: in the Teams Developer Portal (dev.teams.microsoft.com) → Apps → Import, validate and download. Send the zip to each customer's Teams admin, who uploads it as a custom app in their Teams Admin Center (or allows sideloading). Users then add "Kita" in a chat or a team channel.
7. Cross-tenant note: with a single-tenant bot, customers in other tenants can install the app package. Bot messages are routed by the Bot Framework, and the bridge sends with a token from Kita's tenant. If a customer tenant blocks custom apps, their admin must allow this one.

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
* Teams non-image files go out as a link to the bridge media URL; native Teams file sending needs a FileConsentCard flow (1:1 only).
* Media links expire after `MEDIA_TTL_DAYS` (default 90). Slack files are native and don't expire.
* Message edits and deletes aren't synced in either direction.
* Teams personal (1:1) chats need the customer to message the bot first; the bot doesn't start conversations.
