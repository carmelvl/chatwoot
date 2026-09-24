export type Platform = 'slack' | 'teams' | 'viber';

export interface InboundAttachment {
  url: string;
  name: string;
  contentType?: string;
  /** Extra headers needed to download the file (e.g. Slack bot token). */
  headers?: Record<string, string>;
}

/** A customer message normalised from any platform. */
export interface InboundMessage {
  platform: Platform;
  /** Dedupe key for platform retries (Slack event_id, Viber message_token, Teams activity id). */
  eventId: string;
  /** Stable id of the human (becomes the Chatwoot contact identifier). */
  userKey: string;
  userName?: string;
  /** Stable id of the thread/chat (becomes one Chatwoot conversation). */
  threadKey: string;
  /** Opaque data needed to reply into this thread later (Slack channel+ts, Teams channel thread / chat id, Viber user id). */
  replyRef: Record<string, unknown>;
  text: string;
  attachments: InboundAttachment[];
  /** Extra context shown to agents on the Chatwoot conversation. */
  conversationAttributes?: Record<string, string>;
  /** Long-lived containers (Teams group chats): start a fresh conversation once the last one was resolved. */
  newConversationIfResolved?: boolean;
}

export interface OutboundAttachment {
  /** Customer-facing URL (the bridge's own /media proxy; never a Chatwoot URL). */
  url: string;
  /** Where the bridge itself fetches the bytes from (Chatwoot storage). Never shown to customers. */
  sourceUrl: string;
  name: string;
  fileType?: string;
}

/** An agent reply normalised from Chatwoot's message_created webhook. Always sent as the "Kita" bot. */
export interface OutboundMessage {
  messageId: number;
  conversationId: number;
  text: string;
  attachments: OutboundAttachment[];
}

export interface Sender {
  /**
   * Delivers an agent reply. May return inbound event ids of the messages it created, so the
   * platform echo of our own post is recognised as a duplicate (belt-and-braces loop prevention).
   */
  send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<void | string[]>;
}
