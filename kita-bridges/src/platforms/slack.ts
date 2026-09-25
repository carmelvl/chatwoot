import { hmacHex, safeEqual } from '../crypto.ts';
import { seal, unseal } from '../crypto.ts';
import { log } from '../log.ts';
import type { Store } from '../store.ts';
import type { InboundMessage, OutboundMessage, Sender, SendResult } from '../types.ts';

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
  // Kita staff typing directly in the shared channel: synced as outgoing agent messages, not customer ones.
  const author = userTeam && opts.internalTeamIds.includes(userTeam) ? 'staff' : 'customer';
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
      // channel:ts (not event_id) so the ts returned by our own chat.postMessage marks the echo as seen.
      eventId: `${ev.channel}:${ev.ts}`,
      echoKeys: (ev.files ?? []).filter((f: any) => f?.id).map((f: any) => `file:${f.id}`),
      author,
      userKey: ev.user,
      threadKey: `${ev.channel}:${rootTs}`,
      replyRef: { channel: ev.channel, threadTs: rootTs },
      text: slackToMarkdown(ev.text ?? ''),
      attachments,
      conversationAttributes: { channel_key: `slack:${ev.channel}`, slack_channel: ev.channel, slack_team: String(userTeam ?? '') },
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

/** Text part of a reply. `who` set = bot post with a custom name/icon; unset = the agent's own user token. */
export function buildSlackPost(replyRef: Record<string, unknown>, msg: OutboundMessage, who?: SlackIdentity) {
  return {
    channel: replyRef.channel as string,
    thread_ts: replyRef.threadTs as string,
    text: markdownToSlack(msg.text),
    ...(who ? { username: who.name } : {}), // chat:write.customize
    ...(who?.iconUrl ? { icon_url: who.iconUrl } : {}),
    unfurl_links: false,
    unfurl_media: false,
  };
}

export class SlackApiError extends Error {
  code: string;
  constructor(method: string, code: string) {
    super(`slack ${method}: ${code}`);
    this.code = code;
  }
}

/** Errors meaning "this person's account can't post here" -> fall back to the bot. */
const NOT_MEMBER_ERRORS = new Set(['not_in_channel', 'channel_not_found', 'restricted_action', 'is_archived', 'token_revoked', 'invalid_auth', 'account_inactive']);

/**
 * Posts as the agent (their user token, chat:write + files:write) when they've connected; otherwise,
 * or if their account can't post in that channel, as the Kita bot with chat:write.customize showing
 * the agent's full name and avatar.
 */
export class SlackSender implements Sender {
  private token: string;
  private who: SlackIdentity;
  private fetchImpl: typeof fetch;
  private userToken: (agentId: number) => string | undefined;
  constructor(token: string, who: SlackIdentity = { name: 'Kita' }, fetchImpl: typeof fetch = fetch, userToken: (agentId: number) => string | undefined = () => undefined) {
    this.token = token;
    this.who = who;
    this.fetchImpl = fetchImpl;
    this.userToken = userToken;
  }

  private async api(method: string, body: Record<string, unknown>, token = this.token): Promise<any> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!json.ok) throw new SlackApiError(method, json.error);
    return json;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<SendResult> {
    const ut = msg.agent ? this.userToken(msg.agent.id) : undefined;
    if (ut) {
      try {
        return { echoes: await this.deliver(ut, replyRef, msg) };
      } catch (e) {
        if (!(e instanceof SlackApiError && NOT_MEMBER_ERRORS.has(e.code))) throw e;
        log.warn('slack_agent_cannot_post', { agent: msg.agent!.id, error: e.code });
      }
    }
    const identity = msg.agent ? { name: msg.agent.name, iconUrl: msg.agent.avatarUrl ?? this.who.iconUrl } : this.who;
    const echoes = await this.deliver(this.token, replyRef, msg, identity);
    return msg.agent ? { echoes, fallback: ut ? 'not_member' : 'not_connected' } : { echoes };
  }

  /** identity undefined = user token (posts natively as that person, no customisation). */
  private async deliver(token: string, replyRef: Record<string, unknown>, msg: OutboundMessage, identity?: SlackIdentity): Promise<string[]> {
    const echoes: string[] = [];
    if (msg.text.trim()) {
      const post = buildSlackPost(replyRef, msg, identity);
      const r = await this.api('chat.postMessage', post, token);
      echoes.push(`${replyRef.channel}:${r.ts}`);
    }
    for (const a of msg.attachments) echoes.push(...(await this.upload(replyRef, a, token)));
    return echoes;
  }

  /** Native Slack file in the thread (files:write): getUploadURLExternal -> POST bytes -> completeUploadExternal. */
  private async upload(replyRef: Record<string, unknown>, a: OutboundMessage['attachments'][number], token = this.token): Promise<string[]> {
    const src = await this.fetchImpl(a.sourceUrl, { redirect: 'follow' });
    if (!src.ok) throw new Error(`attachment fetch ${src.status}`);
    const bytes = new Uint8Array(await src.arrayBuffer());
    const q = new URLSearchParams({ filename: a.name, length: String(bytes.byteLength) });
    const res = await this.fetchImpl(`https://slack.com/api/files.getUploadURLExternal?${q}`, { headers: { authorization: `Bearer ${token}` } });
    const up: any = await res.json();
    if (!up.ok) throw new SlackApiError('files.getUploadURLExternal', up.error);
    const put = await this.fetchImpl(up.upload_url, { method: 'POST', body: bytes });
    if (!put.ok) throw new Error(`slack upload ${put.status}`);
    await this.api('files.completeUploadExternal', { files: [{ id: up.file_id, title: a.name }], channel_id: replyRef.channel, thread_ts: replyRef.threadTs }, token);
    return [`file:${up.file_id}`];
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

  private channels = new Map<string, string>();
  /** Best-effort "#channel-name" (channels:read / groups:read); undefined when unknown. */
  async channelName(channelId: string): Promise<string | undefined> {
    if (this.channels.has(channelId)) return this.channels.get(channelId);
    try {
      const res = await this.fetchImpl(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      const j: any = await res.json();
      const name = j.channel?.name ? `#${j.channel.name}` : undefined;
      if (name) this.channels.set(channelId, name);
      return name;
    } catch {
      return undefined;
    }
  }
}

/** Scopes an agent grants so replies post as them (user token). */
export const SLACK_USER_SCOPES = ['chat:write', 'files:write'];

/**
 * Per-agent Slack user OAuth. The Slack account must be the one whose email matches the agent's
 * Chatwoot email (checked with the bot's users:read.email). Tokens are stored encrypted.
 */
export class SlackUserOAuth {
  private cfg: { clientId: string; clientSecret: string; redirectUri: string; botToken: string; encryptionKey: string };
  private store: Store;
  private fetchImpl: typeof fetch;

  constructor(cfg: { clientId: string; clientSecret: string; redirectUri: string; botToken: string; encryptionKey: string }, store: Store, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, user_scope: SLACK_USER_SCOPES.join(','), redirect_uri: this.cfg.redirectUri, state });
    return `https://slack.com/oauth/v2/authorize?${q}`;
  }

  async complete(code: string, agentId: number, email: string): Promise<string> {
    const res = await this.fetchImpl('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, redirect_uri: this.cfg.redirectUri }),
    });
    const j: any = await res.json();
    const user = j.authed_user;
    if (!j.ok || !user?.access_token) throw new Error(`slack oauth: ${j.error ?? 'no user token'}`);
    const info: any = await (await this.fetchImpl(`https://slack.com/api/users.info?user=${encodeURIComponent(user.id)}`, { headers: { authorization: `Bearer ${this.cfg.botToken}` } })).json();
    const slackEmail = String(info.user?.profile?.email ?? '').toLowerCase();
    if (slackEmail !== email.toLowerCase()) throw new Error(`signed in to Slack as ${slackEmail || 'unknown'}, expected ${email}`);
    this.store.putKv(`slack.agent.${agentId}.token`, seal(this.cfg.encryptionKey, user.access_token));
    this.store.putKv(`slack.agent.${agentId}.user_id`, user.id);
    return slackEmail;
  }

  userToken(agentId: number): string | undefined {
    const sealed = this.store.getKv(`slack.agent.${agentId}.token`);
    return sealed ? unseal(this.cfg.encryptionKey, sealed) : undefined;
  }
}
