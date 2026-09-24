import { readFileSync } from 'node:fs';
import { ChatwootApi } from '../src/chatwoot.ts';
import { ClaudeClassifier, type Classification } from '../src/claude.ts';
import { GripClient } from '../src/grip.ts';
import { Store } from '../src/store.ts';
import { Sync } from '../src/sync.ts';

export const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string) => JSON.parse(raw(name));

export interface Call { host: string; method: string; path: string; headers: Record<string, string>; body: any }

/**
 * One injected fetch that stubs all three upstreams by host:
 *  - grip.test       Grip support API (tickets upserted by conversation id, like the real contract)
 *  - rails.test      Chatwoot application API (notes, labels)
 *  - anthropic.test  Claude Messages API (answers from a queue of classifications)
 */
export function world(opts: { debounceMs?: number; debounceMaxMs?: number } = {}) {
  const calls: Call[] = [];
  const classifications: Classification[] = [];
  const fail: Record<string, number[]> = { grip: [], rails: [], anthropic: [] }; // queued HTTP statuses to fail with
  const tickets = new Map<number, any>();
  const labels = new Map<number, string[]>();
  let clock = Date.parse('2026-09-24T02:00:00Z');
  let noteId = 9000;
  const grip: { inScope?: boolean; envelope?: boolean } = {}; // what POST /support/conversations answers for in_scope (unset = older Grip)
  const statuses = new Map<number, string>();

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const host = url.hostname.split('.')[0];
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ host, method: init.method ?? 'GET', path: url.pathname, headers: init.headers ?? {}, body });
    const f = fail[host]?.shift();
    if (f === -1) throw new TypeError('fetch failed');
    if (f) return new Response('{"error":"x"}', { status: f });
    const p = url.pathname;
    if (host === 'grip') {
      if (p === '/api/v1/support/conversations') {
        const r = { account_id: 'acc-1', support_status: 'waiting_on_kita', ...(grip.inScope === undefined ? {} : { in_scope: grip.inScope }) };
        return Response.json(grip.envelope ? { success: true, data: r } : r);
      }
      if (p === '/api/v1/support/tickets') {
        const t = tickets.get(body.chatwoot_conversation_id) ?? { id: `t-${tickets.size + 1}`, status: 'todo' };
        tickets.set(body.chatwoot_conversation_id, { ...t, ...body });
        return Response.json({ ticket_id: t.id, ticket_url: `https://internal.kita.ai/tasks/${t.id}` });
      }
      const m = p.match(/^\/api\/v1\/support\/tickets\/(\d+)$/);
      if (m && init.method === 'PATCH') {
        tickets.get(Number(m[1])).status = body.status;
        return Response.json({ ok: true });
      }
    }
    if (host === 'rails') {
      const ts = p.match(/^\/api\/v1\/accounts\/1\/conversations\/(\d+)\/toggle_status$/);
      if (ts) {
        statuses.set(Number(ts[1]), body.status);
        return Response.json({ payload: { success: true, current_status: body.status, conversation_id: Number(ts[1]) } });
      }
      const m = p.match(/^\/api\/v1\/accounts\/1\/conversations\/(\d+)\/(messages|labels)$/);
      if (m?.[2] === 'messages') return Response.json({ id: ++noteId, private: body.private });
      if (m?.[2] === 'labels' && (init.method ?? 'GET') === 'GET') return Response.json({ payload: labels.get(Number(m[1])) ?? [] });
      if (m?.[2] === 'labels') {
        labels.set(Number(m[1]), body.labels);
        return Response.json({ payload: body.labels });
      }
    }
    if (host === 'anthropic' && p === '/v1/messages') {
      const c = classifications.shift();
      if (!c) throw new Error('unexpected Claude call');
      return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(c) }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const store = new Store(':memory:');
  const sync = new Sync({
    store,
    grip: new GripClient('https://grip.test', 'grip_testkey', fetchImpl),
    chatwoot: new ChatwootApi('http://rails.test', 'cw-bot-token', fetchImpl),
    claude: new ClaudeClassifier({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', baseUrl: 'https://anthropic.test' }, fetchImpl),
    publicUrl: 'https://support.internal.kita.ai',
    debounceMs: opts.debounceMs ?? 60_000,
    debounceMaxMs: opts.debounceMaxMs ?? 300_000,
    now: () => clock,
  });
  return {
    sync, store, calls, classifications, fail, tickets, labels, statuses, grip, fetchImpl,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    of: (host: string, method?: string, path?: string | RegExp) =>
      calls.filter((c) => c.host === host && (!method || c.method === method) && (!path || (typeof path === 'string' ? c.path === path : path.test(c.path)))),
    /** Runs jobs until nothing is due at the current clock. */
    drain: async () => { while ((await sync.runDue()) > 0); },
  };
}

/** A copy of a fixture message with a new id / content / timestamp. */
export function msg(name: string, patch: Record<string, unknown>) {
  return { ...fixture(name), ...patch };
}

export const ISSUE: Classification = { is_issue: true, title: 'Risk score API returning 500s', priority: 'high', summary: 'All risk score calls fail with 500 since this morning; loan officers are blocked.' };
export const NOT_ISSUE: Classification = { is_issue: false, title: '', priority: 'low', summary: '' };
