import { ChatwootClient, downloadAttachments, toOutbound } from './chatwoot.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';
import type { InboundMessage, Platform, Sender } from './types.ts';

export interface BridgeDeps {
  store: Store;
  chatwoot: ChatwootClient;
  inboxes: Record<Platform, { inboxIdentifier: string }>;
  senders: Partial<Record<Platform, Sender>>;
  fetchImpl?: typeof fetch;
}

export type InboundResult = 'duplicate' | 'created' | 'appended';

/** Maps a platform user to a Chatwoot contact identifier. Namespaced so ids never collide across platforms. */
export const contactIdentifier = (platform: Platform, userKey: string) => `${platform}:${userKey}`;

export class Bridge {
  private d: BridgeDeps;
  constructor(deps: BridgeDeps) {
    this.d = deps;
  }

  /** Customer message -> Chatwoot (contact + conversation + incoming message). Idempotent on eventId. */
  async inbound(msg: InboundMessage): Promise<InboundResult> {
    const { store, chatwoot } = this.d;
    const inbox = this.d.inboxes[msg.platform].inboxIdentifier;
    const seenKey = `in:${msg.platform}:${msg.eventId}`;
    if (!store.markSeen(seenKey)) return 'duplicate';
    try {
      let sourceId = store.getContactSourceId(msg.platform, msg.userKey);
      if (!sourceId) {
        sourceId = await chatwoot.createContact(inbox, {
          identifier: contactIdentifier(msg.platform, msg.userKey),
          name: msg.userName || `${msg.platform} user ${msg.userKey}`,
          custom_attributes: { channel: msg.platform },
        });
        store.putContact(msg.platform, msg.userKey, sourceId);
      }

      let conv = store.getByThread(msg.platform, msg.threadKey);
      let result: InboundResult = 'appended';
      if (!conv) {
        const conversationId = await chatwoot.createConversation(inbox, sourceId, { channel: msg.platform, ...msg.conversationAttributes });
        conv = { platform: msg.platform, threadKey: msg.threadKey, conversationId, sourceId, replyRef: msg.replyRef };
        result = 'created';
      } else {
        // Refresh the reply reference (Teams serviceUrl can change; Slack keeps its thread root).
        conv = { ...conv, replyRef: { ...conv.replyRef, ...msg.replyRef } };
      }
      store.putConversation(conv);

      // A Chatwoot conversation belongs to one contact. Others joining the same Slack/Teams thread are
      // posted under the owner contact, with their name prefixed so agents can tell who spoke.
      const foreign = conv.sourceId !== sourceId;
      const { files, failed } = await downloadAttachments(msg.attachments, this.d.fetchImpl);
      const content = composeInboundText(msg.text, foreign ? msg.userName ?? msg.userKey : undefined, failed.map((f) => f.url));
      await chatwoot.createMessage(inbox, conv.sourceId, conv.conversationId, content, files, `${msg.platform}:${msg.eventId}`);
      log.info('inbound', { platform: msg.platform, conversation: conv.conversationId, result, files: files.length });
      return result;
    } catch (e) {
      store.forget(seenKey); // allow the platform's retry to succeed
      throw e;
    }
  }

  /** Chatwoot webhook -> platform. Returns why it was skipped, or 'sent'. Idempotent on message id. */
  async outbound(platform: Platform, payload: unknown): Promise<string> {
    const decision = toOutbound(payload);
    if (!decision.send) return `skip:${decision.reason}`;
    const msg = decision.message;
    const conv = this.d.store.getByConversation(platform, msg.conversationId);
    if (!conv) return 'skip:unmapped_conversation';
    const sender = this.d.senders[platform];
    if (!sender) return 'skip:platform_disabled';
    const seenKey = `out:${platform}:${msg.messageId}`;
    if (!this.d.store.markSeen(seenKey)) return 'skip:duplicate';
    try {
      await sender.send(conv.replyRef, msg);
    } catch (e) {
      this.d.store.forget(seenKey);
      throw e;
    }
    log.info('outbound', { platform, conversation: msg.conversationId, message: msg.messageId });
    return 'sent';
  }
}

export function composeInboundText(text: string, speaker: string | undefined, failedUrls: string[]): string {
  let out = text ?? '';
  if (speaker) out = `**${speaker}:** ${out}`;
  if (failedUrls.length) out += `${out ? '\n\n' : ''}Attachments (not copied):\n${failedUrls.map((u) => `- ${u}`).join('\n')}`;
  return out;
}

/** Plain-text rendering of an agent reply for channels that take attachments as links. */
export function outboundTextWithLinks(msg: { text: string; attachments: { url: string; name: string }[] }): string {
  const links = msg.attachments.map((a) => `${a.name}: ${a.url}`);
  return [msg.text, ...links].filter((s) => s && s.trim()).join('\n');
}
