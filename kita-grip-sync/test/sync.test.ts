import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS } from '../src/sync.ts';
import { fixture, ISSUE, msg, NOT_ISSUE, world } from './helpers.ts';

const SEC = 1000;
const customer = (id: number, content: string, at = '2026-09-24T02:00:00Z') => msg('message_incoming_slack.json', { id, content, created_at: at });

test('conversation upsert: fields, bearer key, waiting_on flips with each side', async () => {
  const w = world();
  assert.equal(w.sync.ingest(fixture('message_incoming_slack.json'), 'd1'), 'ok');
  await w.drain();
  let [call] = w.of('grip', 'POST', '/api/v1/support/conversations');
  assert.equal(call.headers.authorization, 'Bearer grip_testkey');
  assert.deepEqual(call.body, {
    chatwoot_conversation_id: 42, channel_key: 'slack:C06SHARED01', platform: 'slack', channel_label: '#kita-acme-lending', status: 'open',
    waiting_on: 'kita', last_message_at: '2026-09-24T01:58:00.000Z', last_customer_message_at: '2026-09-24T01:58:00.000Z',
    last_message_preview: 'Hi team, the risk score API has been returning 500s for every application since this morning. Our loan officers are blocked.',
    message_count: 1, chatwoot_url: 'https://support.internal.kita.ai/app/accounts/1/conversations/42',
  });
  w.sync.ingest(fixture('message_outgoing_agent.json'), 'd2');
  await w.drain();
  call = w.of('grip', 'POST', '/api/v1/support/conversations').at(-1)!;
  assert.equal(call.body.waiting_on, 'customer');
  assert.equal(call.body.message_count, 2);
  assert.equal(call.body.last_message_at, '2026-09-24T02:03:00.000Z');
  assert.equal(call.body.last_customer_message_at, '2026-09-24T01:58:00.000Z');
  w.sync.ingest(fixture('conversation_resolved.json'), 'd3');
  await w.drain();
  call = w.of('grip', 'POST', '/api/v1/support/conversations').at(-1)!;
  assert.deepEqual([call.body.status, call.body.waiting_on], ['resolved', 'none']);
});

test('conversation upsert: native WhatsApp conversation gets whatsapp:<E.164>', async () => {
  const w = world();
  w.sync.ingest(fixture('message_incoming_whatsapp.json'), 'd1');
  await w.drain();
  const [call] = w.of('grip', 'POST', '/api/v1/support/conversations');
  assert.equal(call.body.channel_key, 'whatsapp:+639171234567');
  assert.equal(call.body.platform, 'whatsapp');
  assert.equal(call.body.channel_label, 'Jun Reyes');
});

test('conversation_created with no messages yet syncs with waiting_on none', async () => {
  const w = world();
  w.sync.ingest(fixture('conversation_created_slack.json'), 'd1');
  await w.drain();
  const [call] = w.of('grip', 'POST', '/api/v1/support/conversations');
  assert.deepEqual([call.body.waiting_on, call.body.message_count], ['none', 0]);
});

test('dedupe: repeated delivery id and repeated message id are no-ops; bursts coalesce into one Grip call', async () => {
  const w = world();
  assert.equal(w.sync.ingest(fixture('message_incoming_slack.json'), 'same'), 'ok');
  assert.equal(w.sync.ingest(fixture('message_incoming_slack.json'), 'same'), 'duplicate');
  assert.equal(w.sync.ingest(fixture('message_incoming_slack.json'), 'other-delivery'), 'ok'); // same message id 5001
  assert.equal(w.sync.ingest({ event: 'contact_updated', id: 1 }, 'x'), 'ignored');
  await w.drain();
  const calls = w.of('grip', 'POST', '/api/v1/support/conversations');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.message_count, 1);
});

test('debounce: a burst of customer messages is classified once, 60s after the last one, with the whole thread', async () => {
  const w = world();
  w.classifications.push(ISSUE);
  w.sync.ingest(customer(5001, 'first'), 'a');
  w.advance(20 * SEC);
  w.sync.ingest(customer(5002, 'second'), 'b');
  w.advance(20 * SEC);
  w.sync.ingest(customer(5003, 'third'), 'c');
  w.advance(59 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 0, 'still inside the debounce window');
  w.advance(1 * SEC);
  await w.drain();
  const claude = w.of('anthropic');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(claude[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(claude[0].body.model, 'claude-sonnet-5');
  assert.equal(claude[0].body.output_config.format.type, 'json_schema');
  assert.deepEqual(claude[0].body.output_config.format.schema.required, ['is_issue', 'title', 'priority', 'summary']);
  const prompt = claude[0].body.messages[0].content as string;
  assert.ok(prompt.includes('first') && prompt.includes('second') && prompt.includes('third'));
  // Nothing new since: another tick costs nothing.
  w.advance(120 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 1);
});

test('debounce: a conversation that never pauses is still classified after the max wait', async () => {
  const w = world();
  w.classifications.push(NOT_ISSUE);
  for (let i = 0; i < 12; i++) {
    w.sync.ingest(customer(6000 + i, `msg ${i}`), `m${i}`);
    w.advance(30 * SEC);
    await w.drain();
  }
  // first message at t=0, cap = 300s; by t=360s exactly one classification has run
  assert.equal(w.of('anthropic').length, 1);
});

test('tickets: created once with private note + label, then updated/escalated through the same upsert', async () => {
  const w = world();
  w.classifications.push(ISSUE);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.advance(60 * SEC);
  await w.drain();

  const [create] = w.of('grip', 'POST', '/api/v1/support/tickets');
  assert.equal(create.body.chatwoot_conversation_id, 42);
  assert.equal(create.body.title, ISSUE.title);
  assert.equal(create.body.priority, 'high');
  assert.equal(create.body.chatwoot_url, 'https://support.internal.kita.ai/app/accounts/1/conversations/42');
  const notes = w.of('rails', 'POST', /\/messages$/);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body.private, true, 'ticket notes are private, never customer-facing');
  assert.equal(notes[0].headers['api-access-token'], 'cw-bot-token');
  assert.ok(notes[0].body.content.includes('https://internal.kita.ai/tasks/t-1'));
  assert.deepEqual(w.labels.get(42), ['ticket']);

  // Later message: escalates to urgent, same ticket, one escalation note.
  w.classifications.push({ ...ISSUE, priority: 'urgent', summary: 'Still down; they are missing disbursement cut-off.' });
  w.sync.ingest(customer(5010, 'still broken, we will miss the cut-off!'), 'd2');
  w.advance(60 * SEC);
  await w.drain();
  assert.equal(w.tickets.size, 1);
  assert.equal(w.tickets.get(42).priority, 'urgent');
  assert.equal(w.of('grip', 'POST', '/api/v1/support/tickets').length, 2);
  const allNotes = w.of('rails', 'POST', /\/messages$/);
  assert.equal(allNotes.length, 2);
  assert.ok(allNotes[1].body.content.includes('escalated to **urgent**'));
  assert.ok(allNotes.every((n) => n.body.private === true));

  // Classifier later says "medium": priority is never auto-downgraded, and no new note.
  w.classifications.push({ ...ISSUE, priority: 'medium', summary: 'Still down; they are missing disbursement cut-off.' });
  w.sync.ingest(customer(5011, 'any update?'), 'd3');
  w.advance(60 * SEC);
  await w.drain();
  assert.equal(w.tickets.get(42).priority, 'urgent');
  assert.equal(w.of('rails', 'POST', /\/messages$/).length, 2);
  assert.equal(w.tickets.size, 1);
  assert.equal(w.of('rails', 'POST', /\/labels$/).length, 1, 'label added once');
});

test('tickets: non-issues create nothing; agent replies never trigger classification', async () => {
  const w = world();
  w.classifications.push(NOT_ISSUE);
  w.sync.ingest(fixture('message_incoming_whatsapp.json'), 'd1');
  w.sync.ingest(msg('message_outgoing_agent.json', { id: 7001 }), 'd2');
  w.advance(10 * 60 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 1);
  assert.equal(w.of('grip', 'POST', '/api/v1/support/tickets').length, 0);
  assert.equal(w.of('rails').length, 0);
});

test('resolve -> ticket done; reopen -> ticket todo; conversations without tickets get no PATCH', async () => {
  const w = world();
  w.sync.ingest(fixture('conversation_resolved.json'), 'r0');
  await w.drain();
  assert.equal(w.of('grip', 'PATCH').length, 0);

  w.classifications.push(ISSUE);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.advance(60 * SEC);
  await w.drain();
  w.sync.ingest(fixture('conversation_resolved.json'), 'r1');
  await w.drain();
  let patches = w.of('grip', 'PATCH');
  assert.deepEqual(patches.map((p) => [p.path, p.body.status]), [['/api/v1/support/tickets/42', 'done']]);
  w.sync.ingest(fixture('conversation_resolved.json'), 'r1-replay-other-delivery');
  await w.drain();
  assert.equal(w.of('grip', 'PATCH').length, 1, 'already done: no repeat PATCH');

  w.sync.ingest({ ...fixture('conversation_resolved.json'), status: 'open' }, 'r2');
  await w.drain();
  patches = w.of('grip', 'PATCH');
  assert.equal(patches.at(-1)!.body.status, 'todo');
  assert.equal(w.tickets.get(42).status, 'todo');
});

test('not-a-ticket: ticket dismissed, dismissal logged, conversation never auto-ticketed again', async () => {
  const w = world();
  w.classifications.push(ISSUE);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.advance(60 * SEC);
  await w.drain();
  w.sync.ingest(fixture('conversation_labeled_not_a_ticket.json'), 'l1');
  await w.drain();
  assert.deepEqual(w.of('grip', 'PATCH').map((p) => p.body.status), ['dismissed']);
  assert.equal(w.tickets.get(42).status, 'dismissed');
  const [d] = w.store.dismissals();
  assert.equal(d.conversation_id, 42);
  assert.equal(d.title, ISSUE.title);
  assert.ok(JSON.parse(d.thread).length >= 1, 'thread kept for prompt tuning');

  // More customer messages, even after the label is removed and a resolve/reopen cycle: no classification, no ticket change.
  w.sync.ingest({ ...fixture('conversation_labeled_not_a_ticket.json'), labels: ['ticket'] }, 'l2');
  w.sync.ingest(customer(5020, 'it is broken again'), 'd2');
  w.sync.ingest(fixture('conversation_resolved.json'), 'r1');
  w.sync.ingest({ ...fixture('conversation_resolved.json'), status: 'open' }, 'r2');
  w.advance(10 * 60 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 1);
  assert.equal(w.of('grip', 'PATCH').length, 1);
  assert.equal(w.of('grip', 'POST', '/api/v1/support/tickets').length, 1);
});

test('not-a-ticket before any ticket: cancels the pending classification; nothing is ever created', async () => {
  const w = world();
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.sync.ingest({ ...fixture('conversation_labeled_not_a_ticket.json'), labels: ['not-a-ticket'] }, 'l1');
  w.sync.ingest(customer(5030, 'hello?'), 'd2');
  w.advance(10 * 60 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 0);
  assert.equal(w.of('grip', 'PATCH').length, 0);
  assert.equal(w.store.dismissals().length, 1);
});

test('loop safety: our own private note and label changes never count or trigger classification', async () => {
  const w = world();
  w.classifications.push(ISSUE);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.advance(60 * SEC);
  await w.drain();
  const before = w.store.getConversation(42)!;
  // Chatwoot echoes the note we posted and the label we added back to us as webhooks.
  assert.equal(w.sync.ingest(fixture('message_private_note_self.json'), 'echo-note'), 'ok');
  assert.equal(w.sync.ingest({ ...fixture('conversation_labeled_not_a_ticket.json'), labels: ['ticket'] }, 'echo-label'), 'ok');
  assert.equal(w.store.getJob('classify:42'), undefined);
  w.advance(10 * 60 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 1);
  const after = w.store.getConversation(42)!;
  assert.equal(after.messageCount, before.messageCount);
  assert.equal(after.lastSpeaker, 'customer');
  assert.ok(!w.store.thread(42).some((m) => m.content.includes('Grip ticket')), 'notes never reach the classifier');
});

test('retries: Grip 503 / network errors back off and succeed; 4xx is not retried', async () => {
  const w = world();
  w.fail.grip.push(503, -1);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  await w.drain();
  let job = w.store.getJob('sync:42')!;
  assert.equal(job.attempts, 1);
  assert.ok(job.runAt > w.now(), 'backing off, not hot-looping');
  w.advance(10 * SEC);
  await w.drain();
  assert.equal(w.store.getJob('sync:42')!.attempts, 2);
  w.advance(60 * SEC);
  await w.drain();
  assert.equal(w.store.getJob('sync:42'), undefined);
  assert.equal(w.of('grip', 'POST', '/api/v1/support/conversations').length, 3);

  w.fail.grip.push(400);
  w.sync.ingest(fixture('message_outgoing_agent.json'), 'd2');
  await w.drain();
  job = w.store.getJob('sync:42')!;
  assert.ok(job.dead);
  w.advance(3600 * SEC);
  await w.drain();
  assert.equal(w.of('grip', 'POST', '/api/v1/support/conversations').length, 4, 'dead job not retried');
  // the next event revives it with fresh state
  w.sync.ingest(fixture('conversation_resolved.json'), 'd3');
  await w.drain();
  assert.equal(w.of('grip', 'POST', '/api/v1/support/conversations').at(-1)!.body.status, 'resolved');
});

test('retries: gives up after MAX_ATTEMPTS', async () => {
  const w = world();
  w.fail.grip.push(...Array(MAX_ATTEMPTS).fill(500));
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await w.drain();
    w.advance(2 * 3600 * SEC);
  }
  assert.equal(w.of('grip', 'POST', '/api/v1/support/conversations').length, MAX_ATTEMPTS);
  assert.ok(w.store.getJob('sync:42')!.dead);
});

test('retries: Claude 429 and a failed ticket POST retry without duplicating tickets or notes', async () => {
  const w = world();
  w.classifications.push(ISSUE, ISSUE);
  w.fail.anthropic.push(429);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w.advance(60 * SEC);
  await w.drain(); // claude 429
  assert.equal(w.of('anthropic').length, 1);
  w.fail.grip.push(502); // the ticket POST (conversation sync already done)
  w.advance(10 * SEC);
  await w.drain(); // claude ok, ticket POST 502
  assert.equal(w.tickets.size, 0);
  w.advance(20 * SEC);
  await w.drain(); // classify again (one more Claude call), ticket created
  assert.equal(w.tickets.size, 1);

  // Label step fails after the note was posted: the retry adds the label without a second note.
  const w2 = world();
  w2.classifications.push(ISSUE);
  w2.fail.rails.push(0, 503); // 0 = pass: note POST ok, then labels GET fails
  w2.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  w2.advance(60 * SEC);
  await w2.drain();
  assert.equal(w2.of('rails', 'POST', /\/messages$/).length, 1);
  assert.equal(w2.labels.get(42), undefined);
  assert.equal(w2.store.getTicket(42)!.notePosted, true);
  w2.advance(60 * SEC);
  await w2.drain();
  assert.deepEqual(w2.labels.get(42), ['ticket']);
  assert.equal(w2.of('rails', 'POST', /\/messages$/).length, 1, 'note not repeated');
  assert.equal(w2.of('grip', 'POST', '/api/v1/support/tickets').length, 1, 'ticket not re-created');
});

// ---------- out-of-scope accounts (Grip answers in_scope: false) ----------

test('out of scope: resolved via toggle_status + label out-of-scope (existing labels kept), never classified', async () => {
  const w = world();
  w.grip.inScope = false;
  w.labels.set(42, ['vip']);
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  assert.ok(w.store.getJob('classify:42'), 'classification armed before Grip has answered');
  await w.drain();
  assert.equal(w.store.getConversation(42)!.outOfScope, true);
  assert.equal(w.store.getJob('classify:42'), undefined, 'pending classification cancelled');
  const [toggle] = w.of('rails', 'POST', '/api/v1/accounts/1/conversations/42/toggle_status');
  assert.deepEqual(toggle.body, { status: 'resolved' });
  assert.equal(toggle.headers['api-access-token'], 'cw-bot-token');
  assert.equal(w.statuses.get(42), 'resolved');
  assert.deepEqual(w.labels.get(42), ['vip', 'out-of-scope']);
  w.advance(10 * 60 * 1000);
  await w.drain();
  assert.equal(w.of('anthropic').length, 0);
  assert.equal(w.of('grip', 'POST', '/api/v1/support/tickets').length, 0);
  assert.equal(w.of('rails', 'POST', /\/messages$/).length, 0, 'no private note');
});

test('out of scope: done once per conversation; later messages and our own status/label echoes do nothing more', async () => {
  const w = world();
  w.grip.inScope = false;
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  await w.drain();
  // echoes of what we did, then the customer writes again (Chatwoot reopens) and Grip still says out of scope
  w.sync.ingest(fixture('conversation_resolved.json'), 'echo-status');
  w.sync.ingest({ ...fixture('conversation_labeled_not_a_ticket.json'), labels: ['out-of-scope'] }, 'echo-label');
  w.sync.ingest({ ...customer(5040, 'anyone there?'), conversation: { ...fixture('message_incoming_slack.json').conversation, status: 'open', labels: ['out-of-scope'] } }, 'd2');
  assert.equal(w.store.getJob('classify:42'), undefined, 'no classification is armed while out of scope');
  w.advance(10 * 60 * 1000);
  await w.drain();
  assert.equal(w.of('rails', 'POST', /toggle_status$/).length, 1);
  assert.equal(w.of('rails', 'POST', /\/labels$/).length, 1);
  assert.equal(w.of('anthropic').length, 0);
  assert.ok(w.of('grip', 'POST', '/api/v1/support/conversations').length >= 2, 'Grip still gets the conversation snapshot');
});

test('out of scope: resolve/label retries are idempotent (Chatwoot 503 then success, one label)', async () => {
  const w = world();
  w.grip.inScope = false;
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  await w.sync.runDue(); // sync job -> Grip says out of scope -> enqueues out_of_scope
  w.fail.rails.push(503);
  await w.drain();
  const job = w.store.getJob('out_of_scope:42')!;
  assert.equal(job.attempts, 1, 'toggle_status 503 is retried with backoff');
  w.advance(job.runAt - w.now());
  await w.drain();
  assert.equal(w.store.getJob('out_of_scope:42'), undefined);
  assert.equal(w.statuses.get(42), 'resolved');
  assert.deepEqual(w.labels.get(42), ['out-of-scope']);
});

test('out of scope -> back in scope: block lifted, no auto-reopen, new customer messages classify again', async () => {
  const w = world();
  w.grip.inScope = false;
  w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
  await w.drain();
  w.grip.inScope = true; // account became Active in Grip
  w.classifications.push(ISSUE);
  w.sync.ingest({ ...customer(5050, 'still broken'), conversation: { ...fixture('message_incoming_slack.json').conversation, status: 'open' } }, 'd2');
  await w.drain();
  assert.equal(w.store.getConversation(42)!.outOfScope, false);
  assert.equal(w.of('rails', 'POST', /toggle_status$/).length, 1, 'never toggled back open by us');
  assert.equal(w.store.getJob('classify:42'), undefined, 'the message that arrived while blocked is not retro-armed');
  w.sync.ingest({ ...customer(5051, 'please help'), conversation: { ...fixture('message_incoming_slack.json').conversation, status: 'open' } }, 'd3');
  w.advance(60 * SEC);
  await w.drain();
  assert.equal(w.of('anthropic').length, 1);
  assert.equal(w.of('grip', 'POST', '/api/v1/support/tickets').length, 1);
});

test('in scope or an older Grip without in_scope: nothing is resolved or labelled', async () => {
  for (const v of [true, undefined]) {
    const w = world();
    w.grip.inScope = v;
    w.classifications.push(NOT_ISSUE);
    w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
    w.advance(60 * SEC);
    await w.drain();
    assert.equal(w.of('rails', 'POST', /toggle_status$/).length, 0);
    assert.equal(w.of('anthropic').length, 1);
    assert.equal(!!w.store.getConversation(42)!.outOfScope, false);
  }
});

test('in_scope is read from both the flat response and Grip\'s { success, data } envelope', async () => {
  for (const envelope of [false, true]) {
    const w = world();
    w.grip.envelope = envelope;
    w.grip.inScope = false;
    w.sync.ingest(fixture('message_incoming_slack.json'), 'd1');
    await w.drain();
    assert.equal(w.store.getConversation(42)!.outOfScope, true, `envelope=${envelope}`);
    assert.deepEqual(w.labels.get(42), ['out-of-scope']);
  }
});

test('openai classifier: strict json_schema request, parses the reply', async () => {
  const { OpenAIClassifier } = await import('../src/claude.ts');
  let sent: any;
  const fake = (async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ is_issue: true, title: 'Fix export', priority: 'high', summary: 's' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = new OpenAIClassifier({ apiKey: 'k', model: 'gpt-5-mini' }, fake);
  const r = await c.classify([{ role: 'customer', content: 'export broken', createdAt: '2026-09-25T00:00:00Z' } as any]);
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(r, { is_issue: true, title: 'Fix export', priority: 'high', summary: 's' });
});
