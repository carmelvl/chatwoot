import { randomBytes } from 'node:crypto';
import { ChatwootAppClient, ChatwootClient, downloadAttachments, toOutbound, type KitaDeskClient, type MessageAttributes } from './chatwoot.ts';
import { log } from './log.ts';
import type { ScopeCheck } from './scope.ts';
import type { Store } from './store.ts';
import type { AgentIdentity, RefusalReason, InboundMessage, OutboundAttachment, Platform, Sender } from './types.ts';

export interface BridgeDeps {
  store: Store;
  chatwoot: ChatwootClient;
  inboxes: Record<Platform, { inboxIdentifier: string }>;
  senders: Partial<Record<Platform, Sender>>;
  /** Public base URL of the bridge, used for customer-facing /media links. */
  publicUrl: string;
  /** Application API client: private notes and the staff-typed sync fallback. Optional. */
  app?: ChatwootAppClient;
  /** Desk endpoint that posts staff messages as the matching agent (by email). Optional. */
  desk?: KitaDeskClient;
  /** Signed per-agent connect link, included in "connect your account" notes. */
  connectLink?: (agent: AgentIdentity) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Grip scope: messages on out-of-scope channels are dropped before anything reaches Chatwoot. Absent = allow all. */
  scope?: ScopeCheck;
}

export type InboundResult = 'duplicate' | 'created' | 'appended' | 'staff_synced' | 'ignored' | 'out_of_scope';

/** Maps a platform user to a Chatwoot contact identifier. Namespaced so ids never collide across platforms. */
export const contactIdentifier = (platform: Platform, userKey: string) => `${platform}:${userKey}`;

const PLATFORM_NAME: Record<Platform, string> = { slack: 'Slack', teams: 'Microsoft Teams', viber: 'Viber', whatsapp: 'WhatsApp' };
const FINGERPRINT_TTL_MS = 5 * 60 * 1000;

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

export class Bridge {
  private d: BridgeDeps;
  /**
   * Text fingerprints of replies being sent, per thread. Closes the race where the platform delivers
   * our own post (from an agent's account) before send() has returned its message id.
   */
  private recentOut = new Map<string, { norm: string; exp: number }[]>();

  constructor(deps: BridgeDeps) {
    this.d = deps;
  }

  private isOurEcho(msg: InboundMessage): boolean {
    const now = Date.now();
    const list = (this.recentOut.get(`${msg.platform}:${msg.threadKey}`) ?? []).filter((f) => f.exp > now);
    const norm = normalizeForEcho(msg.text);
    return norm.length > 0 && list.some((f) => f.norm.length > 0 && norm.includes(f.norm));
  }

  private rememberOut(platform: Platform, threadKey: string, text: string) {
    const key = `${platform}:${threadKey}`;
    const now = Date.now();
    const list = (this.recentOut.get(key) ?? []).filter((f) => f.exp > now);
    list.push({ norm: normalizeForEcho(text), exp: now + FINGERPRINT_TTL_MS });
    this.recentOut.set(key, list);
  }

  /** True if Grip says this channel is out of scope; logged with the key only (never content). */
  outOfScope(msg: InboundMessage): boolean {
    const key = msg.conversationAttributes?.channel_key;
    if (!this.d.scope || this.d.scope.allows(key)) return false;
    log.info('out_of_scope_dropped', { platform: msg.platform, channel_key: key });
    return true;
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

  /** Desk contact for a platform user (or channel), created on first sight; returns its source_id. */
  private async ensureContact(inbox: string, platform: Platform, userKey: string, c: { identifier: string; name: string; avatarUrl?: string }) {
    let sourceId = this.d.store.getContactSourceId(platform, userKey);
    if (!sourceId) {
      sourceId = await this.d.chatwoot.createContact(inbox, {
        identifier: c.identifier,
        name: c.name,
        ...(c.avatarUrl ? { avatar_url: c.avatarUrl } : {}),
        custom_attributes: { channel: platform },
      });
      this.d.store.putContact(platform, userKey, sourceId);
    }
    return sourceId;
  }

  /**
   * Mapped conversation for this thread/chat, created on first contact. Slack/Teams channels and
   * group chats are one conversation whose contact is the channel; a resolved one is reopened by
   * the next message (Chatwoot reopens on incoming), never replaced.
   */
  private async ensureConversation(msg: InboundMessage) {
    const { store, chatwoot } = this.d;
    const inbox = msg.inboxIdentifier ?? this.d.inboxes[msg.platform].inboxIdentifier;
    const owner = msg.channelConversation ? channelContact(msg) : { userKey: msg.userKey, identifier: msg.contactIdentifier ?? contactIdentifier(msg.platform, msg.userKey), name: msg.userName || `${msg.platform} user ${msg.userKey}`, avatarUrl: msg.userAvatarUrl };
    const sourceId = await this.ensureContact(inbox, msg.platform, owner.userKey, owner);

    let conv = store.getByThread(msg.platform, msg.threadKey);
    let result: InboundResult = 'appended';
    if (!conv) {
      const conversationId = await chatwoot.createConversation(inbox, sourceId, { channel: msg.platform, ...msg.conversationAttributes });
      conv = { platform: msg.platform, threadKey: msg.threadKey, conversationId, sourceId, replyRef: msg.replyRef };
      result = 'created';
    } else {
      conv = { ...conv, replyRef: { ...conv.replyRef, ...msg.replyRef } };
    }
    store.putConversation(conv);
    return { inbox, sourceId, conv, result };
  }

  /** Platform, thread and native reply target recorded on every message the bridge creates. */
  private attributes(msg: InboundMessage): MessageAttributes {
    const t = msg.thread;
    const inReplyTo = t?.reply ? this.d.store.getMessageByExt(msg.platform, t.root)?.deskId : undefined;
    return { external_source: msg.platform, ...(t ? { external_thread: { root: t.root } } : {}), ...(inReplyTo ? { in_reply_to: inReplyTo } : {}) };
  }

  private remember(msg: InboundMessage, deskId: number) {
    this.d.store.putMessage(msg.platform, msg.eventId, deskId, msg.thread?.root ?? msg.eventId);
  }

  private async customerInbound(msg: InboundMessage): Promise<InboundResult> {
    const { chatwoot } = this.d;
    const { inbox, conv, result } = await this.ensureConversation(msg);
    // Channel conversations: the message is authored by the person who wrote it, not the channel contact.
    let senderIdentifier: string | undefined;
    if (msg.channelConversation) {
      senderIdentifier = contactIdentifier(msg.platform, msg.userKey);
      await this.ensureContact(inbox, msg.platform, msg.userKey, { identifier: senderIdentifier, name: msg.userName || msg.userKey, avatarUrl: msg.userAvatarUrl });
    }
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const content = composeInboundText(msg.text, undefined, failed.map((f) => f.url));
    const deskId = await chatwoot.createMessage(inbox, conv.sourceId, conv.conversationId, content, files, `${msg.platform}:${msg.eventId}`, {
      senderIdentifier,
      contentAttributes: this.attributes(msg),
    });
    this.remember(msg, deskId);
    log.info('inbound', { platform: msg.platform, conversation: conv.conversationId, result, files: files.length });
    return result;
  }

  /**
   * A Kita team member wrote in Slack/Teams outside the desk: mirror it into the channel's
   * conversation as an outgoing message authored by the matching desk agent (by email). With no
   * matching agent it goes through the bridge's own desk user as "**Name (in Slack):** …".
   * Either way it's marked kita_bridge_origin and its id pre-marked, so it is never sent back out.
   */
  private async staffInbound(msg: InboundMessage): Promise<InboundResult> {
    const { store, app, desk } = this.d;
    if (this.isOurEcho(msg)) return 'duplicate';
    if (!app && !desk) return 'ignored';
    // Kita may start the channel's conversation: its contact is still the channel ("#kita-tala").
    const { conv } = await this.ensureConversation(msg);
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const failedUrls = failed.map((f) => f.url);
    const contentAttributes = this.attributes(msg);
    let created = msg.userEmail && desk ? await desk.staffMessage(conv.conversationId, msg.userEmail, { content: composeInboundText(msg.text, undefined, failedUrls), files, contentAttributes }) : undefined;
    const asAgent = Boolean(created);
    if (!created) {
      if (!app) return 'ignored';
      const content = composeInboundText(msg.text, `${msg.userName ?? msg.userKey} (in ${PLATFORM_NAME[msg.platform]})`, failedUrls);
      created = await app.createMessage(conv.conversationId, { content, private: false, files, contentAttributes });
    }
    store.markSeen(`out:${msg.platform}:${created.id}`);
    this.remember(msg, created.id);
    log.info('staff_synced', { platform: msg.platform, conversation: conv.conversationId, as_agent: asAgent });
    return 'staff_synced';
  }

  /**
   * A message the business sent from its own app (WhatsApp Business app echo): mirror it as an
   * outgoing message, creating the conversation if the business started it. Attributed natively when
   * `app` is the owner's own Chatwoot client, else "**Owner:** …" through the bridge's client.
   */
  async businessEcho(msg: InboundMessage, o: { ownerName: string; ownerApp?: ChatwootAppClient }): Promise<InboundResult> {
    const { store } = this.d;
    const app = o.ownerApp ?? this.d.app;
    const seenKey = `in:${msg.platform}:${msg.eventId}`;
    if (!app) return 'ignored';
    if (this.outOfScope(msg)) return 'out_of_scope';
    if (!store.markSeen(seenKey)) return 'duplicate';
    try {
      const { conv } = await this.ensureConversation(msg);
      const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
      const content = composeInboundText(msg.text, o.ownerApp ? undefined : o.ownerName, failed.map((f) => f.url));
      const created = await app.createMessage(conv.conversationId, { content, private: false, files, contentAttributes: this.attributes(msg) });
      store.markSeen(`out:${msg.platform}:${created.id}`);
      log.info('business_echo', { platform: msg.platform, conversation: conv.conversationId });
      return 'staff_synced';
    } catch (e) {
      store.forget(seenKey);
      throw e;
    }
  }

  /** Mirror-mode inboxes: an agent typed in the desk; nothing is sent, the agent gets a private note (once per message). */
  async mirrorNotice(platform: Platform, payload: any, note: string): Promise<string> {
    if (payload?.event === 'conversation_status_changed') return this.outbound(platform, payload);
    const d = toOutbound(payload);
    if (!d.send) return `skip:${d.reason}`;
    if (!this.d.store.markSeen(`out:${platform}:${d.message.messageId}`)) return 'skip:duplicate';
    await this.d.app?.createMessage(d.message.conversationId, { content: note, private: true });
    return 'skip:mirror';
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
   * Chatwoot webhook -> platform. Returns why it was skipped, 'sent', or 'refused:<reason>' when the
   * agent can't post as themselves (nothing is posted; the caller answers 4xx so the desk marks it failed).
   */
  async outbound(platform: Platform, payload: any): Promise<string> {
    // Track resolution so long-lived chats can open a fresh conversation next time (webhook ids are display ids).
    if (payload?.event === 'conversation_status_changed' && payload.id && payload.status) {
      this.d.store.setConversationStatus(platform, Number(payload.id), String(payload.status));
      return `status:${payload.status}`;
    }
    const decision = toOutbound(payload);
    if (!decision.send) return `skip:${decision.reason}`;
    const conv = this.d.store.getByConversation(platform, decision.message.conversationId);
    if (!conv) return 'skip:unmapped_conversation';
    const sender = this.d.senders[platform];
    if (!sender) return 'skip:platform_disabled';
    const seenKey = `out:${platform}:${decision.message.messageId}`;
    if (!this.d.store.markSeen(seenKey)) return 'skip:duplicate';
    let refused: RefusalReason | undefined;
    try {
      const msg = {
        ...decision.message,
        attachments: decision.message.attachments.map((a) => this.proxied(a)),
      };
      this.rememberOut(platform, conv.threadKey, msg.text);
      // "Reply to" in the desk -> that message's platform thread; otherwise a new top-level post.
      const root = msg.inReplyTo ? this.d.store.getMessageByDesk(platform, msg.inReplyTo)?.root : undefined;
      const result = await sender.send(root ? { ...conv.replyRef, ...threadRef(platform, root) } : topLevelRef(conv.replyRef), msg);
      for (const id of result?.echoes ?? []) this.d.store.markSeen(`in:${platform}:${id}`);
      const first = result?.echoes?.find((id) => !id.startsWith('file:'));
      if (first) this.d.store.putMessage(platform, first, msg.messageId, root ?? first);
      refused = result?.refused;
    } catch (e) {
      this.d.store.forget(seenKey);
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

/** The channel as a contact ("#kita-tala"): owner of a Slack/Teams channel conversation. */
function channelContact(msg: InboundMessage) {
  const channelKey = msg.conversationAttributes?.channel_key ?? msg.threadKey;
  return { userKey: `channel:${channelKey}`, identifier: `${msg.platform}-channel:${channelKey}`, name: msg.conversationAttributes?.channel_label ?? channelKey };
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

export function composeInboundText(text: string, speaker: string | undefined, failedUrls: string[]): string {
  let out = text ?? '';
  if (speaker) out = `**${speaker}:** ${out}`;
  if (failedUrls.length) out += `${out ? '\n\n' : ''}Attachments (not copied):\n${failedUrls.map((u) => `- ${u}`).join('\n')}`;
  return out;
}
