import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backfiller, isRetryableError, RETRY_DELAYS_MS } from '../src/backfill.ts';
import { Store } from '../src/store.ts';

/** A runner that fails with each queued error, then succeeds. */
function setup(errors: string[]) {
  const store = new Store(':memory:');
  const scheduled: { fn: () => void; ms: number }[] = [];
  let runs = 0;
  const backfiller = new Backfiller({
    store,
    deliver: async () => 'created',
    runners: {
      slack: async () => {
        runs++;
        const error = errors.shift();
        if (error) throw new Error(error);
      },
    },
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  return { store, scheduled, backfiller, runs: () => runs };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('retryable errors: desk 5xx, 429 and network failures; not 4xx', () => {
  assert.equal(isRetryableError('chatwoot POST /api/v1/inboxes/… -> 502'), true);
  assert.equal(isRetryableError('kita desk staff_messages -> 503'), true);
  assert.equal(isRetryableError('slack conversations.history -> 429'), true);
  assert.equal(isRetryableError('fetch failed'), true);
  assert.equal(isRetryableError('read ECONNRESET'), true);
  assert.equal(isRetryableError('chatwoot POST … -> 422'), false);
  assert.equal(isRetryableError('TypeError: x is undefined'), false);
});

test('a backfill that fails on a desk 502 retries in-process (30s) and completes', async () => {
  const s = setup(['chatwoot POST /api/v1/inboxes/… -> 502']);
  assert.equal(await s.backfiller.request('slack', 'slack:C1', { channel: 'C1' }), 'failed');
  assert.equal(s.store.getBackfill('slack:C1')?.state, 'failed');
  assert.deepEqual(s.scheduled.map((r) => r.ms), [RETRY_DELAYS_MS[0]]);

  s.scheduled[0].fn();
  await flush();
  await flush();
  assert.equal(s.store.getBackfill('slack:C1')?.state, 'completed');
  assert.equal(s.runs(), 2);
});

test('backs off 30s, 2m, 10m, then stops; reconcile still resumes failed runs', async () => {
  const s = setup(['-> 502', '-> 502', '-> 502', '-> 502', '-> 502']);
  await s.backfiller.request('slack', 'slack:C1', { channel: 'C1' });
  for (let i = 0; i < 3; i++) {
    s.scheduled[i].fn();
    await flush();
    await flush();
  }
  assert.deepEqual(s.scheduled.map((r) => r.ms), RETRY_DELAYS_MS);
  assert.equal(s.runs(), 4);
  assert.equal(s.store.getBackfill('slack:C1')?.state, 'failed');

  // The periodic reconcile picks failed backfills up again
  const outcomes = await s.backfiller.resumeUnfinished();
  assert.deepEqual(outcomes, ['failed']);
  assert.equal(s.runs(), 5);
});

test('a non-retryable failure is not retried in-process', async () => {
  const s = setup(['chatwoot POST … -> 422']);
  assert.equal(await s.backfiller.request('slack', 'slack:C1', { channel: 'C1' }), 'failed');
  assert.equal(s.scheduled.length, 0);
});
