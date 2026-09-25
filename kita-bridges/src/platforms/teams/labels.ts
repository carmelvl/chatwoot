import type { Graph } from './graph.ts';

/** "Jun", "Jun & Maria", "Jun, Maria & Ana", "Jun, Maria & 2 others". */
export function namesLabel(names: string[]): string {
  const first = names.map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
  if (first.length <= 1) return first[0] ?? '';
  if (first.length <= 3) return `${first.slice(0, -1).join(', ')} & ${first[first.length - 1]}`;
  return `${first.slice(0, 2).join(', ')} & ${first.length - 2} others`;
}

/**
 * Human label of a Teams channel or chat, read with the service account's delegated token:
 * a channel is "‹Team› › ‹Channel›"; a group chat is its topic, else its members' first names
 * (the Kita service account left out). Undefined when Graph can't say.
 */
export async function teamsLabel(graph: Graph, ref: Record<string, unknown>, serviceUpn: string): Promise<string | undefined> {
  if (ref.kind === 'channel' && ref.teamId && ref.channelId) {
    const [team, channel] = await Promise.all([
      graph.request('GET', `/teams/${ref.teamId}?$select=displayName`),
      graph.request('GET', `/teams/${ref.teamId}/channels/${encodeURIComponent(String(ref.channelId))}?$select=displayName`),
    ]);
    const parts = [team?.displayName, channel?.displayName].filter(Boolean);
    return parts.length ? parts.join(' › ') : undefined;
  }
  if (ref.kind === 'chat' && ref.chatId) {
    const chat = await graph.request('GET', `/chats/${encodeURIComponent(String(ref.chatId))}?$expand=members`);
    if (chat?.topic) return String(chat.topic);
    const me = serviceUpn.toLowerCase();
    const names = (chat?.members ?? [])
      .filter((m: any) => String(m.email ?? '').toLowerCase() !== me)
      .map((m: any) => String(m.displayName ?? ''))
      .filter(Boolean);
    return namesLabel(names) || undefined;
  }
  return undefined;
}
