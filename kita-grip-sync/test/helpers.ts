import { readFileSync } from 'node:fs';
import { ChatwootApi, KitaDesk } from '../src/chatwoot.ts';
import { ClaudeClassifier, type Classification } from '../src/claude.ts';
import { GripClient } from '../src/grip.ts';
import { Owners } from '../src/owner.ts';
import { Store } from '../src/store.ts';
import { Sync } from '../src/sync.ts';

export const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string) => JSON.parse(raw(name));

export interface Call { host: string; method: string; path: string; headers: Record<string, string>; body: any }

/**
 * One injected fetch that stubs all three upstreams by host:
 *  - grip.test       Grip support API (tickets upserted by (conversation id, issue_key), like the real contract)
 *  - rails.test      Chatwoot application API (notes, labels) + the desk's POST /api/v1/kita/threads
 *  - anthropic.test  Claude Messages API (answers from a queue of classifications)
 */
export function world(opts: { debounceMs?: number; debounceMaxMs?: number; owners?: boolean; scopeFilter?: boolean } = {}) {
  const calls: Call[] = [];
  const classifications: Classification[] = [];
  const fail: Record<string, number[]> = { grip: [], rails: [], anthropic: [] }; // queued HTTP statuses to fail with
  /** Grip tickets keyed `<conversation>:<issue_key>` ('' = no issue_key). */
  const tickets = new Map<string, any>();
  /** Desk kita_threads rows keyed `<conversation>:<root>` (latest POST body). */
  const threads = new Map<string, any>();
  const labels = new Map<number, string[]>();
  let clock = Date.parse('2026-09-24T02:00:00Z');
  let noteId = 9000;
  const grip: { inScope?: boolean; envelope?: boolean; ticketFields?: Record<string, unknown> } = {}; // what POST /support/conversations answers for in_scope (unset = older Grip)
  const statuses = new Map<number, string>();
  // Owner in the desk: Grip owner fields, Chatwoot agents/assignees/attributes/definitions.
  const owner: Record<string, unknown> = {};
  const cw = {
    agents: [{ id: 11, email: 'Rhea@Kita.ai', name: 'Rhea Malhotra' }, { id: 12, email: 'carmel@kita.ai', name: 'Carmel Limcaoco' }] as any[],
    agentsStatus: 200,
    definitionsStatus: 200,
    assignees: new Map<number, number | null>(),
    attrs: new Map<number, Record<string, string>>(),
    definitions: [] as any[],
  };

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
        const r = { account_id: 'acc-1', support_status: 'waiting_on_kita', ...(grip.inScope === undefined ? {} : { in_scope: grip.inScope }), ...owner };
        return Response.json(grip.envelope ? { success: true, data: r } : r);
      }
      if (p === '/api/v1/support/tickets') {
        const k = `${body.chatwoot_conversation_id}:${body.issue_key ?? ''}`;
        const t = tickets.get(k) ?? { id: `t-${tickets.size + 1}`, status: 'todo' };
        tickets.set(k, { ...t, ...body });
        return Response.json({ success: true, data: { ticket_id: t.id, ticket_url: `https://internal.kita.ai/tasks/${t.id}`, created: !tickets.has(k), dismissed: false, ...(body.issue_key ? { issue_key: body.issue_key } : {}), ...(grip.ticketFields ?? {}) } });
      }
      const m = p.match(/^\/api\/v1\/support\/tickets\/(\d+)$/);
      if (m && init.method === 'PATCH') {
        const hit = [...tickets.entries()].filter(([k]) => body.all ? k.startsWith(`${m[1]}:`) : k === `${m[1]}:${body.issue_key ?? ''}`);
        if (!hit.length) return new Response('{"success":false}', { status: 404 });
        for (const [, t] of hit) if (t.status !== 'dismissed') t.status = body.status;
        return Response.json({ success: true, data: { updated: hit.length, ...(body.all ? {} : grip.ticketFields ?? {}) } });
      }
    }
    if (host === 'rails') {
      if (p === '/api/v1/kita/threads') {
        if (init.headers?.['x-kita-bridge-secret'] !== 'bridge-secret') return new Response('{"error":"forbidden"}', { status: 401 });
        threads.set(`${body.conversation_id}:${body.root_message_id}`, body);
        return Response.json({ id: threads.size });
      }
      const ts = p.match(/^\/api\/v1\/accounts\/1\/conversations\/(\d+)\/toggle_status$/);
      if (ts) {
        statuses.set(Number(ts[1]), body.status);
        return Response.json({ payload: { success: true, current_status: body.status, conversation_id: Number(ts[1]) } });
      }
      if (p === '/api/v1/accounts/1/agents') return cw.agentsStatus === 200 ? Response.json(cw.agents) : new Response('{"error":"bots"}', { status: cw.agentsStatus });
      if (p === '/api/v1/accounts/1/custom_attribute_definitions') {
        if (cw.definitionsStatus !== 200) return new Response('{"error":"x"}', { status: cw.definitionsStatus });
        if ((init.method ?? 'GET') === 'GET') return Response.json(cw.definitions);
        cw.definitions.push(body.custom_attribute_definition);
        return Response.json(body.custom_attribute_definition);
      }
      const show = p.match(/^\/api\/v1\/accounts\/1\/conversations\/(\d+)$/);
      if (show) {
        const a = cw.assignees.get(Number(show[1])) ?? null;
        return Response.json({ id: Number(show[1]), meta: { assignee: a === null ? null : { id: a } }, custom_attributes: cw.attrs.get(Number(show[1])) ?? {} });
      }
      const ca = p.match(/^\/api\/v1\/accounts\/1\/conversations\/(\d+)\/(custom_attributes|assignments)$/);
      if (ca?.[2] === 'custom_attributes') {
        cw.attrs.set(Number(ca[1]), { ...(body.merge ? cw.attrs.get(Number(ca[1])) : {}), ...body.custom_attributes });
        return Response.json({});
      }
      if (ca?.[2] === 'assignments') {
        cw.assignees.set(Number(ca[1]), body.assignee_id);
        return Response.json({ id: body.assignee_id });
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
  const chatwoot = new ChatwootApi('http://rails.test', 'cw-bot-token', fetchImpl);
  const sync = new Sync({
    store,
    owners: opts.owners ? new Owners({ store, chatwoot, directory: new ChatwootApi('http://rails.test', 'cw-admin-token', fetchImpl), now: () => clock, scopeFilter: opts.scopeFilter }) : undefined,
    grip: new GripClient('https://grip.test', 'grip_testkey', fetchImpl),
    chatwoot,
    desk: new KitaDesk('http://rails.test', 'bridge-secret', fetchImpl),
    claude: new ClaudeClassifier({ apiKey: 'sk-ant-test', model: 'claude-sonnet-5', baseUrl: 'https://anthropic.test' }, fetchImpl),
    publicUrl: 'https://support.internal.kita.ai',
    debounceMs: opts.debounceMs ?? 60_000,
    debounceMaxMs: opts.debounceMaxMs ?? 300_000,
    scopeFilter: opts.scopeFilter,
    now: () => clock,
  });
  return {
    sync, store, calls, classifications, fail, tickets, threads, labels, statuses, grip, owner, cw, fetchImpl,
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

export const ISSUE: Classification = { is_issue: true, is_new_issue: false, title: 'Risk score API returning 500s', priority: 'high', summary: 'All risk score calls fail with 500 since this morning; loan officers are blocked.', thread_title: 'Risk score API down' };
export const NOT_ISSUE: Classification = { is_issue: false, is_new_issue: false, title: '', priority: 'low', summary: '', thread_title: '' };
