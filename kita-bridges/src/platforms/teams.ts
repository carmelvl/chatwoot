import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { InboundMessage, OutboundMessage, Sender } from '../types.ts';

const OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const CLOCK_SKEW_S = 300;

export type JwksProvider = (kid: string) => Promise<JsonWebKey | undefined>;

/** Fetches and caches the Bot Framework signing keys (refreshed every 12h or on unknown kid). */
export function botFrameworkJwks(fetchImpl: typeof fetch = fetch): JwksProvider {
  let keys: any[] = [];
  let fetchedAt = 0;
  const refresh = async () => {
    const oid: any = await (await fetchImpl(OPENID_URL)).json();
    const jwks: any = await (await fetchImpl(oid.jwks_uri)).json();
    keys = jwks.keys ?? [];
    fetchedAt = Date.now();
  };
  return async (kid) => {
    if (!keys.length || Date.now() - fetchedAt > 12 * 3600 * 1000) await refresh();
    let k = keys.find((x) => x.kid === kid);
    if (!k && Date.now() - fetchedAt > 60_000) {
      await refresh();
      k = keys.find((x) => x.kid === kid);
    }
    return k;
  };
}

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * Validates the Bot Framework -> bot JWT (Authorization: Bearer ...):
 * RS256 signature against Bot Framework JWKS, issuer, audience == our app id, exp/nbf,
 * and the serviceUrl claim matching the activity (prevents replay to another serviceUrl).
 */
export async function verifyTeamsJwt(
  authHeader: string | undefined,
  opts: { appId: string; serviceUrl?: string; jwks: JwksProvider; nowS?: number },
): Promise<{ ok: true; claims: any } | { ok: false; reason: string }> {
  if (!authHeader?.startsWith('Bearer ')) return { ok: false, reason: 'missing_bearer' };
  const parts = authHeader.slice(7).trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let header: any, claims: any;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'alg' };
  const jwk = await opts.jwks(header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };
  const valid = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!valid) return { ok: false, reason: 'signature' };
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: 'issuer' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.appId)) return { ok: false, reason: 'audience' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) return { ok: false, reason: 'not_yet_valid' };
  if (opts.serviceUrl && claims.serviceurl && normUrl(claims.serviceurl) !== normUrl(opts.serviceUrl))
    return { ok: false, reason: 'service_url' };
  return { ok: true, claims };
}

const normUrl = (u: string) => u.replace(/\/+$/, '').toLowerCase();

export type TeamsParsed = { kind: 'ignore'; reason: string } | { kind: 'message'; message: InboundMessage };

/** Strips Teams HTML and <at>bot</at> mentions to plain text. */
export function teamsText(text: string): string {
  return text
    .replace(/<at>[^<]*<\/at>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Teams activity -> normalised message. conversation.id already encodes the thread for channel
 * posts (";messageid=<root>") and the chat for 1:1 / group chats, so it is the thread key.
 */
export function parseTeamsActivity(a: any): TeamsParsed {
  if (a?.type !== 'message') return { kind: 'ignore', reason: `type:${a?.type}` };
  if (a.channelId !== 'msteams') return { kind: 'ignore', reason: `channel:${a.channelId}` };
  if (!a.from?.id || a.from.id === a.recipient?.id || a.from.role === 'bot') return { kind: 'ignore', reason: 'bot' };
  const conversationId: string | undefined = a.conversation?.id;
  if (!conversationId || !a.serviceUrl) return { kind: 'ignore', reason: 'no_conversation' };
  const attachments = (a.attachments ?? []).flatMap((att: any) => {
    if (att.contentType === 'application/vnd.microsoft.teams.file.download.info' && att.content?.downloadUrl)
      return [{ url: att.content.downloadUrl, name: att.name ?? 'file' }];
    if (typeof att.contentType === 'string' && att.contentType.startsWith('image/') && att.contentUrl)
      return [{ url: att.contentUrl, name: att.name ?? `image-${a.id}.${att.contentType.split('/')[1] ?? 'png'}`, contentType: att.contentType }];
    return [];
  });
  const tenantId = a.channelData?.tenant?.id ?? a.conversation?.tenantId;
  return {
    kind: 'message',
    message: {
      platform: 'teams',
      eventId: String(a.id ?? `${conversationId}:${a.timestamp}`),
      userKey: a.from.aadObjectId ?? a.from.id,
      userName: a.from.name,
      threadKey: conversationId,
      replyRef: {
        serviceUrl: a.serviceUrl,
        conversationId,
        botId: a.recipient?.id,
        tenantId,
        conversationType: a.conversation?.conversationType,
      },
      text: teamsText(a.text ?? ''),
      attachments,
      conversationAttributes: { teams_tenant: String(tenantId ?? ''), teams_conversation_type: String(a.conversation?.conversationType ?? 'personal') },
    },
  };
}

/** Inline images in Teams are served from the connector and need the bot token. */
export function authorizeTeamsAttachments(msg: InboundMessage, token: string): InboundMessage {
  const host = new URL(String(msg.replyRef.serviceUrl)).host;
  return {
    ...msg,
    attachments: msg.attachments.map((att) => {
      try {
        return new URL(att.url).host === host ? { ...att, headers: { authorization: `Bearer ${token}` } } : att;
      } catch {
        return att;
      }
    }),
  };
}

const IMAGE_RE = /\.(jpe?g|png|gif)(\?|$)/i;

export function buildTeamsActivity(replyRef: Record<string, unknown>, msg: OutboundMessage) {
  const images = msg.attachments.filter((x) => x.fileType === 'image' || IMAGE_RE.test(x.name));
  const others = msg.attachments.filter((x) => !images.includes(x));
  const text = [msg.text, ...others.map((x) => `[${x.name}](${x.url})`)].filter((s) => s && s.trim()).join('\n\n');
  return {
    type: 'message',
    from: { id: replyRef.botId },
    textFormat: 'markdown',
    text,
    ...(images.length ? { attachments: images.map((x) => ({ contentType: 'image/*', contentUrl: x.url, name: x.name })) } : {}),
  };
}

/** Proactive send using the stored conversation reference (Bot Connector REST API). */
export class TeamsSender implements Sender {
  private cfg: { appId: string; appPassword: string; tenantId: string };
  private fetchImpl: typeof fetch;
  private token?: { value: string; exp: number };
  constructor(cfg: { appId: string; appPassword: string; tenantId: string }, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const tenant = this.cfg.tenantId || 'botframework.com';
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.cfg.appId,
        client_secret: this.cfg.appPassword,
        scope: 'https://api.botframework.com/.default',
      }),
    });
    const j: any = await res.json();
    if (!res.ok || !j.access_token) throw new Error(`teams token: ${res.status} ${j.error ?? ''}`);
    this.token = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(replyRef: Record<string, unknown>, msg: OutboundMessage): Promise<void> {
    const base = String(replyRef.serviceUrl).replace(/\/+$/, '');
    const res = await this.fetchImpl(`${base}/v3/conversations/${encodeURIComponent(String(replyRef.conversationId))}/activities`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildTeamsActivity(replyRef, msg)),
    });
    if (!res.ok) throw new Error(`teams send: ${res.status}`);
  }
}
