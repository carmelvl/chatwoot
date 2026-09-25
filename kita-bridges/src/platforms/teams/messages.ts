import { log } from '../../log.ts';
import { type InboundAttachment, type InboundMessage, type OutboundMessage, type Sender, type SendResult } from '../../types.ts';
import { GraphError, type Graph } from './graph.ts';

// ---------- change notifications ----------

/** Graph endpoint validation: echo ?validationToken (URL-decoded) as text/plain within 10s. */
export function validationToken(url: URL): string | undefined {
  return url.searchParams.get('validationToken') ?? undefined;
}

export interface GraphNotification {
  subscriptionId: string;
  changeType?: string;
  resource?: string;
  clientState?: string;
  lifecycleEvent?: string;
}

/** Splits a notification batch into trusted and rejected items using the per-subscription clientState. */
export function filterNotifications(body: any, verify: (subId?: string, clientState?: string) => boolean) {
  const accepted: GraphNotification[] = [];
  let rejected = 0;
  for (const n of body?.value ?? []) {
    if (verify(n?.subscriptionId, n?.clientState)) accepted.push(n);
    else rejected++;
  }
  return { accepted, rejected };
}

export type MessageLocation =
  | { kind: 'channel'; teamId: string; channelId: string; messageId: string; replyToId?: string }
  | { kind: 'chat'; chatId: string; messageId: string };

/** Parses notification resources in either OData form: teams('T')/channels('C')/messages('M')[/replies('R')] or teams/T/... */
export function parseResource(resource: string): MessageLocation | undefined {
  const seg = [...resource.matchAll(/(teams|channels|chats|messages|replies)(?:\('([^']+)'\)|\/([^/]+))/g)].map((m) => [m[1], decodeURIComponent(m[2] ?? m[3])]);
  const get = (k: string) => seg.find(([n]) => n === k)?.[1];
  const messages = get('messages');
  const reply = get('replies');
  if (get('chats') && messages) return { kind: 'chat', chatId: get('chats')!, messageId: messages };
  if (get('teams') && get('channels') && messages)
    return reply
      ? { kind: 'channel', teamId: get('teams')!, channelId: get('channels')!, messageId: reply, replyToId: messages }
      : { kind: 'channel', teamId: get('teams')!, channelId: get('channels')!, messageId: messages };
  return undefined;
}

export const messagePath = (l: MessageLocation) =>
  l.kind === 'chat'
    ? `/chats/${encodeURIComponent(l.chatId)}/messages/${l.messageId}`
    : l.replyToId
      ? `/teams/${l.teamId}/channels/${encodeURIComponent(l.channelId)}/messages/${l.replyToId}/replies/${l.messageId}`
      : `/teams/${l.teamId}/channels/${encodeURIComponent(l.channelId)}/messages/${l.messageId}`;

/** Inbound dedupe id; Graph message ids are only unique within a chat/channel. */
export const teamsEventId = (container: string, messageId: string) => `${container}:${messageId}`;

// ---------- sender classification (loop prevention) ----------

export type SenderKind = 'self' | 'internal' | 'customer' | 'not_a_user';

/**
 * Kita user -> self (ignored); members of Kita's tenant -> internal (staff: synced as outgoing agent
 * messages, never as customer messages); guests in Kita's tenant and users of other tenants -> customer.
 */
export class SenderClassifier {
  private graph: Graph;
  private o: { kitaUserId: () => string | undefined; internalTenantIds: string[] };
  private cache = new Map<string, SenderKind>();
  private emails = new Map<string, string>();

  constructor(graph: Graph, o: { kitaUserId: () => string | undefined; internalTenantIds: string[] }) {
    this.graph = graph;
    this.o = o;
  }

  async classify(from: any): Promise<SenderKind> {
    const user = from?.user;
    if (!user?.id) return 'not_a_user'; // application / bot / system
    if (user.id === this.o.kitaUserId()) return 'self';
    if (user.tenantId && !this.o.internalTenantIds.includes(user.tenantId)) return 'customer';
    const hit = this.cache.get(user.id);
    if (hit) return hit;
    let kind: SenderKind;
    try {
      const u = await this.graph.request('GET', `/users/${user.id}?$select=id,userType,mail,userPrincipalName`);
      kind = u.userType === 'Guest' ? 'customer' : 'internal';
      const email = u.mail || u.userPrincipalName;
      if (kind === 'internal' && email) this.emails.set(user.id, String(email).toLowerCase());
    } catch (e) {
      // Not in Kita's directory at all -> external; anything else: fail safe (don't ingest staff by accident).
      kind = e instanceof GraphError && e.status === 404 ? 'customer' : 'internal';
      if (kind === 'internal') log.warn('teams_classify_failed', { user: user.id, error: String((e as Error).message) });
    }
    this.cache.set(user.id, kind);
    return kind;
  }

  /** Mail (or UPN) of a Kita staff member seen by classify(); matched to their desk agent. */
  email(userId: string): string | undefined {
    return this.emails.get(userId);
  }
}

// ---------- Graph chatMessage -> InboundMessage ----------

export function htmlToText(html: string): string {
  return html
    .replace(/<at[^>]*>[^<]*<\/at>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<attachment[^>]*><\/attachment>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type ParsedTeams = { kind: 'ignore'; reason: string } | { kind: 'message'; message: InboundMessage };

/**
 * Mapping: a channel thread (root message id) is one conversation; a chat is one conversation
 * that re-opens as a new one after the previous was resolved. Staff messages come back with
 * author 'staff' (messages the bridge posted itself are dropped earlier via their tracked ids).
 */
export function parseGraphMessage(m: any, loc: MessageLocation, sender: SenderKind): ParsedTeams {
  if (m?.messageType !== 'message') return { kind: 'ignore', reason: `type:${m?.messageType}` };
  if (m.deletedDateTime) return { kind: 'ignore', reason: 'deleted' };
  if (sender === 'self' || sender === 'not_a_user') return { kind: 'ignore', reason: sender };
  const author = sender === 'internal' ? 'staff' : 'customer';
  const user = m.from.user;
  const html = m.body?.contentType === 'html';
  const text = html ? htmlToText(m.body.content ?? '') : String(m.body?.content ?? '').trim();

  const attachments: InboundAttachment[] = [];
  if (html) {
    // Inline images are hostedContents, fetched with the Kita user's token (headers added by the caller).
    for (const [, src] of String(m.body.content).matchAll(/<img[^>]+src="(https:\/\/graph\.microsoft\.com\/[^"]+\/hostedContents\/[^"]+)"/gi))
      attachments.push({ url: src.replace(/&amp;/g, '&'), name: `image-${m.id}-${attachments.length + 1}.png`, contentType: 'image/png' });
  }
  for (const a of m.attachments ?? []) {
    // Files live in the sender's SharePoint/OneDrive; the bridge can't always read them (cross-tenant),
    // in which case the agent gets the link.
    if (a.contentType === 'reference' && a.contentUrl) attachments.push({ url: a.contentUrl, name: a.name ?? 'file' });
  }
  if (!text && attachments.length === 0) return { kind: 'ignore', reason: 'empty' };

  const base = { platform: 'teams' as const, userKey: user.id, userName: user.displayName, text, attachments, author } as const;
  if (loc.kind === 'chat') {
    return {
      kind: 'message',
      message: {
        ...base,
        eventId: teamsEventId(loc.chatId, m.id),
        threadKey: `chat:${loc.chatId}`,
        replyRef: { kind: 'chat', chatId: loc.chatId },
        conversationAttributes: { channel_key: `teams:${loc.chatId}`, teams_chat: loc.chatId },
        channelConversation: true,
      },
    };
  }
  const rootId = m.replyToId ?? loc.replyToId ?? m.id;
  return {
    kind: 'message',
    message: {
      ...base,
      eventId: teamsEventId(loc.channelId, m.id),
      // One conversation per channel; the Teams thread is surfaced per message (thread root + native reply).
      threadKey: `channel:${loc.teamId}:${loc.channelId}`,
      replyRef: { kind: 'channel', teamId: loc.teamId, channelId: loc.channelId },
      thread: { root: teamsEventId(loc.channelId, rootId), reply: rootId !== m.id },
      conversationAttributes: { channel_key: `teams:${loc.channelId}`, teams_team: loc.teamId, teams_channel: loc.channelId },
      channelConversation: true,
    },
  };
}

/** Notification -> fetch message by id -> classify -> normalised message (or why it was skipped). */
export async function resolveNotification(graph: Graph, classifier: SenderClassifier, n: GraphNotification): Promise<ParsedTeams> {
  if (n.changeType && n.changeType !== 'created') return { kind: 'ignore', reason: `change:${n.changeType}` };
  const loc = n.resource ? parseResource(n.resource) : undefined;
  if (!loc) return { kind: 'ignore', reason: 'unknown_resource' };
  const m = await graph.request('GET', messagePath(loc));
  const parsed = parseGraphMessage(m, loc, await classifier.classify(m?.from));
  if (parsed.kind === 'message' && parsed.message.author === 'staff') parsed.message.userEmail = classifier.email(parsed.message.userKey);
  if (parsed.kind === 'message' && parsed.message.attachments.some((a) => a.url.startsWith('https://graph.microsoft.com/'))) {
    const token = await graph.auth.accessToken();
    parsed.message.attachments = parsed.message.attachments.map((a) =>
      a.url.startsWith('https://graph.microsoft.com/') ? { ...a, headers: { authorization: `Bearer ${token}` } } : a,
    );
  }
  return parsed;
}

// ---------- outbound: agent reply -> Teams, as the Kita user ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Chatwoot markdown (bold, italics, links, line breaks) -> the HTML subset Teams renders. */
export function markdownToTeamsHtml(md: string): string {
  return esc(md)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
}

const IMAGE_RE = /\.(jpe?g|png|gif)(\?|$)/i;
const isImage = (a: OutboundMessage['attachments'][number]) => a.fileType === 'image' || IMAGE_RE.test(a.name);

export interface InlineImage {
  contentType: string;
  base64: string;
}

/** Plain HTML message; images are embedded as hostedContents, other files are links to the bridge media URL. */
export function buildHtmlMessage(msg: OutboundMessage, images: (InlineImage | undefined)[]) {
  const parts: string[] = [];
  if (msg.text.trim()) parts.push(markdownToTeamsHtml(msg.text));
  const hostedContents: any[] = [];
  msg.attachments.forEach((a, i) => {
    const img = images[i];
    if (img) {
      const id = String(hostedContents.length + 1);
      hostedContents.push({ '@microsoft.graph.temporaryId': id, contentBytes: img.base64, contentType: img.contentType });
      parts.push(`<img src="../hostedContents/${id}/$value" alt="${esc(a.name)}">`);
    } else parts.push(`<a href="${esc(a.url)}">${esc(a.name)}</a>`);
  });
  return { body: { contentType: 'html', content: parts.join('<br>') }, ...(hostedContents.length ? { hostedContents } : {}) };
}

/** Adaptive Card fallback (only used if Teams rejects the HTML post). No agent names, Kita user as sender. */
export function buildCardMessage(msg: OutboundMessage) {
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      ...(msg.text.trim() ? [{ type: 'TextBlock', text: msg.text, wrap: true }] : []),
      ...msg.attachments.filter(isImage).map((a) => ({ type: 'Image', url: a.url, altText: a.name })),
    ],
    actions: msg.attachments.filter((a) => !isImage(a)).map((a) => ({ type: 'Action.OpenUrl', title: a.name, url: a.url })),
  };
  return {
    body: { contentType: 'html', content: '<attachment id="kita-reply"></attachment>' },
    attachments: [{ id: 'kita-reply', contentType: 'application/vnd.microsoft.card.adaptive', content: JSON.stringify(card) }],
  };
}

export function sendPath(ref: Record<string, unknown>): string {
  if (ref.kind === 'chat') return `/chats/${encodeURIComponent(String(ref.chatId))}/messages`;
  const channel = `/teams/${ref.teamId}/channels/${encodeURIComponent(String(ref.channelId))}/messages`;
  return ref.rootId ? `${channel}/${ref.rootId}/replies` : channel;
}

export type TeamsMessageFormat = 'auto' | 'html' | 'card';
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * Sends as the agent (their own delegated token) when they've connected; otherwise, or if their
 * account can't post there (403/404: not a member), as the shared Kita user with "First: " prefix.
 */
export class TeamsSender implements Sender {
  private graph: Graph;
  private format: TeamsMessageFormat;
  private fetchImpl: typeof fetch;
  private agentGraph: (agentId: number) => Graph | undefined;

  constructor(graph: Graph, format: TeamsMessageFormat = 'auto', fetchImpl: typeof fetch = fetch, agentGraph: (agentId: number) => Graph | undefined = () => undefined) {
    this.graph = graph;
    this.format = format;
    this.fetchImpl = fetchImpl;
    this.agentGraph = agentGraph;
  }

  private async inlineImages(msg: OutboundMessage): Promise<(InlineImage | undefined)[]> {
    return Promise.all(
      msg.attachments.map(async (a) => {
        if (!isImage(a)) return undefined;
        try {
          const res = await this.fetchImpl(a.sourceUrl, { redirect: 'follow' });
          const buf = Buffer.from(await res.arrayBuffer());
          if (!res.ok || buf.byteLength > MAX_INLINE_IMAGE_BYTES) return undefined; // falls back to a link
          return { contentType: res.headers.get('content-type') ?? 'image/png', base64: buf.toString('base64') };
        } catch {
          return undefined;
        }
      }),
    );
  }

  /** Posts only as the agent (their delegated token). The shared Kita user never posts replies. */
  async send(ref: Record<string, unknown>, msg: OutboundMessage): Promise<SendResult> {
    const agentGraph = msg.agent ? this.agentGraph(msg.agent.id) : undefined;
    if (!agentGraph) return { refused: 'not_connected' };
    try {
      return { echoes: await this.post(agentGraph, ref, msg) };
    } catch (e) {
      if (!(e instanceof GraphError && (e.status === 403 || e.status === 404))) throw e;
      log.warn('teams_agent_cannot_post', { agent: msg.agent!.id, status: e.status });
      return { refused: 'not_member' };
    }
  }

  private async post(graph: Graph, ref: Record<string, unknown>, msg: OutboundMessage): Promise<string[]> {
    const path = sendPath(ref);
    const container = String(ref.kind === 'chat' ? ref.chatId : ref.channelId);
    let created: any;
    if (this.format === 'card' && ref.kind === 'channel') created = await graph.request('POST', path, buildCardMessage(msg));
    else {
      try {
        created = await graph.request('POST', path, buildHtmlMessage(msg, await this.inlineImages(msg)));
      } catch (e) {
        // Only a content rejection in a channel triggers the card fallback; auth/throttling/5xx surface as failures.
        const rejected = e instanceof GraphError && (e.status === 400 || e.status === 403);
        if (!(this.format === 'auto' && ref.kind === 'channel' && rejected)) throw e;
        log.warn('teams_card_fallback', { status: (e as GraphError).status, code: (e as GraphError).code });
        created = await graph.request('POST', path, buildCardMessage(msg));
      }
    }
    return created?.id ? [teamsEventId(container, created.id)] : [];
  }
}
