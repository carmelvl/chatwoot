# kita-wa-groups

Mirrors **WhatsApp group chats** into the Kita support desk, the way Pylon does it. A dedicated Kita
WhatsApp number runs as a **linked device** (like WhatsApp Web) through the open-source
[Baileys](https://github.com/WhiskeySockets/Baileys) library (`baileys@7.0.0-rc14`, MIT). It joins
existing customer groups from their invite links, and every group message lands in the desk under the
right customer.

Meta's official Cloud API cannot read or join existing groups. The Cloud API coexistence setup in
`kita-bridges` still handles 1:1 WhatsApp chats. This service adds groups only.

## How it fits

```
WhatsApp group ──(linked device)──> kita-wa-groups ──POST /internal/inbound──> kita-bridges ──> desk
```

- Every message is normalised (text, image, video, audio, document, sticker as image, reaction,
  location, contact, poll; quotes and reactions become `in_reply_to`). It then goes through
  kita-bridges' own `bridge.inbound()`, so it follows the same rules as every other platform: threading,
  one contact per person (`whatsapp:+E164`, shared with their 1:1 chats), Kita vs External, dedupe,
  the Customers inbox and Grip linking. The channel key is `whatsapp-group:<jid>` and the label is
  the group subject.
- **Kita vs External:** the dedicated number and every number in `WA_GROUPS_KITA_NUMBERS` show as Kita
  (desk agent matched by the optional `=email`). Everyone else is External.
- **Media** is decrypted here and written to the volume. kita-bridges downloads it from
  `/wa-groups/internal/media/<token>` (bridge secret, docker network only), and the file is deleted
  as soon as the desk has it.
- **History:** when the number is paired, WhatsApp sends the linked device a history sync. Group
  messages from that sync are imported, deduped by message id, with `created_at` (the original time)
  and `backfill: true`. The desk keeps the original timestamp once the history-backfill work
  (`kita/history-backfill`) is merged. Until then, imported messages are stamped with the time they
  arrive. A group joined *after* pairing has no earlier history: WhatsApp does not show new members
  anything posted before they joined.
- **Mirror only:** the desk never posts to WhatsApp and people reply from their own phones. The service
  never joins a group or replies on its own.
  - `WA_GROUPS_SEND=on` (set in **both** kita-wa-groups and kita-bridges) lets desk replies post into
    the group as the Kita number. It is off by default. Keep it off.

## Endpoints (`/wa-groups/...`)

| Route | Auth | |
|---|---|---|
| `GET /healthz` | none | `{connected, status, number, groups}` |
| `GET /pair` | signed link (`?x=&s=`) or `X-Kita-Bridge-Secret` | QR page that refreshes every 5 s, then "Connected as +…" |
| `GET /status`, `GET /groups` | secret | status + joined groups |
| `POST /join {invite_link}` | secret | joins the group and returns `{jid, subject}`; 422 bad link, 404 revoked, 409 not paired, 429 over `WA_GROUPS_JOINS_PER_HOUR` |
| `POST /logout` | secret | unlinks the device (a fresh QR follows) |
| `GET /internal/media/<token>`, `POST /internal/send` | secret | kita-bridges only. Caddy answers 404 to `/wa-groups/internal/*` from outside |

In the desk, go to **Customers → WhatsApp groups** (admins only). It shows the status and has
**Pair number**, which opens a signed pair link valid for 15 minutes, plus **Add group by invite
link** and the joined groups list. Rails calls this service with the secret server side
(`Kita::WaGroups`), so the secret never reaches the browser.

## Pairing

1. Get a **dedicated** SIM/number for Kita. Install WhatsApp (or WhatsApp Business) on a phone with it,
   and keep that phone charged and online at least every few days. Linked devices are dropped after
   about 14 days without the phone.
2. Configure `kita-wa-groups/.env` (see `.env.example`) and deploy.
3. Desk → Customers → WhatsApp groups → **Pair number**.
4. On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR code.
5. The page turns into "Connected as +…". Any history WhatsApp sends starts importing.
6. Paste each customer group's invite link (group info → Invite via link) into **Add group by invite
   link**. Alternatively, a group admin can add the Kita number to the group directly. Add the number's
   groups to Grip like any other channel so they land under the right customer.

## Risk: read this before pairing

- This is an **unofficial linked-device client**. It is not Meta's API, and WhatsApp's terms do not
  allow it. **WhatsApp may ban the dedicated number at any time.** Only ever pair a number that exists
  for this purpose. **Never pair a personal number or Kita's main business number.**
- To keep the risk low: the service never messages first, never auto-joins or auto-replies, joins
  are rate limited, it does not mark itself online, and sending is off by default.
- **Recovery** if the number is banned or logged out:
  1. The service wipes the linked-device keys by itself and the pair page shows a new QR.
  2. Get a new dedicated number and pair it.
  3. Re-join each group: a group admin adds the new number, or you paste the invite links again.
  4. Update `WA_GROUPS_KITA_NUMBERS` if the old number was listed.
  Desk history is untouched. Groups keep their channel key (the group id), so new messages continue in
  the same conversations. To move to a new number on purpose, use `POST /wa-groups/logout` first.
- **Data stays on Kita's server.** The linked-device keys are AES-256-GCM encrypted at rest
  (`BRIDGE_ENCRYPTION_KEY`) on the `wa_groups_data` volume. Media is kept only until the desk has
  it. Nothing goes to a third party, and message content is never logged.

## Develop

```sh
cd kita-wa-groups && npm ci && npm test   # Node 24; Baileys is mocked in tests
```
