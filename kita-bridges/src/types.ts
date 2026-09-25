export type Platform = 'slack' | 'teams' | 'viber' | 'whatsapp';

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
  /**
   * Slack/Teams: one desk conversation per channel or group chat. Its contact is the channel itself
   * ("#kita-tala"); each message is authored by the person who wrote it (their own contact).
   */
  channelConversation?: boolean;
  /** Platform thread: `root` is the root message's id in eventId format; `reply` = this is a thread reply. */
  thread?: { root: string; reply: boolean };
  /** Staff: the platform account's email (Slack profile, Graph mail/UPN), matched to a desk agent. */
  userEmail?: string;
  /** Public avatar URL of the person (Slack profile image), used for their desk contact. */
  userAvatarUrl?: string;
  /**
   * 'staff' = a Kita team member typed directly in Slack/Teams (outside the desk). Synced into the
   * mapped conversation as an outgoing agent message; never treated as a customer, never echoed back.
   */
  author?: 'customer' | 'staff';
  /** Extra ids that identify this message as one the bridge itself posted (e.g. Slack file ids). */
  echoKeys?: string[];
  /** Per-message inbox (WhatsApp: one inbox per business number). Defaults to the platform's inbox. */
  inboxIdentifier?: string;
  /** Contact identifier override (WhatsApp: whatsapp:+E164, shared across numbers). */
  contactIdentifier?: string;
}

/** The Chatwoot agent who wrote a reply. Replies go out as this person where the platform allows. */
export interface AgentIdentity {
  id: number;
  name: string;
  firstName: string;
  email?: string;
}

/** Why an agent reply was NOT sent: nothing is ever posted from a shared identity instead. */
export type RefusalReason = 'not_connected' | 'not_member';

export interface SendResult {
  /** Inbound event ids of what was posted, so the platform echo is recognised as ours. */
  echoes?: string[];
  /** Set when nothing was posted because the agent can't post as themselves (no shared-identity fallback). */
  refused?: RefusalReason;
}

export interface OutboundAttachment {
  /** Customer-facing URL (the bridge's own /media proxy; never a Chatwoot URL). */
  url: string;
  /** Where the bridge itself fetches the bytes from (Chatwoot storage). Never shown to customers. */
  sourceUrl: string;
  name: string;
  fileType?: string;
}

/** An agent reply normalised from Chatwoot's message_created webhook. */
export interface OutboundMessage {
  messageId: number;
  conversationId: number;
  text: string;
  attachments: OutboundAttachment[];
  /** Absent for automated messages (they go out as plain Kita). */
  agent?: AgentIdentity;
  /** Desk message this reply answers (Chatwoot "Reply to"): posted into that message's platform thread. */
  inReplyTo?: number;
}

export interface Sender {
  send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<SendResult | void>;
}
