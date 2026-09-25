import { readFileSync } from 'node:fs';
import { Bridge } from '../src/bridge.ts';
import { ChatwootAppClient, ChatwootClient, KitaDeskClient } from '../src/chatwoot.ts';
import type { ScopeChannel, ScopeCheck } from '../src/scope.ts';
import { Store } from '../src/store.ts';
import type { OutboundMessage, Sender } from '../src/types.ts';

export const PUBLIC_URL = 'https://support.internal.kita.ai/bridges';
export const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string) => JSON.parse(raw(name));

/** In-memory fake of Chatwoot's public inbox API (contacts matched by identifier, like ContactInboxWithContactBuilder). */
export function fakeChatwoot() {
  const calls: { method: string; path: string; body: any }[] = [];
  let nextConv = 100;
  let nextMessage = 1;
  const contacts = new Map<string, string>();
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    let body: any = init.body;
    if (body instanceof FormData) {
      const form = body;
      body = { files: form.getAll('attachments[]').map((f: any) => f.name) };
      for (const [k, v] of form.entries()) if (k !== 'attachments[]') body[k] = v;
    }
    else if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body });
    const p = url.pathname;
    if (/\/contacts$/.test(p)) {
      if (!contacts.has(body.identifier)) contacts.set(body.identifier, `src-${contacts.size + 1}`);
      return Response.json({ source_id: contacts.get(body.identifier) });
    }
    if (/\/conversations$/.test(p)) return Response.json({ id: nextConv++ });
    if (/\/messages$/.test(p)) return Response.json({ id: nextMessage++ });
    // attachment downloads
    if (url.host.includes('fail')) return new Response('nope', { status: 403 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  return { calls, fetchImpl, client: new ChatwootClient('http://rails:3000', fetchImpl) };
}

export class RecordingSender implements Sender {
  sent: { ref: Record<string, unknown>; msg: OutboundMessage }[] = [];
  fail = false;
  async send(ref: Record<string, unknown>, msg: OutboundMessage) {
    if (this.fail) throw new Error('boom');
    this.sent.push({ ref, msg });
  }
}

/** Grip scope stub: every channel allowed; `links` maps channel_key -> account row. Mutable. */
export function staticScope(links: Record<string, Partial<ScopeChannel>> = {}) {
  const map = new Map<string, ScopeChannel>(Object.entries(links).map(([k, v]) => [k, { channel_key: k, ...v }]));
  return { map, allows: () => true, channel: (k?: string) => (k ? map.get(k) : undefined), link: (k: string, v: Partial<ScopeChannel>) => map.set(k, { channel_key: k, ...v }) };
}

export function makeBridge(o: { scope?: ScopeCheck } = {}) {
  const cw = fakeChatwoot();
  const store = new Store(':memory:');
  const senders = { slack: new RecordingSender(), teams: new RecordingSender(), viber: new RecordingSender() };
  let next = 5000;
  const appCalls: { path: string; body: any }[] = [];
  const app = new ChatwootAppClient('http://rails:3000', 'BRIDGE_TOKEN', '1', (async (u: any, init: any) => {
    appCalls.push({ path: new URL(String(u)).pathname, body: JSON.parse(init.body) });
    return Response.json({ id: next++ });
  }) as typeof fetch);
  const deskCalls: { path: string; body: any }[] = [];
  const desk = new KitaDeskClient('http://rails:3000', 'link-secret', (async (u: any, init: any) => {
    const path = new URL(String(u)).pathname;
    deskCalls.push({ path, body: JSON.parse(init.body) });
    return Response.json(path.endsWith('/conversation_merges') ? { moved: 2 } : { id: next++ });
  }) as typeof fetch);
  const bridge = new Bridge({ store, chatwoot: cw.client, inbox: 'IN_CUSTOMERS', senders, publicUrl: PUBLIC_URL, fetchImpl: cw.fetchImpl, app, desk, scope: o.scope });
  return { bridge, store, cw, senders, appCalls, deskCalls };
}
