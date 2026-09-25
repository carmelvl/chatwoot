# Kita Support: Unified Inbox Spec (final)

## Summary
- There is one work list, the **Inbox**. Each row is a customer (a `grip_account_id`), and the list replaces both the Customers page and the classic Conversations page.
- **Customers** becomes an account directory and **Tickets** becomes the KT-n table. Each page has a different row unit (the thing that is work, an account, a ticket), so no two pages show the same thing.
- The work is built on the Chatwoot filter service: filtered conversations are passed into `Kita::Customers.new(conversations).rows`. That keeps labels, teams, saved views and advanced filters working with no model changes. The old routes stay registered, so rollback is trivial.

## Navigation
- The sidebar (forest green, per S03) has, from top to bottom: **Inbox** (count = NEEDS REPLY in the Mine scope), with saved views as child items; **Customers**; **Tickets**; **Reports**; and **Settings** pinned at the bottom.
- The bell in the header holds mentions and assignment notifications. Each one deep-links into the Inbox.
- Settings holds inboxes/channels, labels, teams, canned responses, macros, contacts, connected accounts (Slack/Teams identity) and agents.
- Hidden from the nav: the Conversation group (All, Mentions, Participating, Unattended, My customers, Folders, Teams, Channels, Labels), Campaigns, Help Center and Captain.
- `PlatformLogo` (Slack, Teams, WhatsApp, Viber, and the channel icon for anything else) appears everywhere a platform is referenced: rows, tabs, messages, tickets, directory, bell and filters.

## Inbox (the one work list)

**Route:** `/inbox`, `/inbox/customer/:gripId/:platform?/thread/:threadTs?`. The dashboard root redirects here.

**Row unit:**
- One Grip account (`grip_account_id`).
- One provisional row per unlinked channel.
- One row per non-bridge conversation (email or web widget), keyed by conversation.

**Row anatomy (S03), top to bottom:**
1. Customer name and a Stage pill if pending. On the right: the DRI avatar and the wait time. Wait time counts from the customer's oldest unanswered message and turns red past SLA; otherwise the row shows the relative time of the last activity.
2. A strip of platform logos, one per linked platform conversation. A dot marks unread, full colour means open, greyed means resolved, and a clock means snoozed.
3. `[logo] Platform · Sender: preview`. This comes from `waiting_platform` if the account is waiting on us, otherwise from the latest message. An unread count badge sits on the right.
4. The ticket line, shown when an open P0/P1 ticket exists: `KT-41 · Urgent · Failed disbursement webhook`, plus `+N more` if there are several. Uses `KitaTicketChip`.
5. Label chips (the union across the account's conversations), shown compactly.

**Sections:**
1. **NEEDS REPLY**: at least one open platform conversation has an incoming last public message. Oldest wait first. Rows with an open P0/P1 are pinned to the top of this section with a red left rail.
2. **ACTIVE**: open, and we replied last (or an open ticket exists). Most recent first.
3. **UNLINKED**: collapsed, and shown only when the count is above 0. Rows carry an inline **Link to customer** action (`KitaLinkCustomerModal`) and a **Not a customer** action. Unlinked rows still count toward the NEEDS REPLY badge.
4. **SNOOZED / RESOLVED**: collapsed at the bottom.

**Scope tabs:** Mine · Unassigned · All, plus one extra tab per saved view.
- **Mine**: I am the DRI (`custom_attributes->>'account_owner_email'` or the Grip DRI), OR I am the assignee on any of the account's conversations, OR I own an open ticket. This is the default tab.
- **Unassigned**: the account has no DRI, OR any of its conversations with an unanswered message has no assignee (Chatwoot `assignee_type=unassigned`).
- **All**.

**Filter bar** (one `KitaFilterMenu` chip bar under the tabs):
- Chips: Status (Open by default / Snoozed / Resolved / All), Platform, DRI, Label, Team, Ticket priority, Ticket status, Stage.
- Semantics: filters apply to conversations *before* grouping. An account appears if any of its conversations matches.
- **Advanced filters:** the existing Chatwoot advanced-filter popover sits behind a "More filters" button and runs unchanged against conversations. The Inbox/channel attribute is shown as Platform.
- **Saved views:** Chatwoot `custom_filters` (type conversation) are reused as-is. Saving the current tab plus chips creates a view, which shows as a scope tab and as a sidebar child under Inbox.

**Keyboard** (Chatwoot hotkey mixin):
- `j`/`k` move, `Enter` opens.
- `r` reply, `e` done (resolve all), `s` snooze, `a` assign DRI, `l` label.
- `i` toggles the info drawer, `/` opens the command palette.

**Bulk:** multi-select rows (checkbox on hover) for resolve, snooze, assign DRI or label. Each action fans out to every conversation on the selected accounts.

## Detail view (S03/S04)

Layout: list column | customer header + content | right pane.

**Header** (`KitaCustomerHeader`):
- Name, stage, the DRI (editable) and a Grip link.
- Actions: **Resolve all**, which asks before closing open tickets, and **Snooze** (account-level, with a wake time).
- `i` opens the info drawer.

**Tabs:** **All** · Slack · Teams · WhatsApp · Viber (only linked platforms are shown) · **Tickets (n)**.
- Every tab shows its logo and an unread badge.
- **Default tab:** `waiting_platform` (the platform with the oldest unanswered message). If nothing is waiting, the most recent platform.
- **All:** a merged, time-ordered stream across the account's conversations, with a `PlatformLogo` on every message. Clicking a Slack or Teams message opens its thread.
- **Slack/Teams:** the flat Slack-style list (`KitaThreadsList`). Thread roots carry a `KitaTicketChip` and a reply count.
- **WhatsApp/Viber:** a read-only bubble mirror.
  - The composer is **Add private note**, with the hint "Reply from your phone. It will appear here."
  - A **Replied from phone** button clears needs-reply for cases where the bridge missed the reply.
- **Tickets tab:** this account's KT-n tickets. Clicking one opens the right platform tab with its thread.

**Right pane** (`KitaThreadPane`):
- **When a thread is open:**
  - The ticket card sits on top: KT-n, priority, status and owner, all editable inline.
  - Below it are the thread messages and the reply composer.
  - The composer sends as the real person. `KitaReplyGate` shows a one-click Connect button until that person has connected their account.
  - Canned responses (`/`) and macros are available in the composer.
- **When no thread is open:** the account context.
  - DRI, Grip link, and contacts grouped by platform.
  - Labels, team, open tickets and notes.
  - Per-conversation overrides (assignee, labels, team per platform) under "Advanced".

**Assignment model:**
- The DRI is the account owner and drives Mine.
- Assigning at account level sets the DRI and writes the conversation assignee on all of the account's conversations.
- Ticket owner is separate and edited on the ticket card. There is no hidden syncing between ticket owner and conversation assignee.
- Labels and team applied at account level are written to all of the account's conversations.

## Customers page (directory)

- **Route:** `/customers`, `/customers/:gripId`. It uses the rows endpoint with `directory=true`: all accounts, no previews, no needs-reply state, and no reply box.
- **Table columns:**
  - Account.
  - Stage (active/pending).
  - DRI.
  - Linked platforms: logos with connection health, marked connected, broken or missing.
  - Open tickets by priority.
  - Last contact.
  - Median first response over the last 30 days.
- The default sort is by name, and silent accounts are included.
- A **"Link N channels"** banner at the top opens `KitaLinkCustomerModal`. The inline Link action also stays on Inbox rows.
- **Account profile page** (`/customers/:gripId`):
  - Tabs: Overview (Grip data, contacts, channel mappings with Link/Unlink, people-connection status), Tickets (history) and Activity.
  - An **Open in Inbox** button goes to `/inbox/customer/:gripId`. This is the only route from here to messages.

## Tickets page

- **Route:** `/tickets`. A table over `kita_threads` / the Grip tickets API.
- **Columns:** KT-n, title, customer, platform logo, priority, status, owner, age and SLA.
- **Filters:** Mine / Unowned / All, plus priority, status, customer and platform.
- **Inline edits:** priority, status and owner.
- Clicking a row deep-links to `/inbox/customer/:gripId/:platform/thread/:threadTs`. There is no reply UI on this page.

## Edge cases

- **Unlinked channels:** a provisional row under UNLINKED, showing the channel name and logo. It is fully readable and repliable. Linking merges it into the account row.
- **Non-customer conversations** (internal, vendor, spam, prospects): **Not a customer** archives the channel into a hidden "Other" bucket, reachable through a Status/Other filter. It is excluded from Customers.
- **Non-bridge conversations** (email, widget): a row of kind "conversation" with the channel icon and no grouping.
- **Resolved/snoozed:**
  - Status lives on each platform conversation, and the account row derives its state from them.
  - Resolving one platform only greys that logo.
  - **Resolve all** or `e` resolves every conversation, and asks before closing open tickets.
  - An account-level snooze snoozes all conversations. The row returns at the earliest wake time, or immediately on any new inbound message.
- **Mixed platform states:** each logo carries its own state. The row sorts by the worst state (needs reply beats active, which beats snoozed, which beats resolved). The preview and the default tab come from `waiting_platform`.
- **WhatsApp/Viber phone replies:** these clear needs-reply automatically when they are mirrored as outgoing. Otherwise, use Replied from phone.
- **Reply gate:** you can still read and add private notes while the gate is shown. Only sending is blocked.
- **Mentions:** they appear in the bell and deep-link to the account, platform, thread and highlighted message. A mention also counts toward Mine.
- **Deep links** (emails, notifications, Slack links, old bookmarks): `/conversations/:id` and every `conversation_through_*` route resolve conversation → `grip_account_id` + platform + thread, then redirect. Unlinked conversations redirect to their provisional row.
- **Multiple urgent tickets on one account:** the ticket line shows the top ticket plus "+N more". The full list is on the Tickets tab and the Tickets page.
- **Empty states:**
  - When NEEDS REPLY is empty in Mine, the Inbox shows "You're clear" and a link to All.
  - The Unlinked section is hidden when there are none.

## What is removed/hidden and where it went

| Removed or hidden | Where it went |
|---|---|
| Conversations nav (All/Unattended/Participating) | Inbox scope tabs and the Status chip. The routes stay registered but are redirected. |
| Mentions page | Bell |
| "My customers" item and folder redirect | The Mine tab |
| Folders (custom views) | Saved views, shown as Inbox tabs and sidebar children |
| Teams / Labels / Channels sidebar lists | Team, Label and Platform filter chips; management lives in Settings |
| Per-customer leaf items (`kita-customer-${id}`) | Customers directory |
| Stock conversation sidebar column | Account context in the right pane (no thread open), plus Advanced per-conversation overrides |
| Conversation-card list, bulk actions and priority sort | Account rows, row multi-select bulk actions, and the Tickets page for priority |
| Campaigns, Help Center, Captain | Hidden. Feature flags are off and nothing is deleted. |
| Canned responses, macros, labels, teams, contacts, reports | Kept: in the composer, filters and Settings, and under Reports |

## Build plan
All paths are under `/Users/carmellimcaoco/Kita/chatwoot-unified`.

1. **Backend filtering** (`lib/kita/customers.rb` and the customers controller):
   - The index accepts ConversationFinder params: `assignee_type`, `status`, `labels`, `team_id`, `inbox_id`/platform, and `payload` for advanced filters or a custom view.
   - Build the relation through ConversationFinder or the filter service, then call `Kita::Customers.new(relation).rows`.
   - Mine ORs in the DRI match and ticket ownership through `kita_threads`.
2. **Row fields** (`lib/kita/customers.rb`):
   - Add `platforms: [{platform, conversation_id, unread, needs_reply, status}]`, `waiting_since`, `waiting_platform`, `section`, `dri_id`, `assignee_ids`, and `label_ids`/`team_ids` as unions.
   - Sort sections on the server, using the existing `urgent_conversation_ids` and `open_ticket_counts` for pinning.
   - Keep `row_id` and `unlinked_row`. Add the `directory=true` mode and the `other` (Not a customer) flag.
3. **Routes** (`routes/dashboard/customers/routes.js`):
   - Add `/inbox` and `/inbox/customer/:gripId/:platform?/thread/:threadTs?`, keeping `/customers/*` aliases during the transition.
   - Add `beforeEnter` redirects on `home`, `inbox_dashboard`, `folder_conversations`, `team_conversations` and `conversation_through_*`, backed by a conversation → account/platform/thread resolver endpoint.
4. **Sidebar** (`components-next/sidebar/Sidebar.vue`):
   - Replace the Conversation group (around lines 398-520) and the customer leaves (around line 274) with the Inbox item (NEEDS REPLY count and saved-view children), Customers, Tickets, Reports and Settings.
   - Move Mentions to the bell, and hide Campaigns, Help Center and Captain.
5. **List** (`components-next/kita/KitaCustomersList.vue`, `KitaInboxRow.vue`, `KitaFilterMenu`):
   - Add the Mine/Unassigned/All and saved-view tabs, the chip bar with the Status chip, and the "More filters" button that opens the advanced-filter popover (reusing the customViews store).
   - Add the sections with the urgent pin, the row anatomy, the inline Link and Not a customer actions, multi-select bulk actions, and hotkeys.
6. **Account actions:** a small controller for resolve-all, snooze, assign DRI, label and team. It loops over the account's conversation IDs, prompts before closing tickets, and handles Replied from phone.
7. **Detail** (`KitaCustomerHeader.vue`, `KitaThreadsTabs.vue`, `KitaThreadPane.vue`, `KitaReplyGate`):
   - Choose the default tab from `waiting_platform`, and add the All merged tab (a union message query with a `PlatformLogo` on each message).
   - Add the header actions (Resolve all, Snooze).
   - Show the account context in the right pane when no thread is open, with Advanced per-conversation overrides.
   - Keep canned responses and macros in the composer, and add Add private note plus Replied from phone on WhatsApp/Viber.
8. **Customers directory:** a new table and profile page built from the `directory=true` rows, with the Link-channels banner and Open in Inbox.
9. **Tickets page:** a new table over `kita_threads` that deep-links to thread URLs.
10. **Bell:** route mentions and assignment notifications through the resolver.
11. **Specs:**
    - `components-next/kita/specs` for the tabs, filters, sections and default-tab logic.
    - `spec/lib/kita` for rollup semantics: any-match, worst-state and Mine.
    - Request specs checking that the customers endpoint honours `assignee_type`, labels, team and custom-view params.
    - Redirect specs for `/conversations/:id`.

The winner is Proposal 2 ("Inbox = Customers, Front/Linear-style"). It had the highest combined score across the three judges: 126, against 119 for Proposal 4, 116 for Proposal 1 and 115 for Proposal 3. From the others I took:
- **Proposal 4:** building on the Chatwoot filter service, and keeping the old routes registered for rollback.
- **Proposals 1 and 3:** the All tab and Resolve all. From Proposal 3, also Replied from phone and the account context in the right pane.
- **Proposal 1:** Not a customer.

None of these conflicts with the winner. I did not open the Paper artboards (S03/S04) or edit any files. The code references come from the proposals.