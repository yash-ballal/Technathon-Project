/**
 * Tests for the offline queue and synchronisation state.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue,
  pendingOperations,
  failedOperations,
  markSyncing,
  markSynced,
  markFailed,
  nextOperation,
  overallSyncState,
  flushQueue,
  operationKey,
  storageOrigin,
  originLabel,
  syncStateMeta,
  syncCenterEmptyMessage,
  SYNC_STATE,
} from './syncQueue.js';

const op = (localId, extra = {}) => ({ table: 'cases', kind: 'insert', localId, ...extra });

test('enqueue adds an operation as pending', () => {
  const queue = enqueue([], op(1));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, SYNC_STATE.PENDING);
  assert.equal(queue[0].attempts, 0);
});

test('enqueue is idempotent so a repeated reconnect cannot double-insert', () => {
  const once = enqueue([], op(1));
  const twice = enqueue(once, op(1));
  assert.equal(twice.length, 1);
});

test('enqueue keeps genuinely different operations', () => {
  const queue = enqueue(enqueue([], op(1)), op(2));
  assert.equal(queue.length, 2);
});

test('enqueue tolerates a missing queue', () => {
  assert.equal(enqueue(null, op(1)).length, 1);
});

test('pendingOperations includes pending and failed, but not syncing', () => {
  let queue = enqueue(enqueue([], op(1)), op(2));
  queue = markSyncing(queue, operationKey(op(1)));
  const pending = pendingOperations(queue);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].localId, 2);
});

test('markSynced removes the operation from the queue', () => {
  let queue = enqueue(enqueue([], op(1)), op(2));
  queue = markSynced(queue, operationKey(op(1)));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].localId, 2);
});

test('markFailed records the error and increments attempts', () => {
  let queue = enqueue([], op(1));
  queue = markFailed(queue, operationKey(op(1)), 'Network unreachable');
  assert.equal(queue[0].status, SYNC_STATE.FAILED);
  assert.equal(queue[0].lastError, 'Network unreachable');
  assert.equal(queue[0].attempts, 1);
});

test('markFailed twice counts two attempts', () => {
  let queue = enqueue([], op(1));
  queue = markFailed(queue, operationKey(op(1)), 'e1');
  queue = markFailed(queue, operationKey(op(1)), 'e2');
  assert.equal(queue[0].attempts, 2);
  assert.equal(queue[0].lastError, 'e2');
});

test('failedOperations lists what needs a manual retry', () => {
  let queue = enqueue(enqueue([], op(1)), op(2));
  queue = markFailed(queue, operationKey(op(1)), 'boom');
  const failed = failedOperations(queue);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].localId, 1);
});

test('nextOperation refuses to send while offline', () => {
  const result = nextOperation(enqueue([], op(1)), { online: false });
  assert.equal(result.state, SYNC_STATE.PENDING);
  assert.equal(result.operation, null);
  assert.match(result.reason, /Offline/);
});

test('nextOperation returns the oldest pending operation first', () => {
  const queue = enqueue(enqueue([], op(1)), op(2));
  const result = nextOperation(queue, { online: true });
  assert.equal(result.state, SYNC_STATE.SYNCING);
  assert.equal(result.operation.localId, 1);
});

test('nextOperation reports synced when the queue is empty', () => {
  assert.equal(nextOperation([], { online: true }).state, SYNC_STATE.SYNCED);
});

test('nextOperation stops retrying an operation once attempts are exhausted', () => {
  let queue = enqueue([], op(1, { attempts: 3, status: SYNC_STATE.FAILED }));
  const result = nextOperation(queue, { online: true, maxAttempts: 3 });
  assert.equal(result.state, SYNC_STATE.FAILED);
  assert.match(result.reason, /manual retry/);
});

test('nextOperation retries a failed operation that still has attempts left', () => {
  const queue = enqueue([], op(1, { attempts: 1, status: SYNC_STATE.FAILED }));
  const result = nextOperation(queue, { online: true, maxAttempts: 3 });
  assert.equal(result.state, SYNC_STATE.SYNCING);
});

test('overallSyncState reports each state correctly', () => {
  assert.equal(overallSyncState([], { online: true }), SYNC_STATE.SYNCED);
  assert.equal(overallSyncState(enqueue([], op(1)), { online: true }), SYNC_STATE.PENDING);
  assert.equal(overallSyncState(enqueue([], op(1)), { online: false }), SYNC_STATE.OFFLINE);

  let queue = markSyncing(enqueue([], op(1)), operationKey(op(1)));
  assert.equal(overallSyncState(queue, { online: true }), SYNC_STATE.SYNCING);

  queue = markFailed(enqueue([], op(1)), operationKey(op(1)), 'e');
  assert.equal(overallSyncState(queue, { online: true }), SYNC_STATE.FAILED);
});

test('overallSyncState is never blank for the worker', () => {
  ['synced', 'pending', 'syncing', 'failed', 'offline', 'online'].forEach((state) => {
    const meta = syncStateMeta(state);
    assert.ok(meta.label.length > 0);
    assert.ok(meta.description.length > 0);
  });
});

test('flushQueue sends everything in order and empties the queue', async () => {
  const queue = enqueue(enqueue([], op(1)), op(2));
  const sent = [];
  const result = await flushQueue(queue, async (item) => { sent.push(item.localId); });

  assert.deepEqual(sent, [1, 2]);
  assert.equal(result.queue.length, 0);
  assert.equal(result.synced.length, 2);
  assert.equal(result.stopped, false);
});

test('flushQueue stops at the first failure and keeps the rest queued', async () => {
  const queue = enqueue(enqueue([], op(1)), op(2));
  const sent = [];
  const result = await flushQueue(queue, async (item) => {
    sent.push(item.localId);
    if (item.localId === 1) throw new Error('Server rejected the record');
  });

  assert.deepEqual(sent, [1]);
  assert.equal(result.stopped, true);
  assert.match(result.reason, /Server rejected/);
  assert.equal(failedOperations(result.queue).length, 1);
  // Both remaining operations are still waiting to upload: the failed one for a retry
  // and the untried one that was never sent. Neither is lost.
  assert.equal(pendingOperations(result.queue).length, 2);
});

test('flushQueue does nothing while offline and preserves the queue', async () => {
  const queue = enqueue([], op(1));
  const result = await flushQueue(queue, async () => { throw new Error('should not be called'); }, { online: false });
  assert.equal(result.stopped, true);
  assert.equal(result.queue.length, 1);
  assert.equal(result.reason, 'offline');
});

test('flushQueue reports progress for the indicator', async () => {
  const queue = enqueue([], op(1));
  const events = [];
  await flushQueue(queue, async () => {}, { onProgress: (e) => events.push(e.state) });
  assert.deepEqual(events, [SYNC_STATE.SYNCING, SYNC_STATE.SYNCED]);
});

test('flushQueue gives up after maxAttempts and surfaces a manual retry', async () => {
  const queue = enqueue([], op(1));
  let calls = 0;
  await flushQueue(queue, async () => { calls += 1; throw new Error('down'); }, { maxAttempts: 1 });
  const second = await flushQueue(enqueue([], op(1, { attempts: 1, status: SYNC_STATE.FAILED })), async () => {
    calls += 1;
    throw new Error('down');
  }, { maxAttempts: 1 });

  assert.equal(calls, 1);
  assert.equal(second.stopped, true);
  assert.match(second.reason, /manual retry/);
});

test('storageOrigin distinguishes local from server data', () => {
  assert.equal(storageOrigin({ id: 5 }), 'server');
  assert.equal(storageOrigin({ id: 5, pendingSync: true }), 'local');
  assert.equal(storageOrigin({ localOnly: true }), 'local');
  assert.equal(storageOrigin({ id: 5, syncedAt: '2026-10-06T10:00:00Z' }), 'server');
  assert.equal(storageOrigin(null), 'unknown');
});

test('originLabel explains where the data lives', () => {
  assert.equal(originLabel('server'), 'On server');
  assert.match(originLabel('local'), /this device only/);
  assert.equal(originLabel('unknown'), 'Unknown');
});

test('syncCenterEmptyMessage explains the situation instead of showing a blank panel', () => {
  assert.match(syncCenterEmptyMessage([], false), /Offline/);
  assert.match(syncCenterEmptyMessage([], true), /synced/);
  assert.equal(syncCenterEmptyMessage(enqueue([], op(1)), true), '');
});
