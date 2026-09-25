import { randomBytes } from 'node:crypto';
import { ChatwootAppClient, ChatwootClient, downloadAttachments, toOutbound } from './chatwoot.ts';
import { log } from './log.ts';
import type { ScopeCheck } from './scope.ts';
import type { Store } from './store.ts';
import type { AgentIdentity, FallbackReason, InboundMessage, OutboundAttachment, Platform, Sender } from './types.ts';

export interface BridgeDeps {
  store: Store;
  chatwoot: ChatwootClient;
  inboxes: Record<Platform, { inboxIdentifier: string }>;
  senders: Partial<Record<Platform, Sender>>;
  /** Public base URL of the bridge, used for customer-facing /media links. */
  publicUrl: string;
  /** Application API client: private notes, staff-typed sync, avatars. Optional. */
  app?: ChatwootAppClient;
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
  private avatars = new Map<number, { url?: string; exp: number }>();

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

  /** Contact (by identifier) + mapped conversation for this thread, created on first contact. */
  private async ensureConversation(msg: InboundMessage) {
    const { store, chatwoot } = this.d;
    const inbox = msg.inboxIdentifier ?? this.d.inboxes[msg.platform].inboxIdentifier;
    let sourceId = store.getContactSourceId(msg.platform, msg.userKey);
    if (!sourceId) {
      sourceId = await chatwoot.createContact(inbox, {
        identifier: msg.contactIdentifier ?? contactIdentifier(msg.platform, msg.userKey),
        name: msg.userName || `${msg.platform} user ${msg.userKey}`,
        custom_attributes: { channel: msg.platform },
      });
      store.putContact(msg.platform, msg.userKey, sourceId);
    }

    let conv = store.getByThread(msg.platform, msg.threadKey);
    let result: InboundResult = 'appended';
    if (conv && conv.status === 'resolved' && msg.newConversationIfResolved) conv = undefined;
    if (!conv) {
      const conversationId = await chatwoot.createConversation(inbox, sourceId, { channel: msg.platform, ...msg.conversationAttributes });
      conv = { platform: msg.platform, threadKey: msg.threadKey, conversationId, sourceId, replyRef: msg.replyRef };
      result = 'created';
    } else {
      // Keep the reply reference fresh (merge, so thread roots are never lost).
      conv = { ...conv, replyRef: { ...conv.replyRef, ...msg.replyRef } };
    }
    store.putConversation(conv);
    return { inbox, sourceId, conv, result };
  }

  private async customerInbound(msg: InboundMessage): Promise<InboundResult> {
    const { chatwoot } = this.d;
    const { inbox, sourceId, conv, result } = await this.ensureConversation(msg);

    // A Chatwoot conversation belongs to one contact. Others joining the same Slack/Teams thread are
    // posted under the owner contact, with their name prefixed so agents can tell who spoke.
    const foreign = conv.sourceId !== sourceId;
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const content = composeInboundText(msg.text, foreign ? msg.userName ?? msg.userKey : undefined, failed.map((f) => f.url));
    await chatwoot.createMessage(inbox, conv.sourceId, conv.conversationId, content, files, `${msg.platform}:${msg.eventId}`);
    log.info('inbound', { platform: msg.platform, conversation: conv.conversationId, result, files: files.length });
    return result;
  }

  /**
   * A Kita team member wrote in Slack/Teams outside the desk: mirror it into the thread's conversation
   * as an outgoing message so the desk shows the full thread. Only for threads already mapped;
   * marked kita_bridge_origin (and its id pre-marked) so it is never sent back out.
   */
  private async staffInbound(msg: InboundMessage): Promise<InboundResult> {
    const { store, app } = this.d;
    if (this.isOurEcho(msg)) return 'duplicate';
    if (!app) return 'ignored';
    let conv = store.getByThread(msg.platform, msg.threadKey);
    if (!conv || (conv.status === 'resolved' && msg.newConversationIfResolved)) {
      // Kita started this thread: still a customer conversation. Its contact is the customer channel
      // itself (e.g. "#kita-tala"), so Grip links it to the account and later customer replies join it.
      const channelKey = msg.conversationAttributes?.channel_key ?? msg.threadKey;
      const label = msg.conversationAttributes?.channel_label ?? channelKey;
      ({ conv } = await this.ensureConversation({
        ...msg,
        userKey: `channel:${channelKey}`,
        userName: label,
        contactIdentifier: `${msg.platform}-channel:${channelKey}`,
      }));
    }
    const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
    const content = composeInboundText(msg.text, `${msg.userName ?? msg.userKey} (in ${PLATFORM_NAME[msg.platform]})`, failed.map((f) => f.url));
    const created = await app.createMessage(conv.conversationId, { content, private: false, files });
    store.markSeen(`out:${msg.platform}:${created.id}`);
    log.info('staff_synced', { platform: msg.platform, conversation: conv.conversationId });
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
      const created = await app.createMessage(conv.conversationId, { content, private: false, files });
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

  private async withAvatar(agent: AgentIdentity | undefined): Promise<AgentIdentity | undefined> {
    if (!agent || !this.d.app) return agent;
    let hit = this.avatars.get(agent.id);
    if (!hit || hit.exp < Date.now()) {
      const src = await this.d.app.avatarUrl(agent.id).catch(() => undefined);
      hit = { url: src ? this.proxied({ url: '', sourceUrl: src, name: 'avatar.png' }).url : undefined, exp: Date.now() + 24 * 3600_000 };
      this.avatars.set(agent.id, hit);
    }
    return hit.url ? { ...agent, avatarUrl: hit.url } : agent;
  }

  /** Chatwoot webhook -> platform. Returns why it was skipped, or 'sent' / 'sent:fallback:<reason>'. */
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
    let fallback: FallbackReason | undefined;
    try {
      const msg = {
        ...decision.message,
        attachments: decision.message.attachments.map((a) => this.proxied(a)),
        agent: platform === 'slack' ? await this.withAvatar(decision.message.agent) : decision.message.agent,
      };
      this.rememberOut(platform, conv.threadKey, msg.text);
      const result = await sender.send(conv.replyRef, msg);
      for (const id of result?.echoes ?? []) this.d.store.markSeen(`in:${platform}:${id}`);
      fallback = result?.fallback;
    } catch (e) {
      this.d.store.forget(seenKey);
      throw e;
    }
    if (fallback && decision.message.agent) await this.fallbackNote(platform, conv.conversationId, decision.message.agent, fallback);
    log.info('outbound', { platform, conversation: decision.message.conversationId, message: decision.message.messageId, fallback });
    return fallback ? `sent:fallback:${fallback}` : 'sent';
  }

  /** Private note (agents only) explaining why the reply went out from the shared Kita identity. */
  private async fallbackNote(platform: Platform, conversationId: number, agent: AgentIdentity, reason: FallbackReason) {
    if (!this.d.app) return;
    const name = PLATFORM_NAME[platform];
    const link = this.d.connectLink?.(agent);
    const content =
      reason === 'not_connected'
        ? `${agent.firstName}, this reply was sent from the shared Kita account (as "${agent.firstName}: …") because your ${name} account isn't connected.${link ? ` Connect it once so replies come from you: ${link}` : ' Ask an admin for your connect link.'}`
        : `${agent.firstName}, this reply was sent from the shared Kita account because your ${name} account isn't a member of this ${platform === 'teams' ? 'channel or chat' : 'channel'}. Ask to be added, and your next replies will come from you.`;
    await this.d.app.createMessage(conversationId, { content, private: true }).catch((e) => log.warn('fallback_note_failed', { error: String(e?.message ?? e) }));
  }
}

export function composeInboundText(text: string, speaker: string | undefined, failedUrls: string[]): string {
  let out = text ?? '';
  if (speaker) out = `**${speaker}:** ${out}`;
  if (failedUrls.length) out += `${out ? '\n\n' : ''}Attachments (not copied):\n${failedUrls.map((u) => `- ${u}`).join('\n')}`;
  return out;
}
