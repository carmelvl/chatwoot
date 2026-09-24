import { hmacHex, safeEqual } from '../crypto.ts';
import type { InboundMessage, OutboundMessage, Sender } from '../types.ts';

const MAX_SKEW_S = 300;

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  headers: { signature?: string; timestamp?: string },
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  const { signature, timestamp } = headers;
  if (!signingSecret || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  return safeEqual(signature, `v0=${hmacHex(signingSecret, `v0:${timestamp}:${rawBody}`)}`);
}

export interface SlackParseOptions {
  botToken: string;
  internalTeamIds: string[];
  allowedChannels: string[];
}

export type SlackParsed =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'message'; message: InboundMessage };

const ALLOWED_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast']);

/**
 * Slack Events API payload -> normalised customer message.
 * Thread mapping: a top-level message in a shared channel opens a conversation keyed by
 * channel + its ts; every reply in that thread (thread_ts) lands in the same conversation and
 * agent replies are posted back into that thread.
 */
export function parseSlackEvent(payload: any, opts: SlackParseOptions): SlackParsed {
  if (payload?.type === 'url_verification') return { kind: 'challenge', challenge: String(payload.challenge ?? '') };
  if (payload?.type !== 'event_callback') return { kind: 'ignore', reason: `type:${payload?.type}` };
  const ev = payload.event ?? {};
  if (ev.type !== 'message') return { kind: 'ignore', reason: `event:${ev.type}` };
  // Loop prevention: our own chat.postMessage echoes back as a bot message.
  if (ev.bot_id || ev.bot_profile || ev.subtype === 'bot_message') return { kind: 'ignore', reason: 'bot' };
  if (!ALLOWED_SUBTYPES.has(ev.subtype)) return { kind: 'ignore', reason: `subtype:${ev.subtype}` };
  if (!ev.user) return { kind: 'ignore', reason: 'no_user' };
  const botUserIds = (payload.authorizations ?? []).filter((a: any) => a.is_bot).map((a: any) => a.user_id);
  if (botUserIds.includes(ev.user)) return { kind: 'ignore', reason: 'self' };
  const userTeam = ev.user_team ?? ev.team;
  if (userTeam && opts.internalTeamIds.includes(userTeam)) return { kind: 'ignore', reason: 'internal_user' };
  if (opts.allowedChannels.length && !opts.allowedChannels.includes(ev.channel)) return { kind: 'ignore', reason: 'channel_not_allowed' };

  const rootTs: string = ev.thread_ts ?? ev.ts;
  const attachments = (ev.files ?? [])
    .filter((f: any) => f?.url_private_download || f?.url_private)
    .map((f: any) => ({
      url: f.url_private_download ?? f.url_private,
      name: f.name ?? f.title ?? 'file',
      contentType: f.mimetype,
      headers: { authorization: `Bearer ${opts.botToken}` },
    }));
  return {
    kind: 'message',
    message: {
      platform: 'slack',
      eventId: payload.event_id ?? `${ev.channel}:${ev.ts}`,
      userKey: ev.user,
      threadKey: `${ev.channel}:${rootTs}`,
      replyRef: { channel: ev.channel, threadTs: rootTs },
      text: slackToMarkdown(ev.text ?? ''),
      attachments,
      conversationAttributes: { slack_channel: ev.channel, slack_team: String(userTeam ?? '') },
    },
  };
}

/** Slack mrkdwn -> Chatwoot markdown (links, entities, bold). Mentions stay as ids. */
export function slackToMarkdown(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1**$2**')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Chatwoot markdown -> Slack mrkdwn. */
export function markdownToSlack(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<$2|$1>');
}

export interface SlackIdentity {
  name: string;
  iconUrl?: string;
}

/** Text part of an agent reply. Always posted as the "Kita" bot identity; files are uploaded natively. */
export function buildSlackPost(replyRef: Record<string, unknown>, msg: OutboundMessage, who: SlackIdentity = { name: 'Kita' }) {
  return {
    channel: replyRef.channel as string,
    thread_ts: replyRef.threadTs as string,
    text: markdownToSlack(msg.text),
    username: who.name, // chat:write.customize
    ...(who.iconUrl ? { icon_url: who.iconUrl } : {}),
    unfurl_links: false,
    unfurl_media: false,
  };
}

export class SlackSender implements Sender {
  private token: string;
  private who: SlackIdentity;
  private fetchImpl: typeof fetch;
  constructor(token: string, who: SlackIdentity = { name: 'Kita' }, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.who = who;
    this.fetchImpl = fetchImpl;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
    return json;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<void> {
    if (msg.text.trim()) await this.api('chat.postMessage', buildSlackPost(replyRef, msg, this.who));
    for (const a of msg.attachments) await this.upload(replyRef, a);
  }

  /** Native Slack file in the thread (files:write): getUploadURLExternal -> POST bytes -> completeUploadExternal. */
  private async upload(replyRef: Record<string, unknown>, a: OutboundMessage['attachments'][number]): Promise<void> {
    const src = await this.fetchImpl(a.sourceUrl, { redirect: 'follow' });
    if (!src.ok) throw new Error(`attachment fetch ${src.status}`);
    const bytes = new Uint8Array(await src.arrayBuffer());
    const q = new URLSearchParams({ filename: a.name, length: String(bytes.byteLength) });
    const res = await this.fetchImpl(`https://slack.com/api/files.getUploadURLExternal?${q}`, { headers: { authorization: `Bearer ${this.token}` } });
    const up: any = await res.json();
    if (!up.ok) throw new Error(`slack files.getUploadURLExternal: ${up.error}`);
    const put = await this.fetchImpl(up.upload_url, { method: 'POST', body: bytes });
    if (!put.ok) throw new Error(`slack upload ${put.status}`);
    await this.api('files.completeUploadExternal', {
      files: [{ id: up.file_id, title: a.name }],
      channel_id: replyRef.channel,
      thread_ts: replyRef.threadTs,
    });
  }

  private names = new Map<string, string>();
  /** Best-effort display name (users:read); falls back to the id. */
  async userName(userId: string): Promise<string | undefined> {
    if (this.names.has(userId)) return this.names.get(userId);
    try {
      const res = await this.fetchImpl(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      const j: any = await res.json();
      const p = j.user?.profile ?? {};
      const name = p.real_name || p.display_name || j.user?.name;
      if (name) this.names.set(userId, name);
      return name;
    } catch {
      return undefined;
    }
  }
}
