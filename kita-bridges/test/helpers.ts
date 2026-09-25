import { readFileSync } from 'node:fs';
import { Bridge } from '../src/bridge.ts';
import { ChatwootClient } from '../src/chatwoot.ts';
import { Store } from '../src/store.ts';
import type { OutboundMessage, Platform, Sender } from '../src/types.ts';

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

export function makeBridge() {
  const cw = fakeChatwoot();
  const store = new Store(':memory:');
  const senders = { slack: new RecordingSender(), teams: new RecordingSender(), viber: new RecordingSender() };
  const inboxes = { slack: { inboxIdentifier: 'IN_SLACK' }, teams: { inboxIdentifier: 'IN_TEAMS' }, viber: { inboxIdentifier: 'IN_VIBER' } } as Record<Platform, { inboxIdentifier: string }>;
  const bridge = new Bridge({ store, chatwoot: cw.client, inboxes, senders, publicUrl: PUBLIC_URL, fetchImpl: cw.fetchImpl });
  return { bridge, store, cw, senders };
}
