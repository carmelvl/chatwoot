import { hmacHex, safeEqual } from './crypto.ts';

/**
 * Per-agent signed connect links: <public>/connect?a=<chatwoot user id>&e=<email>&x=<expiry>&s=<hmac>.
 * The bridge puts one in a private note when an agent's account isn't connected; an admin can also
 * mint one with `node src/connect-link.ts <agentId> <email>`.
 */
const payload = (agentId: number, email: string, exp: number) => `${agentId}|${email.toLowerCase()}|${exp}`;

export function signConnectLink(secret: string, publicUrl: string, agent: { id: number; email: string }, ttlDays = 7, nowS = Math.floor(Date.now() / 1000)): string {
  const exp = nowS + ttlDays * 86400;
  const q = new URLSearchParams({ a: String(agent.id), e: agent.email.toLowerCase(), x: String(exp), s: hmacHex(secret, payload(agent.id, agent.email, exp)) });
  return `${publicUrl}/connect?${q}`;
}

export function verifyConnectParams(secret: string, p: URLSearchParams, nowS = Math.floor(Date.now() / 1000)): { agentId: number; email: string } | undefined {
  const agentId = Number(p.get('a'));
  const email = (p.get('e') ?? '').toLowerCase();
  const exp = Number(p.get('x'));
  const sig = p.get('s') ?? '';
  if (!secret || !agentId || !email || !exp || exp < nowS) return undefined;
  return safeEqual(sig, hmacHex(secret, payload(agentId, email, exp))) ? { agentId, email } : undefined;
}

/** Query string carrying the same signed params to the start endpoints. */
export const signedQuery = (p: URLSearchParams) => new URLSearchParams({ a: p.get('a') ?? '', e: p.get('e') ?? '', x: p.get('x') ?? '', s: p.get('s') ?? '' }).toString();
