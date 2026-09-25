import { randomBytes } from 'node:crypto';
import { type ChatwootAppClient, type ChatwootClient, downloadAttachments, toOutbound, type KitaDeskClient, type MessageAttributes } from './chatwoot.ts';
import { log } from './log.ts';
import type { ScopeChannel, ScopeCheck } from './scope.ts';
import { CUSTOMERS, type ChannelRow, type ConversationRow, type Store } from './store.ts';
import { MIRROR_PLATFORMS, SENDABLE_PLATFORMS, type AgentIdentity, type RefusalReason, type InboundMessage, type OutboundAttachment, type OutboundMessage, type Platform, type Sender } from './types.ts';

export interface BridgeDeps {
  store: Store;
  chatwoot: ChatwootClient;
  /** Identifier of the single "Customers" API inbox every platform posts into. */
  inbox: string;
  senders: Partial<Record<Platform, Sender>>;
  /** Public base URL of the bridge, used for customer-facing /media links. */
  publicUrl: string;
  /** Application API client: private notes and conversation custom attributes. Optional. */
  app?: ChatwootAppClient;
  /** Desk endpoints: staff messages as the matching agent (by email), conversation merges. Optional. */
  desk?: KitaDeskClient;
  /** Signed per-agent connect link, included in "connect your account" notes. */
  connectLink?: (agent: AgentIdentity) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Grip scope: drops out-of-scope channels and maps channels to customer accounts. Absent = allow all, no accounts. */
  scope?: ScopeCheck;
}

export type InboundResult = 'duplicate' | 'created' | 'appended' | 'staff_synced' | 'ignored' | 'out_of_scope';

/** Maps a platform user to a Chatwoot contact identifier. Namespaced so ids never collide across platforms. */
export const contactIdentifier = (platform: Platform, userKey: string) => `${platform}:${userKey}`;

const PLATFORM_NAME: Record<Platform, string> = { slack: 'Slack', teams: 'Microsoft Teams', viber: 'Viber', whatsapp: 'WhatsApp' };
const FINGERPRINT_TTL_MS = 5 * 60 * 1000;

/** WhatsApp and Viber are mirrors: nothing typed in the desk is ever sent; the agent gets this private note. */
export const MIRROR_NOTE: Record<'whatsapp' | 'viber', string> = {
  whatsapp: 'Reply in WhatsApp yourself — this inbox is a mirror. Nothing typed here is sent to the customer.',
  viber: 'Reply in Viber yourself — this inbox is a mirror. Nothing typed here is sent to the customer.',
};

/** channel_key of a message (every parser stamps it; the fallback is only for hand-built messages). */
export const channelKeyOf = (msg: InboundMessage) => msg.conversationAttributes?.channel_key || `${msg.platform}:${msg.threadKey}`;

/** Human label of a channel: "#kita-tala", "+63 917…", the Viber user's name; else the key itself. */
function labelOf(msg: InboundMessage, channelKey: string, previous?: string): string {
  const explicit = msg.conversationAttributes?.channel_label;
  if (explicit) return explicit;
  if (previous && previous !== channelKey) return previous;
  if (msg.platform === 'whatsapp') return channelKey.replace(/^whatsapp:/, '');
  if (msg.platform === 'viber' && msg.userName) return msg.userName;
  return channelKey;
}

/** Conversation key: one per Grip account, else one per (not yet linked) channel. */
export const conversationKey = (channelKey: string, sc?: ScopeChannel) => (sc?.account_id ? `account:${sc.account_id}` : `channel:${channelKey}`);

/**
 * Letters/digits only, lowercased, URLs dropped: survives markdown <-> Slack mrkdwn / Teams HTML
 * conversion (which reorder or drop link targets) and name prefixes.
 */
export const normalizeForEcho = (s: string) =>
  s
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/[^\s|>)\]]+/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

type Owner = { identifier: string; name: string; avatarUrl?: string; customAttributes?: Record<string, string> };

export class Bridge {
  private d: BridgeDeps;
  /**
   * Text fingerprints of replies being sent, per channel. Closes the race where the platform delivers
   * our own post (from an agent's account) before send() has returned its message id.
   */
  private recentOut = new Map<string, { norm: string; exp: number }[]>();

  constructor(deps: BridgeDeps) {
    this.d = deps;
  }

  private isOurEcho(msg: InboundMessage): boolean {
    const now = Date.now();
    const list = (this.recentOut.get(channelKeyOf(msg)) ?? []).filter((f) => f.exp > now);
    const norm = normalizeForEcho(msg.text);
    return norm.length > 0 && list.some((f) => f.norm.length > 0 && norm.includes(f.norm));
  }

  private rememberOut(channelKey: string, text: string) {
    const now = Date.now();
    const list = (this.recentOut.get(channelKey) ?? []).filter((f) => f.exp > now);
    list.push({ norm: normalizeForEcho(text), exp: now + FINGERPRINT_TTL_MS });
    this.recentOut.set(channelKey, list);
  }

  /** True if Grip says this channel is out of scope; logged with the key only (never content). */
  outOfScope(msg: InboundMessage): boolean {
    const key = msg.conversationAttributes?.channel_key;
    if (!this.d.scope || this.d.scope.allows(key)) return false;
    log.info('out_of_scope_dropped', { platform: msg.platform, channel_key: key });
    return true;
  }

  private scopeChannel(channelKey: string): ScopeChannel | undefined {
    return this.d.scope?.channel?.(channelKey);
  }

  /** Platform message -> Chatwoot. Customers become incoming messages; Kita staff typing directly become outgoing. */
  async inbound(msg: InboundMessage): Promise<InboundResult> {
    const { store } = this.d;
    if (this.outOfScope(msg)) return 'out_of_scope';
    const seenKey = `in:${msg.platform}:${msg.eventId}`;
    if (msg.echoKeys?.some((k) => store.isSeen(`in:${msg.platform}:${k}`))) return 'duplicate';
    if (!store.markSeen(seenKey)) return 'duplicate';
    try {
      return msg.author === 'staff' ? await this.staffInbound(msg) : await this.customerInbound(msg);
    } catch (e) {
      store.forget(seenKey); // allow the platform's retry to succeed
      throw e;
    }
  }

  /** Desk contact in the Customers inbox, created on first sight; returns its source_id. */
  private async ensureContact(c: Owner) {
    const { inbox, store } = this.d;
    let sourceId = store.getContactSourceId(inbox, c.identifier);
    if (!sourceId) {
      sourceId = await this.d.chatwoot.createContact(inbox, {
        identifier: c.identifier,
        name: c.name,
        ...(c.avatarUrl ? { avatar_url: c.avatarUrl } : {}),
        custom_attributes: c.customAttributes ?? {},
      });
      store.putContact(inbox, c.identifier, sourceId);
    }
    return sourceId;
  }

  /** Creates the desk conversation for `threadKey`, owned by the company (or the channel while unlinked). */
  private async openConversation(threadKey: string, owner: Owner, channels: ChannelRow[], sc?: ScopeChannel): Promise<ConversationRow> {
    const sourceId = await this.ensureContact(owner);
    const attrs = conversationAttributes(channels, sc);
    const conversationId = await this.d.chatwoot.createConversation(this.d.inbox, sourceId, attrs);
    const conv: ConversationRow = { platform: CUSTOMERS, threadKey, conversationId, sourceId, replyRef: {} };
    this.d.store.putConversation(conv);
    this.d.store.putKv(`attrs:${conversationId}`, JSON.stringify(attrs));
    log.info('conversation_created', { conversation: conversationId, key: threadKey.startsWith('account:') ? threadKey : 'channel' });
    return conv;
  }

  private accountOwner(sc: ScopeChannel): Owner {
    return { identifier: `grip-account:${sc.account_id}`, name: sc.account_name || `Account ${sc.account_id}`, customAttributes: { grip_account_id: String(sc.account_id) } };
  }

  /**
   * The customer's one conversation for this message's channel: `account:<id>` when Grip links the
   * channel to an account (merging an earlier `channel:` conversation into it), else `channel:<key>`.
   * Records the channel (reply target, label, last activity) and refreshes the conversation attributes.
   */
  private async ensureConversation(msg: InboundMessage) {
    const { store } = this.d;
    const channelKey = channelKeyOf(msg);
    const prev = store.getChannel(channelKey);
    const label = labelOf(msg, channelKey, prev?.label);
    const sc = this.scopeChannel(channelKey);
    if (sc?.account_id) await this.mergeChannel(channelKey, sc);
    const threadKey = conversationKey(channelKey, sc);
    let conv = store.getByThread(CUSTOMERS, threadKey);
    let result: InboundResult = 'appended';
    const now = Date.now();
    const channel = (conversationId: number): ChannelRow => ({
      channelKey, conversationId, platform: msg.platform, label, lastAt: now,
      replyRef: { ...(prev && prev.conversationId === conversationId ? prev.replyRef : {}), ...msg.replyRef },
    });
    if (!conv) {
      const owner = sc?.account_id
        ? this.accountOwner(sc)
        : { identifier: `${msg.platform}-channel:${channelKey}`, name: label, customAttributes: { channel: msg.platform } };
      conv = await this.openConversation(threadKey, owner, [channel(0)], sc);
      result = 'created';
    }
    store.putChannel(channel(conv.conversationId));
    await this.syncAttributes(conv.conversationId, sc);
    return { conv, channelKey, label, result };
  }

  /**
   * A channel that now belongs to a Grip account: its `channel:` conversation (if any) is merged into
   * the account's conversation by the desk, and the store is repointed. Returns true if it merged.
   */
  private async mergeChannel(channelKey: string, sc: ScopeChannel): Promise<boolean> {
    const { store, desk } = this.d;
    const from = store.getByThread(CUSTOMERS, `channel:${channelKey}`);
    if (!from) return false;
    const toKey = `account:${sc.account_id}`;
    const to = store.getByThread(CUSTOMERS, toKey) ?? (await this.openConversation(toKey, this.accountOwner(sc), store.channelsFor(from.conversationId), sc));
    if (desk) {
      const { moved } = await desk.mergeConversations(from.conversationId, to.conversationId);
      log.info('conversation_merged', { from: from.conversationId, to: to.conversationId, moved });
    } else log.warn('conversation_merge_skipped', { reason: 'no_desk_client', from: from.conversationId, to: to.conversationId });
    store.repointChannels(from.conversationId, to.conversationId);
    store.deleteConversation(CUSTOMERS, from.threadKey);
    return true;
  }

  /**
   * After every Grip scope refresh: merge `channel:` conversations whose channel is now linked to an
   * account, and refresh the attributes (owner, stage, channels) of every account conversation.
   * Never throws; returns how many channel conversations were merged.
   */
  async linkChannels(): Promise<number> {
    const { store } = this.d;
    let merged = 0;
    for (const conv of store.listConversations(CUSTOMERS, 'channel:')) {
      const key = conv.threadKey.slice('channel:'.length);
      const sc = this.scopeChannel(key);
      if (!sc?.account_id) continue;
      try {
        if (await this.mergeChannel(key, sc)) merged++;
      } catch (e: any) {
        log.error('conversation_merge_failed', { channel_key: key, error: String(e?.message ?? e) });
      }
    }
    for (const conv of store.listConversations(CUSTOMERS, 'account:')) {
      const sc = store.channelsFor(conv.conversationId).map((c) => this.scopeChannel(c.channelKey)).find((x) => x?.account_id);
      await this.syncAttributes(conv.conversationId, sc);
    }
    return merged;
  }

  /** Writes the conversation's custom attributes (merge) when they changed. Best effort. */
  private async syncAttributes(conversationId: number, sc?: ScopeChannel) {
    const { app, store } = this.d;
    if (!app) return;
    const attrs = conversationAttributes(store.channelsFor(conversationId), sc);
    const json = JSON.stringify(attrs);
    if (store.getKv(`attrs:${conversationId}`) === json) return;
    try {
      await app.updateCustomAttributes(conversationId, attrs);
      store.putKv(`attrs:${conversationId}`, json);
    } catch (e: any) {
      log.warn('conversation_attributes_failed', { conversation: conversationId, error: String(e?.message ?? e) });
    }
  }

  /** Platform, channel, thread and native reply target recorded on every message the bridge creates. */
  private attributes(msg: InboundMessage, channelKey: string, label: string): MessageAttributes {
    const t = msg.thread;
    const inReplyTo = t?.reply ? this.d.store.getMessageByExt(msg.platform, t.root)?.deskId : undefined;
    return {
      external_source: msg.platform,
      external_channel: label,
      external_channel_key: channelKey,
      ...(t ? { external_thread: { root: t.root } } : {}),
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    };
  }

  private remember(msg: InboundMessage, deskId: number, channelKey: string) {
    this.d.store.putMessage(msg.platform, msg.eventId, deskId, msg.thread?.root ?? msg.eventId, channelKey);
  }

  private async customerInbound(msg: InboundMessage): Promise<InboundResult> {
    const { chatwoot, inbox } = this.d;
    const { conv, channelKey, label, result } = await this.ensureConversation(msg);
    // The conversation belongs to the company (or channel); the message is authored by the person who wrote it.
    const senderIdentifier = msg.contactIdentifier ?? contactIdentifier(msg.platform, msg.userKey);
    await this.ensureContact({ identifier: senderIdentifier, name: msg.userName || msg.userKey, avatarUrl: msg.userAvatarUrl, customAttributes: { channel: msg.platform } });
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const content = composeInboundText(msg.text, failed.map((f) => f.url));
    const deskId = await chatwoot.createMessage(inbox, conv.sourceId, conv.conversationId, content, files, `${msg.platform}:${msg.eventId}`, {
      senderIdentifier,
      contentAttributes: this.attributes(msg, channelKey, label),
    });
    this.remember(msg, deskId, channelKey);
    log.info('inbound', { platform: msg.platform, conversation: conv.conversationId, result, files: files.length });
    return result;
  }

  /**
   * A Kita team member wrote in Slack/Teams outside the desk: mirror it into the customer's
   * conversation as an outgoing message authored by them (the desk matches their email to an agent,
   * or shows them as a Kita-staff contact with their own name and avatar). Never a name prefix, never
   * the shared bridge user. Its desk id is pre-marked, so it is never sent back out.
   */
  private async staffInbound(msg: InboundMessage): Promise<InboundResult> {
    const { store, desk } = this.d;
    if (this.isOurEcho(msg)) return 'duplicate';
    if (!desk) return 'ignored';
    const { conv, channelKey, label } = await this.ensureConversation(msg);
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const who = { email: msg.userEmail, staffKey: `${msg.platform}:${msg.userKey}`, name: msg.userName || msg.userKey, avatarUrl: msg.userAvatarUrl };
    const created = await desk.staffMessage(conv.conversationId, who, {
      content: composeInboundText(msg.text, failed.map((f) => f.url)),
      files,
      contentAttributes: this.attributes(msg, channelKey, label),
    });
    store.markSeen(`out:${created.id}`);
    this.remember(msg, created.id, channelKey);
    log.info('staff_synced', { platform: msg.platform, conversation: conv.conversationId });
    return 'staff_synced';
  }

  /**
   * A message the teammate sent from their own phone (WhatsApp Business app echo): mirror it as an
   * outgoing message authored by that teammate (desk agent by `ownerEmail`, else a Kita-staff contact
   * named `ownerName`), creating the conversation if they started it. Without the desk endpoint, the
   * owner's own Chatwoot client (`ownerApp`) is used; never the shared bridge user.
   */
  async businessEcho(msg: InboundMessage, o: { ownerName: string; ownerEmail?: string; ownerKey: string; ownerApp?: ChatwootAppClient }): Promise<InboundResult> {
    const { store, desk } = this.d;
    const seenKey = `in:${msg.platform}:${msg.eventId}`;
    if (!desk && !o.ownerApp) return 'ignored';
    if (this.outOfScope(msg)) return 'out_of_scope';
    if (!store.markSeen(seenKey)) return 'duplicate';
    try {
      const { conv, channelKey, label } = await this.ensureConversation(msg);
      const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
      const content = composeInboundText(msg.text, failed.map((f) => f.url));
      const contentAttributes = this.attributes(msg, channelKey, label);
      const created = desk
        ? await desk.staffMessage(conv.conversationId, { email: o.ownerEmail, staffKey: o.ownerKey, name: o.ownerName }, { content, files, contentAttributes })
        : await o.ownerApp!.createMessage(conv.conversationId, { content, private: false, files, contentAttributes });
      store.markSeen(`out:${created.id}`);
      this.remember(msg, created.id, channelKey);
      log.info('business_echo', { platform: msg.platform, conversation: conv.conversationId });
      return 'staff_synced';
    } catch (e) {
      store.forget(seenKey);
      throw e;
    }
  }

  /**
   * Customers must never see Chatwoot URLs: each attachment gets an unguessable bridge URL
   * (<public>/media/<token>/<name>) that streams the bytes from Chatwoot storage.
   */
  private proxied(a: OutboundAttachment): OutboundAttachment {
    const token = randomBytes(24).toString('base64url');
    this.d.store.putMedia(token, a.sourceUrl, a.name);
    return { ...a, url: `${this.d.publicUrl.replace(/\/$/, '')}/media/${token}/${encodeURIComponent(a.name)}` };
  }

  /**
   * Where an agent reply goes: (1) "Reply to" -> the replied message's channel + platform thread;
   * (2) content_attributes.kita_channel_key -> that channel, top level; (3) the most recently active
   * sendable (Slack/Teams) channel, else the most recent channel (a mirror -> note, nothing sent).
   */
  private target(conversationId: number, msg: OutboundMessage): { channel?: ChannelRow; root?: string; reason?: string } {
    const { store } = this.d;
    const mine = (key?: string) => {
      const c = key ? store.getChannel(key) : undefined;
      return c && c.conversationId === conversationId ? c : undefined;
    };
    if (msg.inReplyTo) {
      const m = store.getMessageByDesk(msg.inReplyTo);
      const c = mine(m?.channelKey);
      if (c) return { channel: c, root: m!.root };
    }
    if (msg.channelKey) {
      const c = mine(msg.channelKey);
      return c ? { channel: c } : { reason: 'unknown_channel' };
    }
    const all = store.channelsFor(conversationId);
    const c = all.find((x) => SENDABLE_PLATFORMS.includes(x.platform)) ?? all[0];
    return c ? { channel: c } : { reason: 'no_channel' };
  }

  /**
   * Customers-inbox webhook -> platform. Returns why it was skipped, 'sent', or 'refused:<reason>' when
   * the agent can't post as themselves (nothing is posted; the caller answers 4xx so the desk marks it failed).
   */
  async outbound(payload: any): Promise<string> {
    const { store } = this.d;
    // Webhook ids are display ids.
    if (payload?.event === 'conversation_status_changed' && payload.id && payload.status) {
      store.setConversationStatus(CUSTOMERS, Number(payload.id), String(payload.status));
      return `status:${payload.status}`;
    }
    const decision = toOutbound(payload);
    if (!decision.send) return `skip:${decision.reason}`;
    const conv = store.getByConversation(CUSTOMERS, decision.message.conversationId);
    if (!conv) return 'skip:unmapped_conversation';
    const { channel, root, reason } = this.target(conv.conversationId, decision.message);
    if (!channel) return `skip:${reason}`;
    const platform = channel.platform;
    const seenKey = `out:${decision.message.messageId}`;
    if (MIRROR_PLATFORMS.includes(platform)) {
      if (!store.markSeen(seenKey)) return 'skip:duplicate';
      await this.d.app?.createMessage(conv.conversationId, { content: MIRROR_NOTE[platform as 'whatsapp' | 'viber'], private: true });
      return 'skip:mirror';
    }
    const sender = this.d.senders[platform];
    if (!sender) return 'skip:platform_disabled';
    if (!store.markSeen(seenKey)) return 'skip:duplicate';
    let refused: RefusalReason | undefined;
    try {
      const msg = { ...decision.message, attachments: decision.message.attachments.map((a) => this.proxied(a)) };
      this.rememberOut(channel.channelKey, msg.text);
      const ref = root ? { ...channel.replyRef, ...threadRef(platform, root) } : topLevelRef(channel.replyRef);
      const result = await sender.send(ref, msg);
      for (const id of result?.echoes ?? []) store.markSeen(`in:${platform}:${id}`);
      const first = result?.echoes?.find((id) => !id.startsWith('file:'));
      if (first) store.putMessage(platform, first, msg.messageId, root ?? first, channel.channelKey);
      refused = result?.refused;
    } catch (e) {
      store.forget(seenKey);
      throw e;
    }
    if (refused) await this.refusedNote(platform, conv.conversationId, decision.message.agent, refused);
    log.info('outbound', { platform, conversation: decision.message.conversationId, message: decision.message.messageId, refused });
    return refused ? `refused:${refused}` : 'sent';
  }

  /** Private note (agents only): the reply was NOT sent, and what to do about it. */
  private async refusedNote(platform: Platform, conversationId: number, agent: AgentIdentity | undefined, reason: RefusalReason) {
    if (!this.d.app) return;
    const name = PLATFORM_NAME[platform];
    const link = agent ? this.d.connectLink?.(agent) : undefined;
    const content =
      reason === 'not_connected'
        ? `Not sent — connect your ${name} account first (Profile → Connect accounts).${link ? ` ${link}` : ''}`
        : `Not sent — you're not in this ${platform === 'teams' ? 'channel or chat' : 'channel'} yet. Ask to be added, then send it again.`;
    await this.d.app.createMessage(conversationId, { content, private: true }).catch((e) => log.warn('refused_note_failed', { error: String(e?.message ?? e) }));
  }
}

/**
 * Contract custom attributes of a customer conversation: Grip account + DRI (+ stage/health when Grip
 * sends them), the primary channel, and kita_channels (JSON, most recently active first).
 */
export function conversationAttributes(channels: ChannelRow[], sc?: ScopeChannel): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  };
  if (sc?.account_id) {
    put('grip_account', sc.account_name);
    put('grip_account_id', sc.account_id);
    put('account_owner', sc.dri_name);
    put('account_owner_email', sc.dri_email);
    put('customer_stage', sc.phase ?? (sc.in_scope === true ? 'active' : undefined));
    put('customer_health', sc.health);
  }
  const primary = channels.find((c) => SENDABLE_PLATFORMS.includes(c.platform)) ?? channels[0];
  put('channel_key', primary?.channelKey);
  out.kita_channels = JSON.stringify(channels.map((c) => ({ key: c.channelKey, platform: c.platform, label: c.label, sendable: SENDABLE_PLATFORMS.includes(c.platform) })));
  return out;
}

/** Message id part of an eventId-format id ("<channel>:<ts>", "<teams channel id>:<message id>"). */
const lastPart = (id: string) => id.slice(id.lastIndexOf(':') + 1);

/** Reply target for a thread root: Slack thread_ts, Teams channel root message (chats have no threads). */
function threadRef(platform: Platform, root: string): Record<string, unknown> {
  if (platform === 'slack') return { threadTs: lastPart(root) };
  if (platform === 'teams') return { rootId: lastPart(root) };
  return {};
}

/** Same container, no thread: a new top-level Slack/Teams channel message. */
function topLevelRef(ref: Record<string, unknown>): Record<string, unknown> {
  const { threadTs: _t, rootId: _r, ...rest } = ref;
  return rest;
}

export function composeInboundText(text: string, failedUrls: string[]): string {
  let out = text ?? '';
  if (failedUrls.length) out += `${out ? '\n\n' : ''}Attachments (not copied):\n${failedUrls.map((u) => `- ${u}`).join('\n')}`;
  return out;
}
