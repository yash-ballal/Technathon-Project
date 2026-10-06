/**
 * Offline queue and synchronisation state.
 *
 * Spec requirement: communicate Online / Offline / Syncing / Synced / Pending /
 * Failed; let the worker keep documenting a case while offline and save locally;
 * distinguish local from server-backed data; auto-sync on reconnect; and on failure
 * show an understandable error plus a recovery action rather than losing data.
 *
 * Previously `syncQueue` existed as state that was never populated: nothing was ever
 * queued, so "Pending Sync" was permanently 0 and the reconnect handler only printed
 * a toast. This module makes the queue real.
 *
 * Pure and dependency-free (no React, no timers, no storage) so it is unit testable.
 * Callers own persistence and the actual network call.
 */

export const CONNECTION = {
  ONLINE: 'online',
  OFFLINE: 'offline',
};

export const SYNC_STATE = {
  SYNCED: 'synced',
  PENDING: 'pending',
  SYNCING: 'syncing',
  FAILED: 'failed',
  // Offline is a connection state, but the indicator shows it alongside sync states so
  // the worker sees one meaningful status rather than two competing ones.
  OFFLINE: 'offline',
};

/** Display metadata for each connection/sync state, in the app's existing tone vocabulary. */
export const SYNC_STATE_META = {
  synced: { label: 'Synced', tone: 'emerald', description: 'All records are stored on the server.' },
  pending: { label: 'Pending', tone: 'amber', description: 'Saved on this device only, waiting to upload.' },
  syncing: { label: 'Syncing', tone: 'blue', description: 'Upload in progress.' },
  failed: { label: 'Failed', tone: 'rose', description: 'Upload failed. The record is still saved locally.' },
  offline: { label: 'Offline', tone: 'amber', description: 'No connection. Records are being saved locally.' },
  online: { label: 'Online', tone: 'emerald', description: 'Connected to the server.' },
};

export function syncStateMeta(state) {
  return SYNC_STATE_META[state] || SYNC_STATE_META.pending;
}

/** Stable identity for one queued operation, used for dedupe and retry targeting. */
export function operationKey(op) {
  if (!op || typeof op !== 'object') return '';
  return `${op.table ?? ''}:${op.kind ?? 'insert'}:${op.localId ?? ''}`;
}

/**
 * Queue a local write. Idempotent: queueing the same operation twice does not
 * duplicate it (a reconnect handler firing twice must not double-insert).
 */
export function enqueue(queue, operation) {
  const list = Array.isArray(queue) ? queue : [];
  const op = {
    ...operation,
    kind: operation?.kind ?? 'insert',
    attempts: operation?.attempts ?? 0,
    status: operation?.status ?? SYNC_STATE.PENDING,
    lastError: operation?.lastError ?? '',
    queuedAt: operation?.queuedAt ?? '',
  };
  const key = operationKey(op);
  if (key && list.some((existing) => operationKey(existing) === key)) return list;
  return [...list, op];
}

/** Operations still awaiting upload (pending or previously failed). */
export function pendingOperations(queue) {
  return (Array.isArray(queue) ? queue : []).filter(
    (op) => op && (op.status === SYNC_STATE.PENDING || op.status === SYNC_STATE.FAILED)
  );
}

/** Failed operations, for the Sync Center's recovery actions. */
export function failedOperations(queue) {
  return (Array.isArray(queue) ? queue : []).filter((op) => op && op.status === SYNC_STATE.FAILED);
}

export function markSyncing(queue, key) {
  return (Array.isArray(queue) ? queue : []).map((op) =>
    operationKey(op) === key ? { ...op, status: SYNC_STATE.SYNCING } : op
  );
}

export function markSynced(queue, key) {
  // A synced operation leaves the queue: it is on the server now.
  return (Array.isArray(queue) ? queue : []).filter((op) => operationKey(op) !== key);
}

export function markFailed(queue, key, error = '') {
  return (Array.isArray(queue) ? queue : []).map((op) =>
    operationKey(op) === key
      ? { ...op, status: SYNC_STATE.FAILED, attempts: (op.attempts ?? 0) + 1, lastError: String(error || '') }
      : op
  );
}

/**
 * Decide what the queue should do next.
 *
 * @returns {{state: string, key: string|null, operation: object|null, reason: string}}
 */
export function nextOperation(queue, { online = true, maxAttempts = 3 } = {}) {
  if (!online) {
    return {
      state: SYNC_STATE.PENDING,
      key: null,
      operation: null,
      reason: 'Offline: records stay saved locally until the connection returns.',
    };
  }

  const list = Array.isArray(queue) ? queue : [];
  const exhausted = list.filter((op) => op && op.status === SYNC_STATE.FAILED && (op.attempts ?? 0) >= maxAttempts);
  if (exhausted.length > 0) {
    return {
      state: SYNC_STATE.FAILED,
      key: operationKey(exhausted[0]),
      operation: exhausted[0],
      reason: `${exhausted.length} record(s) failed after ${maxAttempts} attempts and need a manual retry.`,
    };
  }

  const candidates = list.filter(
    (op) => op && (op.status === SYNC_STATE.PENDING || op.status === SYNC_STATE.FAILED) && (op.attempts ?? 0) < maxAttempts
  );
  if (candidates.length === 0) {
    return { state: list.length === 0 ? SYNC_STATE.SYNCED : SYNC_STATE.PENDING, key: null, operation: null, reason: 'Nothing to upload.' };
  }

  return { state: SYNC_STATE.SYNCING, key: operationKey(candidates[0]), operation: candidates[0], reason: 'Uploading the oldest pending record first.' };
}

/**
 * Overall status for the indicator: the worker should never have to guess whether
 * their documentation is safe.
 */
export function overallSyncState(queue, { online = true } = {}) {
  if (!online) return SYNC_STATE.OFFLINE;
  const list = Array.isArray(queue) ? queue : [];
  if (list.some((op) => op && op.status === SYNC_STATE.SYNCING)) return SYNC_STATE.SYNCING;
  if (list.some((op) => op && op.status === SYNC_STATE.FAILED)) return SYNC_STATE.FAILED;
  if (list.some((op) => op && op.status === SYNC_STATE.PENDING)) return SYNC_STATE.PENDING;
  return SYNC_STATE.SYNCED;
}

/**
 * Process the whole queue in order.
 *
 * `send` performs one operation and should resolve on success or reject on failure.
 * Stops at the first failure so ordering is preserved and the error is actionable.
 */
export async function flushQueue(queue, send, { online = true, maxAttempts = 3, onProgress } = {}) {
  let working = Array.isArray(queue) ? [...queue] : [];
  if (!online) return { queue: working, synced: [], failed: [], stopped: true, reason: 'offline' };

  const synced = [];
  const failed = [];

  for (;;) {
    const next = nextOperation(working, { online, maxAttempts });
    if (next.state !== SYNC_STATE.SYNCING || !next.key) {
      return { queue: working, synced, failed, stopped: next.state === SYNC_STATE.FAILED, reason: next.reason };
    }

    working = markSyncing(working, next.key);
    if (typeof onProgress === 'function') onProgress({ state: SYNC_STATE.SYNCING, key: next.key });

    try {
      await send(next.operation);
      working = markSynced(working, next.key);
      synced.push(next.key);
      if (typeof onProgress === 'function') onProgress({ state: SYNC_STATE.SYNCED, key: next.key });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      working = markFailed(working, next.key, message);
      failed.push(next.key);
      if (typeof onProgress === 'function') onProgress({ state: SYNC_STATE.FAILED, key: next.key, error: message });
      // Stop on first failure: continuing could apply later changes out of order,
      // and the worker needs an understandable error rather than a partial cascade.
      return { queue: working, synced, failed, stopped: true, reason: message };
    }
  }
}

/** Whether a data item is server-backed or only on this device (spec: distinguish the two). */
export function storageOrigin(item) {
  if (!item || typeof item !== 'object') return 'unknown';
  if (item.syncedAt) return 'server';
  if (item.pendingSync || item.localOnly) return 'local';
  return item.id !== undefined && item.id !== null ? 'server' : 'local';
}

export function originLabel(origin) {
  if (origin === 'server') return 'On server';
  if (origin === 'local') return 'Saved on this device only';
  return 'Unknown';
}

/** Empty-state text that explains rather than showing a blank panel. */
export function syncCenterEmptyMessage(queue, online) {
  if (!online) return 'Offline. New records will be saved on this device and uploaded automatically.';
  return pendingOperations(queue).length === 0 ? 'Everything on this device is synced.' : '';
}
