import type { ChatwootApi } from './chatwoot.ts';
import { HttpError } from './http.ts';
import { log } from './log.ts';
import type { OwnerRow, Store } from './store.ts';

/**
 * Conversation custom attributes this service writes. Definitions (attribute_model conversation_attribute,
 * display type text) make them show in the conversation sidebar; the values are written either way.
 */
export const OWNER_ATTRIBUTES = [
  { attribute_key: 'account_owner', attribute_display_name: 'Account owner', attribute_description: 'Grip DRI for this account (set by kita-grip-sync)' },
  { attribute_key: 'account_owner_email', attribute_display_name: 'Account owner email', attribute_description: 'Grip DRI email (set by kita-grip-sync)' },
  { attribute_key: 'sales_owner', attribute_display_name: 'Sales owner', attribute_description: 'Grip sales owner email (set by kita-grip-sync)' },
  { attribute_key: 'grip_account', attribute_display_name: 'Grip account', attribute_description: 'Grip account name (set by kita-grip-sync)' },
].map((d) => ({ ...d, attribute_display_type: 'text', attribute_model: 'conversation_attribute' }));

export type GripOwner = OwnerRow['grip'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Grip's POST /support/conversations answer -> owner fields, or undefined when Grip doesn't send any yet. */
export function gripOwner(r: any): GripOwner | undefined {
  if (!r || !['dri_email', 'dri_name', 'sales_owner_email', 'account_name'].some((k) => k in r)) return undefined;
  return {
    dri_email: str(r.dri_email)?.toLowerCase() ?? null,
    dri_name: str(r.dri_name),
    sales_owner_email: str(r.sales_owner_email)?.toLowerCase() ?? null,
    account_name: str(r.account_name),
    in_scope: typeof r.in_scope === 'boolean' ? r.in_scope : null,
  };
}

/** Attribute values wanted for these owner fields. Empty values are left out (never cleared). */
export function wantedAttributes(g: GripOwner): Record<string, string> {
  const out: Record<string, string> = {};
  const owner = g.dri_name ?? g.dri_email;
  if (owner) out.account_owner = owner;
  if (g.dri_email) out.account_owner_email = g.dri_email;
  if (g.sales_owner_email) out.sales_owner = g.sales_owner_email;
  if (g.account_name) out.grip_account = g.account_name;
  return out;
}

const isAuthError = (e: unknown) => e instanceof HttpError && (e.status === 401 || e.status === 403);

export interface OwnersDeps {
  store: Store;
  /** Bot (or admin) token: conversations#show, custom_attributes, assignments. */
  chatwoot: ChatwootApi;
  /** User token that may call agents#index and custom_attribute_definitions (an administrator's). Defaults to `chatwoot`. */
  directory?: ChatwootApi;
  /** SCOPE_FILTER=on: never assign conversations Grip calls out of scope. Off (default): assign like any other. */
  scopeFilter?: boolean;
  /** Agent list cache lifetime. */
  agentsRefreshMs?: number;
  now?: () => number;
}

/**
 * "Owner in the desk": puts Grip's DRI on each conversation.
 *  - custom attributes account_owner / account_owner_email / sales_owner / grip_account, written only when a value changed;
 *  - assigns the conversation to the DRI's Chatwoot agent (matched by email, case-insensitive) when it is unassigned or
 *    still assigned to the agent this service put there. A human's reassignment is never overridden.
 *  - out-of-scope conversations get the attributes but no assignment.
 */
export class Owners {
  private d: OwnersDeps;
  private now: () => number;
  private agentsCache = new Map<number, { at: number; byEmail: Map<string, number> }>();
  private agentsUnavailable = false;
  private definitionsChecked = new Set<number>();

  constructor(d: OwnersDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  private get directory() {
    return this.d.directory ?? this.d.chatwoot;
  }

  /** Email -> agent id, cached; a miss refreshes at most once a minute so a newly invited agent is found quickly. */
  async agentId(accountId: number, email: string): Promise<number | undefined> {
    const refreshMs = this.d.agentsRefreshMs ?? 600_000;
    let c = this.agentsCache.get(accountId);
    const age = c ? this.now() - c.at : Infinity;
    if (!c || age > refreshMs || (!c.byEmail.has(email) && age > 60_000)) {
      try {
        const list = await this.directory.agents(accountId);
        c = { at: this.now(), byEmail: new Map(list.filter((a) => a?.email).map((a) => [String(a.email).toLowerCase(), Number(a.id)])) };
        this.agentsCache.set(accountId, c);
        this.agentsUnavailable = false;
      } catch (e) {
        if (!isAuthError(e)) throw e;
        if (!this.agentsUnavailable) log.warn('agents_unavailable', { reason: 'token cannot call agents#index; set CHATWOOT_ADMIN_TOKEN', error: String((e as Error).message) });
        this.agentsUnavailable = true;
        return undefined;
      }
    }
    return c.byEmail.get(email);
  }

  /** Creates missing attribute definitions once per account. Needs an administrator token; logs the manual step otherwise. */
  async ensureDefinitions(accountId: number): Promise<void> {
    if (this.definitionsChecked.has(accountId)) return;
    this.definitionsChecked.add(accountId);
    try {
      const have = new Set((await this.directory.attributeDefinitions(accountId)).map((d) => d.attribute_key));
      for (const def of OWNER_ATTRIBUTES) {
        if (have.has(def.attribute_key)) continue;
        await this.directory.createAttributeDefinition(accountId, def);
        log.info('attribute_definition_created', { account: accountId, key: def.attribute_key });
      }
    } catch (e) {
      log.warn('attribute_definitions_missing', {
        account: accountId,
        error: String((e as Error).message),
        fix: 'create them once with rails runner (kita-grip-sync README, "Owner in the desk"); values are still written',
      });
    }
  }

  /** Runs for one conversation (the `owner:<id>` job). Throws only on retryable Chatwoot errors. */
  async apply(conversationId: number, accountId: number): Promise<void> {
    const { store, chatwoot } = this.d;
    const row = store.getOwner(conversationId);
    if (!row) return;
    await this.ensureDefinitions(accountId);

    // 1. Attributes: send only keys whose value differs from what we last wrote.
    const want = wantedAttributes(row.grip);
    const diff = Object.fromEntries(Object.entries(want).filter(([k, v]) => row.attrs[k] !== v));
    if (Object.keys(diff).length) {
      await chatwoot.setCustomAttributes(accountId, conversationId, diff);
      row.attrs = { ...row.attrs, ...diff };
      store.putOwner(row);
      log.info('owner_attributes_set', { conversation: conversationId, keys: Object.keys(diff) });
    }

    // 2. Assignment.
    if ((this.d.scopeFilter && row.grip.in_scope === false) || !row.grip.dri_email) return;
    const target = await this.agentId(accountId, row.grip.dri_email);
    if (target === undefined) {
      if (!this.agentsUnavailable) log.info('dri_not_agent', { conversation: conversationId, dri_email: row.grip.dri_email });
      return;
    }
    if (row.assignedAgentId === target || row.keptManualFor === target) return; // done, or a human owns it
    const conv = await chatwoot.conversation(accountId, conversationId);
    const current = conv?.meta?.assignee?.id ?? conv?.assignee_id ?? null;
    const cur = current === null || current === undefined ? null : Number(current);
    if (cur === target) {
      store.putOwner({ ...row, assignedAgentId: target, keptManualFor: null });
      return;
    }
    if (cur !== null && cur !== row.assignedAgentId) {
      store.putOwner({ ...row, keptManualFor: target });
      log.info('owner_manual_kept', { conversation: conversationId, assignee: cur, dri_agent: target });
      return;
    }
    await chatwoot.assign(accountId, conversationId, target);
    store.putOwner({ ...row, assignedAgentId: target, keptManualFor: null });
    log.info('owner_assigned', { conversation: conversationId, agent: target, previous: cur });
  }
}
