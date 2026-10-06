/**
 * Tests for the AI review/edit screen model.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeReport,
  applyCorrection,
  rejectFact,
  resolveConflict,
  unresolvedConflicts,
  pendingReviewItems,
  statusCounts,
  statusMeta,
  evidenceText,
  isUnsupported,
  ALL_FACT_STATUSES,
} from './clinicalReview.js';

const contractReport = {
  summary: 'Fever for 3 days.',
  facts: [
    {
      field: 'temperature',
      value: '101 F',
      status: 'confirmed',
      source: 'voice',
      evidence: [{ kind: 'audio_timestamp', timestamp: 12.5, quote: 'bukhar' }],
    },
    { field: 'pulse', value: '82', status: 'uncertain', evidence: [] },
    {
      field: 'blood_pressure',
      value: '120/80',
      status: 'confirmed',
      evidence: [{ kind: 'text_span', quote: 'not in the source', label: 'unverified quote' }],
    },
  ],
  conflicts: [
    {
      field: 'temperature',
      reason: 'Sources disagree',
      requires_resolution: true,
      options: [
        { value: '100 F', sources: ['voice'] },
        { value: '101 F', sources: ['image'] },
      ],
    },
  ],
  clarification_questions: [{ field: 'drug_allergies', question: 'Any allergies?' }],
  missing: [{ field: 'drug_allergies', importance: 'high' }],
  follow_ups: ['Review in 3 days'],
  sources: [{ kind: 'voice', ref: 'audio-1' }],
};

test('normalizeReport reads the new contract shape', () => {
  const report = normalizeReport(contractReport);
  assert.equal(report.facts.length, 3);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.followUps.length, 1);
  assert.equal(report.sources.length, 1);
});

test('normalizeReport also accepts the legacy payload shape', () => {
  const legacy = {
    summary: 'Fever',
    confirmed: [{ field: 'temperature', value: '101 F', source_quote: 'fever 101' }],
    uncertain: [{ field: 'pulse', value: '82' }],
    missing: [{ field: 'blood_pressure', importance: 'medium' }],
    follow_ups: ['Review'],
  };
  const report = normalizeReport(legacy);
  const statuses = report.facts.map((f) => f.status).sort();
  assert.deepEqual(statuses, ['confirmed', 'uncertain']);
  // Legacy source_quote becomes viewable evidence.
  assert.equal(report.facts.find((f) => f.field === 'temperature').evidence[0].quote, 'fever 101');
});

test('normalizeReport tolerates null/garbage input', () => {
  [null, undefined, 42, 'text', {}, { facts: 'nope' }].forEach((input) => {
    const report = normalizeReport(input);
    assert.deepEqual(report.facts, []);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.clarificationQuestions, []);
    assert.equal(report.summary, '');
  });
});

test('unknown fact statuses fall back to a known status rather than rendering blank', () => {
  const report = normalizeReport({ facts: [{ field: 'x', value: 'y', status: 'made_up' }] });
  assert.ok(ALL_FACT_STATUSES.includes(report.facts[0].status));
});

test('every status has display metadata with a label and tone', () => {
  ALL_FACT_STATUSES.forEach((status) => {
    const meta = statusMeta(status);
    assert.equal(meta.key, status);
    assert.ok(meta.label.length > 0);
    assert.ok(meta.tone.length > 0);
  });
  assert.equal(statusMeta('nonsense').key, 'uncertain');
});

test('evidenceText describes each evidence kind', () => {
  assert.match(evidenceText({ kind: 'audio_timestamp', timestamp: 12.5 }), /12\.5s/);
  assert.match(evidenceText({ kind: 'image_region', region: [10, 20, 30, 40] }), /10, 20, 30, 40/);
  assert.match(evidenceText({ kind: 'worker_note', ref: 'worker' }), /Reviewer note/);
  assert.match(evidenceText({ kind: 'text_span', quote: 'fever' }), /fever/);
  assert.match(evidenceText({ kind: 'text_span', quote: 'x', label: 'unverified quote' }), /Unverified/);
  assert.equal(evidenceText(null), '');
});

test('isUnsupported flags a claim whose evidence was not found in the source', () => {
  const unsupported = { evidence: [{ kind: 'text_span', quote: 'x', label: 'unverified quote' }] };
  const supported = { evidence: [{ kind: 'text_span', quote: 'x' }] };
  assert.equal(isUnsupported(unsupported), true);
  assert.equal(isUnsupported(supported), false);
  assert.equal(isUnsupported({ evidence: [] }), false);
  assert.equal(isUnsupported({}), false);
});

test('applyCorrection preserves the original AI value', () => {
  const facts = normalizeReport(contractReport).facts;
  const updated = applyCorrection(facts, 0, '102 F', { timestamp: 't1' });

  assert.equal(updated[0].value, '102 F');
  assert.equal(updated[0].status, 'human_corrected');
  assert.equal(updated[0].source, 'worker');
  assert.equal(updated[0].original_value, '101 F');
  assert.equal(updated[0].corrections.length, 1);
  // Other facts are untouched.
  assert.equal(updated[1].value, '82');
});

test('applyCorrection keeps the first AI value across repeated edits', () => {
  let facts = normalizeReport(contractReport).facts;
  facts = applyCorrection(facts, 0, '102 F', { timestamp: 't1' });
  facts = applyCorrection(facts, 0, '103 F', { timestamp: 't2' });

  assert.equal(facts[0].value, '103 F');
  assert.equal(facts[0].original_value, '101 F');
  assert.deepEqual(facts[0].corrections.map((c) => c.to), ['102 F', '103 F']);
  assert.equal(facts[0].corrections[0].from, '101 F');
});

test('applyCorrection records who changed what and when', () => {
  const facts = normalizeReport(contractReport).facts;
  const updated = applyCorrection(facts, 1, '84', { actor: 'Sita Devi', timestamp: '2026-10-06T10:10:00Z' });
  const correction = updated[1].corrections[0];
  assert.equal(correction.actor, 'Sita Devi');
  assert.equal(correction.timestamp, '2026-10-06T10:10:00Z');
  assert.equal(correction.from, '82');
  assert.equal(correction.to, '84');
});

test('applyCorrection ignores a no-op edit', () => {
  const facts = normalizeReport(contractReport).facts;
  const updated = applyCorrection(facts, 0, '101 F');
  assert.equal(updated[0].status, 'confirmed');
  assert.deepEqual(updated[0].corrections, []);
});

test('applyCorrection tolerates bad indices', () => {
  const facts = normalizeReport(contractReport).facts;
  assert.equal(applyCorrection(facts, -1, 'x'), facts);
  assert.equal(applyCorrection(facts, 99, 'x'), facts);
  assert.deepEqual(applyCorrection(null, 0, 'x'), []);
});

test('rejectFact removes the value but keeps the AI output in history', () => {
  const facts = normalizeReport(contractReport).facts;
  const updated = rejectFact(facts, 2, { actor: 'Worker', timestamp: 't1', reason: 'Not on the note' });

  assert.equal(updated[2].value, '');
  assert.equal(updated[2].rejected, true);
  assert.equal(updated[2].original_value, '120/80');
  assert.equal(updated[2].corrections[0].to, null);
  assert.equal(updated[2].corrections[0].reason, 'Not on the note');
});

test('resolveConflict records the reviewer choice without auto-picking', () => {
  const report = normalizeReport(contractReport);
  assert.equal(unresolvedConflicts(report).length, 1);

  const resolved = resolveConflict(report.conflicts, 'temperature', '100 F', { actor: 'Worker', timestamp: 't1' });
  assert.equal(resolved[0].requires_resolution, false);
  assert.equal(resolved[0].resolution.value, '100 F');
  assert.equal(resolved[0].resolution.actor, 'Worker');
  // Both original options are retained.
  assert.equal(resolved[0].resolution.options.length, 2);
  assert.equal(resolved[0].options.length, 2);
});

test('resolving one conflict leaves others untouched', () => {
  const conflicts = [
    { field: 'temperature', requires_resolution: true, options: [] },
    { field: 'pulse', requires_resolution: true, options: [] },
  ];
  const resolved = resolveConflict(conflicts, 'temperature', '100 F');
  assert.equal(resolved[0].requires_resolution, false);
  assert.equal(resolved[1].requires_resolution, true);
});

test('pendingReviewItems surfaces conflicts, uncertainty and unsupported claims', () => {
  const report = normalizeReport(contractReport);
  const pending = pendingReviewItems(report);
  const kinds = pending.map((p) => p.kind);

  assert.ok(kinds.includes('conflict'));
  assert.ok(kinds.includes('uncertain'));
  assert.ok(kinds.includes('unsupported'));
});

test('pendingReviewItems is empty for a fully clean report', () => {
  const clean = normalizeReport({
    facts: [{ field: 'temperature', value: '101 F', status: 'confirmed', evidence: [{ kind: 'text_span', quote: 'fever' }] }],
    conflicts: [],
  });
  assert.deepEqual(pendingReviewItems(clean), []);
});

test('pendingReviewItems drops a conflict once it is resolved', () => {
  const report = normalizeReport(contractReport);
  report.conflicts = resolveConflict(report.conflicts, 'temperature', '100 F');
  const kinds = pendingReviewItems(report).map((p) => p.kind);
  assert.ok(!kinds.includes('conflict'));
});

test('statusCounts tallies each status', () => {
  const report = normalizeReport(contractReport);
  const counts = statusCounts(report.facts);
  assert.equal(counts.confirmed, 2);
  assert.equal(counts.uncertain, 1);
  assert.equal(counts.conflict, 0);
  assert.deepEqual(statusCounts(null), { confirmed: 0, uncertain: 0, missing: 0, conflict: 0, human_corrected: 0 });
});
