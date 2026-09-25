import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_ATTRIBUTES } from '../src/owner.ts';
import { fixture, msg, world } from './helpers.ts';

const RHEA = { dri_email: 'rhea@kita.ai', dri_name: 'Rhea Malhotra', sales_owner_email: 'carmel@kita.ai', account_name: 'Acme Lending' };
const customer = (id: number) => msg('message_incoming_slack.json', { id, content: `m${id}` });

function ownerWorld(owner: Record<string, unknown> = RHEA, scopeFilter = false) {
  const w = world({ owners: true, debounceMs: 10 ** 12, scopeFilter }); // keep the classifier out of these tests
  Object.assign(w.owner, owner);
  return w;
}
const assigns = (w: ReturnType<typeof world>) => w.of('rails', 'POST', /\/assignments$/);
const attrWrites = (w: ReturnType<typeof world>) => w.of('rails', 'POST', /\/custom_attributes$/);

test('owner: unassigned conversation is assigned to the DRI agent (email match is case-insensitive) and attributes are set', async () => {
  const w = ownerWorld();
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  await w.drain();
  const [a] = assigns(w);
  assert.equal(a.path, '/api/v1/accounts/1/conversations/42/assignments');
  assert.deepEqual(a.body, { assignee_id: 11 }, 'Rhea@Kita.ai in Chatwoot matches rhea@kita.ai from Grip');
  assert.equal(a.headers['api-access-token'], 'cw-bot-token');
  assert.equal(w.of('rails', 'GET', '/api/v1/accounts/1/agents')[0].headers['api-access-token'], 'cw-admin-token');
  const [attrs] = attrWrites(w);
  assert.deepEqual(attrs.body, {
    merge: true,
    custom_attributes: { account_owner: 'Rhea Malhotra', account_owner_email: 'rhea@kita.ai', sales_owner: 'carmel@kita.ai', grip_account: 'Acme Lending' },
  });
  assert.equal(w.store.getOwner(42)!.assignedAgentId, 11);
});

test('owner: still assigned to the previous DRI we set -> moves to the new DRI', async () => {
  const w = ownerWorld();
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  Object.assign(w.owner, { dri_email: 'carmel@kita.ai', dri_name: 'Carmel Limcaoco' });
  w.sync.ingest(customer(5002), 'd2');
  await w.drain();
  assert.deepEqual(assigns(w).map((c) => c.body.assignee_id), [11, 12]);
  assert.equal(w.cw.assignees.get(42), 12);
  assert.deepEqual(attrWrites(w).at(-1)!.body.custom_attributes, { account_owner: 'Carmel Limcaoco', account_owner_email: 'carmel@kita.ai' }, 'only the changed values');
});

test('owner: a manual reassignment by a human is never overridden', async () => {
  const w = ownerWorld();
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  w.cw.assignees.set(42, 99); // a human hands it to agent 99
  Object.assign(w.owner, { dri_email: 'carmel@kita.ai' });
  w.sync.ingest(customer(5002), 'd2');
  await w.drain();
  w.sync.ingest(customer(5003), 'd3');
  await w.drain();
  assert.equal(assigns(w).length, 1, 'only the first automatic assignment');
  assert.equal(w.cw.assignees.get(42), 99);
  assert.equal(w.of('rails', 'GET', '/api/v1/accounts/1/conversations/42').length, 2, 'checked once per DRI change, then remembered');
});

test('owner: a conversation a human already assigned before we saw it is left alone', async () => {
  const w = ownerWorld();
  w.cw.assignees.set(42, 99);
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  assert.equal(assigns(w).length, 0);
  assert.equal(attrWrites(w).length, 1, 'attributes are still set');
});

test('owner: DRI who is not a Chatwoot agent -> attributes set, no assignment, logged', async () => {
  const w = ownerWorld({ ...RHEA, dri_email: 'new.hire@kita.ai', dri_name: null });
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  assert.equal(assigns(w).length, 0);
  assert.equal(attrWrites(w)[0].body.custom_attributes.account_owner, 'new.hire@kita.ai', 'falls back to the email');
});

test('owner: agent bot token cannot list agents -> attributes still set, no assignment, job not dead', async () => {
  const w = ownerWorld();
  w.cw.agentsStatus = 401;
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  assert.equal(assigns(w).length, 0);
  assert.equal(attrWrites(w).length, 1);
  assert.equal(w.store.getJob('owner:42'), undefined);
});

test('owner (SCOPE_FILTER=on): out-of-scope conversations get attributes but are never assigned', async () => {
  const w = ownerWorld(RHEA, true);
  w.grip.inScope = false;
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  assert.equal(assigns(w).length, 0);
  assert.equal(attrWrites(w).length, 1);
});

test('owner (SCOPE_FILTER off, default): out-of-scope accounts are assigned to their DRI like any customer', async () => {
  const w = ownerWorld();
  w.grip.inScope = false;
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  assert.equal(assigns(w).length, 1);
});

test('owner: idempotent, unchanged values cause no Chatwoot writes; only changed keys are sent', async () => {
  const w = ownerWorld();
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  const before = w.of('rails').length;
  w.sync.ingest(customer(5002), 'd2');
  w.sync.ingest(fixture('message_outgoing_agent.json'), 'd3');
  await w.drain();
  assert.equal(w.of('rails').length, before, 'no Chatwoot calls at all when nothing changed');
  Object.assign(w.owner, { account_name: 'Acme Lending Corp' });
  w.sync.ingest(customer(5004), 'd4');
  await w.drain();
  assert.deepEqual(attrWrites(w).at(-1)!.body.custom_attributes, { grip_account: 'Acme Lending Corp' });
  assert.equal(assigns(w).length, 1);
  assert.deepEqual(w.cw.attrs.get(42), { account_owner: 'Rhea Malhotra', account_owner_email: 'rhea@kita.ai', sales_owner: 'carmel@kita.ai', grip_account: 'Acme Lending Corp' });
});

test('owner: attribute definitions are created once when missing; a non-admin token only logs', async () => {
  const w = ownerWorld();
  w.cw.definitions.push({ attribute_key: 'account_owner' });
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  w.sync.ingest(customer(5002), 'd2');
  await w.drain();
  const created = w.of('rails', 'POST', '/api/v1/accounts/1/custom_attribute_definitions').map((c) => c.body.custom_attribute_definition);
  assert.deepEqual(created.map((d) => d.attribute_key), ['account_owner_email', 'sales_owner', 'grip_account']);
  assert.deepEqual(created[0], OWNER_ATTRIBUTES[1]);
  assert.equal(created[0].attribute_model, 'conversation_attribute');
  assert.equal(w.of('rails', 'GET', '/api/v1/accounts/1/custom_attribute_definitions').length, 1, 'checked once per process');

  const w2 = ownerWorld();
  w2.cw.definitionsStatus = 401;
  w2.sync.ingest(customer(5001), 'd1');
  await w2.drain();
  assert.equal(attrWrites(w2).length, 1, 'values are written even without definitions');
  assert.equal(w2.store.getJob('owner:42'), undefined);
});

test('owner: Grip without owner fields (older Grip) or owners disabled -> no owner calls', async () => {
  const w = world({ owners: true });
  w.sync.ingest(customer(5001), 'd1');
  await w.drain();
  const w2 = world();
  Object.assign(w2.owner, RHEA);
  w2.sync.ingest(customer(5001), 'd1');
  await w2.drain();
  for (const x of [w, w2]) assert.equal(x.of('rails').filter((c) => /agents|custom_attribute|assignments/.test(c.path)).length, 0);
});
