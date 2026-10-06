/**
 * Tests for the tamper-evident audit log.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendEntry,
  verifyLog,
  diffValues,
  filterEvents,
  filterFacets,
  describeEvent,
  entryPayload,
  computeEntryHash,
  fnv1aHex,
  GENESIS_HASH,
} from './auditLog.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function sampleLog() {
  let log = [];
  log = appendEntry(log, {
    timestamp: '2026-10-06T10:00:00Z',
    actor: 'Sita Devi',
    role: 'worker',
    action: 'PATIENT_CREATED',
    patientId: 4,
    details: 'Ramesh Sharma',
  });
  log = appendEntry(log, {
    timestamp: '2026-10-06T10:05:00Z',
    actor: 'Sita Devi',
    role: 'worker',
    action: 'CASE_CREATED',
    patientId: 4,
    caseId: 9,
  });
  log = appendEntry(log, {
    timestamp: '2026-10-06T10:10:00Z',
    actor: 'Sita Devi',
    role: 'worker',
    action: 'FIELD_EDITED',
    patientId: 4,
    caseId: 9,
    level: 'warn',
    changes: [{ field: 'temperature', from: '100 F', to: '101 F' }],
  });
  log = appendEntry(log, {
    timestamp: '2026-10-06T10:12:00Z',
    actor: 'Dr. A. Sharma',
    role: 'doctor',
    action: 'PRESCRIPTION_CREATED',
    patientId: 4,
    caseId: 9,
  });
  return log;
}

test('fnv1aHex is deterministic and 8 hex characters', () => {
  assert.equal(fnv1aHex('abc'), fnv1aHex('abc'));
  assert.match(fnv1aHex('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1aHex('abc'), fnv1aHex('abd'));
});

test('appending an entry does not mutate the previous log', () => {
  const first = appendEntry([], { action: 'A', timestamp: 't1' });
  const second = appendEntry(first, { action: 'B', timestamp: 't2' });
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  assert.equal(first[0].hash, second[0].hash);
});

test('entries chain from genesis', () => {
  const log = sampleLog();
  assert.equal(log[0].prevHash, GENESIS_HASH);
  assert.equal(log[1].prevHash, log[0].hash);
  assert.equal(log[2].prevHash, log[1].hash);
  log.forEach((entry) => assert.match(entry.hash, /^[0-9a-f]{8}$/));
});

test('a fresh log verifies as intact', () => {
  const result = verifyLog(sampleLog());
  assert.equal(result.valid, true);
  assert.equal(result.brokenAt, null);
});

test('an empty log is valid', () => {
  assert.equal(verifyLog([]).valid, true);
  assert.equal(verifyLog(null).valid, true);
});

test('editing an entry in place breaks the chain and names the entry', () => {
  const log = sampleLog();
  log[2].details = 'tampered';
  const result = verifyLog(log);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 2);
  assert.match(result.reason, /modified/);
});

test('rewriting an entry\'s action is detected', () => {
  const log = sampleLog();
  log[3].action = 'NOTHING_TO_SEE';
  assert.equal(verifyLog(log).valid, false);
  assert.equal(verifyLog(log).brokenAt, 3);
});

test('editing a recorded field change is detected', () => {
  const log = sampleLog();
  log[2].changes[0].to = '99 F';
  const result = verifyLog(log);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 2);
});

test('deleting an entry in the middle is detected', () => {
  const log = sampleLog();
  const spliced = [log[0], log[1], log[3]];
  const result = verifyLog(spliced);
  assert.equal(result.valid, false);
  assert.match(result.reason, /reordered|removed|inserted/);
});

test('reordering entries is detected', () => {
  const log = sampleLog();
  const swapped = [log[1], log[0], log[2], log[3]];
  assert.equal(verifyLog(swapped).valid, false);
});

test('truncating the tail leaves a valid prefix (append-only semantics)', () => {
  // Removing the newest entries cannot be detected by a chain alone: nothing later
  // references them. Detecting tail truncation needs an external anchor, which is why
  // this is documented rather than silently assumed.
  const log = sampleLog();
  assert.equal(verifyLog(log.slice(0, 2)).valid, true);
});

test('a forged entry that recomputes the chain defeats the pure-JS hash (documented limitation)', () => {
  const log = sampleLog();
  // An attacker who rewrites the entry and recomputes subsequent hashes produces a
  // self-consistent chain. FNV-1a cannot prevent this; a keyed/cryptographic hash is
  // required for real tamper-evidence.
  const forged = { ...log[2], details: 'rewritten' };
  const forgedLog = log.map((entry, i) => (i < 2 ? entry : null)).filter(Boolean);
  let prevHash = GENESIS_HASH;
  const rebuilt = [];
  const source = [log[0], log[1], forged, log[3]];
  source.forEach((entry, i) => {
    const base = { ...entry, prevHash };
    const hash = i === 2 ? computeEntryHash({ ...base, details: 'rewritten' }, prevHash) : computeEntryHash(base, prevHash);
    rebuilt.push({ ...base, hash });
    prevHash = hash;
  });
  // Demonstrates the limitation explicitly: the rebuilt chain verifies.
  assert.equal(verifyLog(rebuilt).valid, true);
  assert.equal(forgedLog.length, 2);
});

test('an injected cryptographic hash works through the same interface', () => {
  let log = [];
  const opts = { hashFn: sha256 };
  log = appendEntry(log, { action: 'A', actor: 'w', timestamp: 't1' }, opts);
  log = appendEntry(log, { action: 'B', actor: 'w', timestamp: 't2' }, opts);
  assert.match(log[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(verifyLog(log, opts).valid, true);

  const tampered = log.map((e) => ({ ...e }));
  tampered[0].action = 'C';
  const result = verifyLog(tampered, opts);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 0);
});

test('entryPayload is stable and includes changes', () => {
  const a = { id: 1, action: 'X', timestamp: 't', changes: [{ field: 'f', from: '1', to: '2' }] };
  const b = { ...a };
  assert.equal(entryPayload(a), entryPayload(b));
  const c = { ...a, changes: [{ field: 'f', from: '1', to: '3' }] };
  assert.notEqual(entryPayload(a), entryPayload(c));
});

test('diffValues reports previous -> new values', () => {
  const changes = diffValues({ temperature: '100 F', pulse: '80' }, { temperature: '101 F', pulse: '80' });
  assert.deepEqual(changes, [{ field: 'temperature', from: '100 F', to: '101 F' }]);
});

test('diffValues handles missing keys and nulls', () => {
  const changes = diffValues({ a: 1 }, { b: 2 });
  assert.equal(changes.length, 2);
  const added = changes.find((c) => c.field === 'b');
  assert.equal(added.from, '');
  assert.equal(added.to, '2');
});

test('diffValues returns nothing for identical records', () => {
  assert.deepEqual(diffValues({ a: '1' }, { a: '1' }), []);
  assert.deepEqual(diffValues(null, null), []);
});

test('filterEvents by actor', () => {
  const log = sampleLog();
  const filtered = filterEvents(log, { actor: 'sita' });
  assert.equal(filtered.length, 3);
  assert.equal(filterEvents(log, { actor: 'Dr. A. Sharma' }).length, 1);
});

test('filterEvents by role and level', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, { role: 'doctor' }).length, 1);
  assert.equal(filterEvents(log, { role: 'worker' }).length, 3);
  assert.equal(filterEvents(log, { level: 'warn' }).length, 1);
});

test('filterEvents by patient and case', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, { patientId: 4 }).length, 4);
  assert.equal(filterEvents(log, { patientId: 4, caseId: 9 }).length, 3);
  assert.equal(filterEvents(log, { patientId: 99 }).length, 0);
});

test('filterEvents by action substring and free search', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, { action: 'case_created' }).length, 1);
  assert.equal(filterEvents(log, { search: 'ramesh' }).length, 1);
  assert.equal(filterEvents(log, { search: 'nothing' }).length, 0);
});

test('filterEvents by date range', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, { from: '2026-10-06T10:04:00Z' }).length, 3);
  assert.equal(filterEvents(log, { to: '2026-10-06T10:05:00Z' }).length, 2);
  assert.equal(
    filterEvents(log, { from: '2026-10-06T10:00:00Z', to: '2026-10-06T10:12:00Z' }).length,
    4
  );
});

test('filterEvents combines criteria with AND', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, { actor: 'Sita', action: 'case_created' }).length, 1);
  assert.equal(filterEvents(log, { actor: 'Dr. A. Sharma', action: 'PATIENT_CREATED' }).length, 0);
});

test('filterEvents with no filters returns everything', () => {
  const log = sampleLog();
  assert.equal(filterEvents(log, {}).length, 4);
  assert.equal(filterEvents(log, undefined).length, 4);
});

test('filterFacets lists distinct values for the filter controls', () => {
  const facets = filterFacets(sampleLog());
  assert.deepEqual(facets.actors, ['Dr. A. Sharma', 'Sita Devi']);
  assert.deepEqual(facets.roles, ['doctor', 'worker']);
  assert.deepEqual(facets.levels, ['info', 'warn']);
  assert.deepEqual(facets.patientIds, ['4']);
  assert.ok(facets.actions.includes('FIELD_EDITED'));
});

test('filterFacets tolerates an empty or broken log', () => {
  const facets = filterFacets(null);
  assert.deepEqual(facets.actors, []);
  assert.deepEqual(filterFacets([null, undefined]).levels, []);
});

test('describeEvent reads as who did what to whom when', () => {
  const log = sampleLog();
  const line = describeEvent(log[2]);
  assert.match(line, /Sita Devi/);
  assert.match(line, /worker/);
  assert.match(line, /FIELD_EDITED/);
  assert.match(line, /patient #4/);
  assert.match(line, /2026-10-06T10:10:00Z/);
  assert.equal(describeEvent(null), '');
});

test('the audit entry captures the spec\'s change example verbatim', () => {
  const log = sampleLog();
  const entry = log[2];
  assert.equal(entry.changes[0].field, 'temperature');
  assert.equal(entry.changes[0].from, '100 F');
  assert.equal(entry.changes[0].to, '101 F');
  assert.equal(entry.caseId, 9);
});
