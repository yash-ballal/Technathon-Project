/**
 * Tests for the case timeline and provenance model.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TYPES,
  makeEvent,
  appendEvent,
  sortTimeline,
  formatEventTime,
  describeEvent,
  eventLabel,
  buildCaseTimeline,
  detectHistoryRewrite,
  provenanceLabel,
  provenanceSummary,
  attentionItems,
  timelineEmptyMessage,
  PROVENANCE,
} from './clinicalTimeline.js';

test('the spec\'s timeline event types all have readable labels', () => {
  Object.values(EVENT_TYPES).forEach((type) => {
    const label = eventLabel(type);
    assert.ok(label.length > 0);
    assert.ok(!label.includes('_'), `${type} should have a human label`);
  });
  assert.equal(eventLabel(EVENT_TYPES.VOICE_CAPTURED), 'Voice note captured');
  assert.equal(eventLabel(EVENT_TYPES.CONFLICT_DETECTED), 'Conflict detected');
  assert.equal(eventLabel(EVENT_TYPES.REPORT_APPROVED), 'Report approved');
});

test('an unknown event type still gets a readable label', () => {
  assert.equal(eventLabel('some_new_event'), 'some new event');
  assert.equal(eventLabel(undefined), 'Event');
});

test('makeEvent fills defaults and copies data', () => {
  const event = makeEvent(EVENT_TYPES.VOICE_CAPTURED, { timestamp: 't', actor: 'Sita', data: { seconds: 12 } });
  assert.equal(event.type, 'voice_captured');
  assert.equal(event.label, 'Voice note captured');
  assert.equal(event.actor, 'Sita');
  assert.deepEqual(event.data, { seconds: 12 });
});

test('unattributed clinical actions are refused', () => {
  // These events must be attributable, or the record is not auditable.
  assert.throws(() => makeEvent(EVENT_TYPES.REPORT_APPROVED, { timestamp: 't' }), /requires an actor/);
  assert.throws(() => makeEvent(EVENT_TYPES.REPORT_APPROVED, { actor: 'Dr. A' }), /requires a timestamp/);
  assert.throws(() => makeEvent(EVENT_TYPES.HUMAN_CORRECTION, {}), /requires an actor/);
  assert.throws(() => makeEvent(EVENT_TYPES.CONFLICT_RESOLVED, {}), /requires an actor/);
  assert.throws(() => makeEvent(''), /Event type is required/);
});

test('non-clinical events do not demand an actor', () => {
  const event = makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't' });
  assert.equal(event.actor, 'System');
});

test('appendEvent returns a new array and never mutates history', () => {
  const first = appendEvent([], makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: 't1' }));
  const second = appendEvent(first, makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't2' }));
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  assert.equal(first[0].type, 'text_captured');
});

test('appendEvent ignores a malformed event', () => {
  const existing = [makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: 't' })];
  assert.equal(appendEvent(existing, null).length, 1);
  assert.equal(appendEvent(existing, {}).length, 1);
  assert.equal(appendEvent(null, makeEvent(EVENT_TYPES.TEXT_CAPTURED, {})).length, 1);
});

test('sortTimeline orders oldest first', () => {
  const late = makeEvent(EVENT_TYPES.REPORT_APPROVED, { actor: 'Dr', timestamp: '2026-10-06T10:12:00Z' });
  const early = makeEvent(EVENT_TYPES.VOICE_CAPTURED, { actor: 'Sita', timestamp: '2026-10-06T10:05:00Z' });
  const middle = makeEvent(EVENT_TYPES.AI_EXTRACTION_COMPLETED, { actor: 'AI', timestamp: '2026-10-06T10:06:00Z' });

  const sorted = sortTimeline([late, early, middle]);
  assert.deepEqual(sorted.map((e) => e.type), ['voice_captured', 'ai_extraction_completed', 'report_approved']);
});

test('sortTimeline leaves unstamped events at the end without losing them', () => {
  const stamped = makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: '2026-10-06T10:00:00Z' });
  const unstamped = makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: '' });
  const sorted = sortTimeline([unstamped, stamped]);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].type, 'text_captured');
});

test('sortTimeline tolerates null input and null entries', () => {
  assert.deepEqual(sortTimeline(null), []);
  assert.equal(sortTimeline([null, undefined]).length, 0);
});

test('formatEventTime renders a clock time and passes through bad values', () => {
  assert.match(formatEventTime('2026-10-06T10:05:00Z'), /^\d{2}:\d{2}$/);
  assert.equal(formatEventTime(''), '');
  assert.equal(formatEventTime('not a date'), 'not a date');
});

test('describeEvent reads like the spec\'s example lines', () => {
  const voice = makeEvent(EVENT_TYPES.VOICE_CAPTURED, { actor: 'Sita Devi', timestamp: '2026-10-06T10:05:00Z' });
  const line = describeEvent(voice);
  assert.match(line, /^\d{2}:\d{2} — Voice note captured \(Sita Devi\)$/);

  const conflict = makeEvent(EVENT_TYPES.CONFLICT_DETECTED, { actor: 'System', timestamp: '2026-10-06T10:08:00Z', details: 'temperature' });
  const conflictLine = describeEvent(conflict);
  assert.match(conflictLine, /Conflict detected/);
  assert.match(conflictLine, /temperature/);
  // System actor is not printed, to reduce noise.
  assert.ok(!conflictLine.includes('(System)'));

  assert.equal(describeEvent(null), '');
});

test('buildCaseTimeline assembles registration, case creation and grouped events in order', () => {
  const patient = { id: 4, name: 'Ramesh Sharma', created_at: '2026-10-06T09:00:00Z', created_by: 'Sita Devi' };
  const caseRecord = { id: 9, patient_id: 4, created_at: '2026-10-06T09:05:00Z', created_by: 'Sita Devi' };

  const timeline = buildCaseTimeline({
    patient,
    caseRecord,
    groups: [
      [
        makeEvent(EVENT_TYPES.VOICE_CAPTURED, { actor: 'Sita Devi', timestamp: '2026-10-06T10:05:00Z' }),
        makeEvent(EVENT_TYPES.AI_EXTRACTION_COMPLETED, { actor: 'AI', timestamp: '2026-10-06T10:06:00Z' }),
      ],
      [
        makeEvent(EVENT_TYPES.CONFLICT_DETECTED, { actor: 'System', timestamp: '2026-10-06T10:08:00Z' }),
        makeEvent(EVENT_TYPES.HUMAN_CORRECTION, { actor: 'Sita Devi', timestamp: '2026-10-06T10:10:00Z' }),
        makeEvent(EVENT_TYPES.REPORT_APPROVED, { actor: 'Sita Devi', timestamp: '2026-10-06T10:12:00Z' }),
      ],
    ],
  });

  assert.deepEqual(
    timeline.map((e) => e.type),
    [
      'patient_registered',
      'case_created',
      'voice_captured',
      'ai_extraction_completed',
      'conflict_detected',
      'human_correction',
      'report_approved',
    ]
  );
});

test('buildCaseTimeline works with nothing but extra events', () => {
  const timeline = buildCaseTimeline({ extra: [makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't' })] });
  assert.equal(timeline.length, 1);
});

test('detectHistoryRewrite accepts a pure append', () => {
  const original = [makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: 't1' })];
  const appended = appendEvent(original, makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't2' }));
  const result = detectHistoryRewrite(original, appended);
  assert.equal(result.tampered, false);
});

test('detectHistoryRewrite catches an edited event', () => {
  const original = [
    makeEvent(EVENT_TYPES.HUMAN_CORRECTION, { actor: 'Sita', timestamp: 't1', details: '100 F -> 101 F' }),
  ];
  const edited = [{ ...original[0], details: '100 F -> 99 F' }];
  const result = detectHistoryRewrite(original, edited);
  assert.equal(result.tampered, true);
  assert.deepEqual(result.indices, [0]);
  assert.match(result.reason, /modified/);
});

test('detectHistoryRewrite catches event deletion', () => {
  const original = [
    makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: 't1' }),
    makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't2' }),
  ];
  const result = detectHistoryRewrite(original, [original[0]]);
  assert.equal(result.tampered, true);
  assert.match(result.reason, /lose 1 historical event/);
});

test('detectHistoryRewrite catches a swapped actor', () => {
  const original = [makeEvent(EVENT_TYPES.CONFLICT_RESOLVED, { actor: 'Sita', timestamp: 't1' })];
  const result = detectHistoryRewrite(original, [{ ...original[0], actor: 'Someone Else' }]);
  assert.equal(result.tampered, true);
});

test('detectHistoryRewrite reports no tampering for an unchanged timeline', () => {
  const original = [makeEvent(EVENT_TYPES.TEXT_CAPTURED, { timestamp: 't1' })];
  const result = detectHistoryRewrite(original, original.map((e) => ({ ...e })));
  assert.equal(result.tampered, false);
});

test('provenance labels distinguish worker, AI, human and doctor', () => {
  assert.equal(provenanceLabel(PROVENANCE.WORKER), 'Entered by worker');
  assert.equal(provenanceLabel(PROVENANCE.AI), 'Extracted by AI');
  assert.equal(provenanceLabel(PROVENANCE.HUMAN), 'Corrected by human');
  assert.equal(provenanceLabel(PROVENANCE.DOCTOR), 'Added by doctor');
  assert.equal(provenanceLabel('nonsense'), 'Source unknown');
});

test('provenanceSummary counts each origin', () => {
  const summary = provenanceSummary([
    { source: 'ai' },
    { source: 'ai' },
    { source: 'worker' },
    { provenance: 'human' },
    { provenance: 'doctor' },
  ]);
  assert.deepEqual(summary, { worker: 1, ai: 2, human: 1, doctor: 1 });
  assert.deepEqual(provenanceSummary(null), { worker: 0, ai: 0, human: 0, doctor: 0 });
});

test('attentionItems surfaces follow-ups, conflicts, QA blocks and unsynced cases', () => {
  const items = attentionItems({
    cases: [{ id: 1, pendingSync: true }],
    conflicts: [{ field: 'temperature', requires_resolution: true }],
    followUps: ['Review after 3 days'],
    qaStatus: 'blocked',
  });
  const kinds = items.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['conflict', 'follow_up', 'qa', 'sync']);
  const conflict = items.find((i) => i.kind === 'conflict');
  assert.equal(conflict.detail, 'temperature');
});

test('attentionItems ignores resolved conflicts and shows nothing when clear', () => {
  const items = attentionItems({ conflicts: [{ field: 'x', requires_resolution: false }] });
  assert.deepEqual(items, []);
  assert.deepEqual(attentionItems({}), []);
});

test('timelineEmptyMessage explains the empty state', () => {
  assert.match(timelineEmptyMessage([]), /No events recorded/);
  assert.equal(timelineEmptyMessage([makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't' })]), '');
});
