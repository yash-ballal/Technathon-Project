/**
 * Tests for the integration wiring that is easy to leave dangling.
 *
 * These cover the four defects found in the previous audit — a tested module that was
 * never actually called by the app:
 *   - `detectHistoryRewrite` was never wired, so history could be rewritten
 *   - `isUnsupported` was never called, so fabricated claims were not flagged
 *   - audit events were never stamped with patient/case ids or value diffs
 *   - prescriptions could not be attributed to a doctor
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectHistoryRewrite, makeEvent, EVENT_TYPES, buildCaseTimeline } from './clinicalTimeline.js';
import { isUnsupported, normalizeReport, reportFromReview } from './clinicalReview.js';
import { attributeToAuthor, checkAccess, ROLES } from './roles.js';
import { appendEntry, verifyLog, diffValues, filterEvents } from './auditLog.js';

const APP = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Static wiring checks: the app must actually call these, not merely import them.
// ---------------------------------------------------------------------------

test('the app calls detectHistoryRewrite (immutability is enforced, not just available)', () => {
  assert.match(APP, /detectHistoryRewrite\s*\(/, 'detectHistoryRewrite must be called in App.jsx');
  assert.ok(
    !/import\s*\{[^}]*detectHistoryRewrite[^}]*\}\s*from/.test(APP) || /guardTimelineRewrite/.test(APP),
    'detectHistoryRewrite must be used via the rewrite guard'
  );
});

test('the app calls isUnsupported so fabricated claims are surfaced', () => {
  assert.match(APP, /isUnsupported\s*\(/, 'isUnsupported must be called in App.jsx');
});

test('the app stamps patientId and caseId onto audit events', () => {
  assert.match(APP, /patientId:\s*context\?\.patientId/, 'addAuditEvent must stamp patientId');
  assert.match(APP, /caseId:\s*context\?\.caseId/, 'addAuditEvent must stamp caseId');
  // At least a dozen call sites should pass context.
  const contextCalls = APP.match(/addAuditEvent\([^;]*\{\s*patientId/g) || [];
  assert.ok(contextCalls.length >= 8, `expected many call sites to pass context, found ${contextCalls.length}`);
});

test('the app records a previous -> new value diff for field edits', () => {
  assert.match(APP, /\[\{\s*field:\s*before\.field,\s*from:[^}]*to:/s, 'HUMAN_CORRECTION needs a change entry');
  assert.match(APP, /CONFLICT_RESOLVED[\s\S]{0,400}from:\s*rejectedValues/, 'conflict resolution needs a change entry');
});

test('the app records unauthorised access attempts', () => {
  assert.match(APP, /ACCESS_DENIED/, 'denied access must be recorded');
  assert.match(APP, /requireAccess/, 'requireAccess guard must exist');
});

test('the app persists the audit log rather than keeping it in memory only', () => {
  assert.match(APP, /AUDIT_STORAGE_KEY/, 'audit storage key must exist');
  assert.match(APP, /localStorage\.setItem\(AUDIT_STORAGE_KEY/, 'audit log must be written to storage');
  assert.match(APP, /localStorage\.getItem\(AUDIT_STORAGE_KEY/, 'audit log must be restored on load');
});

test('the app records the timeline events the spec names in its example', () => {
  ['VOICE_CAPTURED', 'CONFLICT_DETECTED', 'HUMAN_CORRECTION', 'REPORT_APPROVED', 'IMAGE_CAPTURED',
   'TEXT_CAPTURED', 'AI_EXTRACTION_COMPLETED', 'CONFLICT_RESOLVED', 'PRESCRIPTION_CREATED',
   'DOCTOR_SUGGESTION', 'CASE_SUBMITTED', 'SYNCHRONISED', 'CLARIFICATION_RAISED'].forEach((type) => {
    assert.match(APP, new RegExp(`EVENT_TYPES\\.${type}`), `${type} must be recorded`);
  });
});

test('the app gates patient records, case creation and registration by role', () => {
  assert.match(APP, /requireAccess\('view_patients'/, 'patient profile must be role-gated');
  assert.match(APP, /requireAccess\('create_case'/, 'case creation must be role-gated');
  assert.match(APP, /requireAccess\('create_patient'/, 'registration must be role-gated');
});

test('the app displays the original source alongside structured output', () => {
  assert.match(APP, /Original Source/, 'a source panel must exist');
  assert.match(APP, /captureTextSource/, 'the source panel must be fed real source text');
});

test('the app offers an AI retry action and a local-save fallback', () => {
  assert.match(APP, /Retry AI processing/, 'AI failure must offer a retry');
  assert.match(APP, /aiError/, 'AI errors must be held in state to render a recovery panel');
});

test('the app names the empty states the spec asks for', () => {
  assert.match(APP, /No previous cases/, 'previous-cases empty state');
  assert.match(APP, /No pending reviews/, 'pending-reviews empty state');
  assert.match(APP, /No audit events found/, 'audit filter empty state');
});

test('the app can author a doctor prescription with a full record', () => {
  assert.match(APP, /attributeToAuthor\(/, 'prescriptions must go through attribution');
  assert.match(APP, /prescribed_at/, 'prescriptions need a date');
  assert.match(APP, /generated_by_ai/, 'prescriptions must record that they are not AI-generated');
  assert.match(APP, /history:\s*\[\{/, 'prescriptions need a change history');
});

// ---------------------------------------------------------------------------
// Behavioural checks on the pieces those call sites depend on.
// ---------------------------------------------------------------------------

test('history rewriting is blocked while appending is allowed', () => {
  const original = [makeEvent(EVENT_TYPES.HUMAN_CORRECTION, { actor: 'Sita', timestamp: 't1', details: '100 F -> 101 F' })];

  const appended = [...original, makeEvent(EVENT_TYPES.SYNCHRONISED, { timestamp: 't2' })];
  assert.equal(detectHistoryRewrite(original, appended).tampered, false);

  const edited = [{ ...original[0], details: '100 F -> 99 F' }];
  assert.equal(detectHistoryRewrite(original, edited).tampered, true);

  const deleted = [];
  assert.equal(detectHistoryRewrite(original, deleted).tampered, true);
});

test('a fabricated claim is detectable so the banner can render', () => {
  const report = normalizeReport({
    facts: [
      { field: 'temperature', value: '101 F', status: 'confirmed', evidence: [{ kind: 'text_span', quote: 'fever' }] },
      { field: 'xray', value: 'fracture', status: 'confirmed', evidence: [{ kind: 'text_span', quote: 'nope', label: 'unverified quote' }] },
    ],
  });
  const flagged = report.facts.filter((fact) => isUnsupported(fact));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].field, 'xray');
});

test('a denied permission produces an actionable reason for the audit entry', () => {
  // Every valid role may view patients (a deliberate PHC policy choice), so the
  // patient-profile gate denies an unknown role rather than a legitimate one.
  [ROLES.FIELD_WORKER, ROLES.DOCTOR, ROLES.ADMIN].forEach((role) => {
    assert.equal(checkAccess(role, 'view_patients').allowed, true, `${role} should see patients`);
  });
  const unknown = checkAccess('unknown_role', 'view_patients');
  assert.equal(unknown.allowed, false);
  assert.ok(unknown.reason.length > 0);

  // The real denial paths: an admin is not a clinician, so cannot document a case or
  // author a prescription; a field worker cannot author one either.
  assert.equal(checkAccess(ROLES.ADMIN, 'create_case').allowed, false);
  assert.equal(checkAccess(ROLES.ADMIN, 'create_prescription').allowed, false);
  assert.equal(checkAccess(ROLES.FIELD_WORKER, 'create_prescription').allowed, false);
  assert.equal(checkAccess(ROLES.DOCTOR, 'create_case').allowed, true);
});

test('a doctor-authored prescription carries identity, case, date and history', () => {
  const result = attributeToAuthor(ROLES.DOCTOR, 'Dr. A. Sharma', {
    drug: 'Amoxicillin 500mg',
    dose: 'BD x 7 days',
    prescribed_at: '2026-10-06T10:20:00Z',
    patient_id: 1,
    status: 'active',
    history: [{ at: '2026-10-06T10:20:00Z', by: 'Dr. A. Sharma', change: 'created' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.author, 'Dr. A. Sharma');
  assert.equal(result.record.author_role, 'doctor');
  assert.equal(result.record.prescribed_at, '2026-10-06T10:20:00Z');
  assert.equal(result.record.patient_id, 1);
  assert.equal(result.record.status, 'active');
  assert.equal(result.record.history.length, 1);
  assert.equal(result.record.generated_by_ai, false);
});

test('an anonymous or non-doctor prescription is refused', () => {
  assert.equal(attributeToAuthor(ROLES.FIELD_WORKER, 'Sita Devi', { drug: 'X' }).ok, false);
  assert.equal(attributeToAuthor(ROLES.DOCTOR, '   ', { drug: 'X' }).ok, false);
});

test('an audit entry with ids and a diff survives the integrity check and is filterable', () => {
  let log = [];
  log = appendEntry(log, {
    timestamp: '2026-10-06T10:10:00Z',
    actor: 'Sita Devi',
    role: 'field_worker',
    action: 'HUMAN_CORRECTION',
    details: 'temperature',
    level: 'warn',
    patientId: 1,
    caseId: 9,
    changes: [{ field: 'temperature', from: '100 F', to: '101 F' }],
  });

  assert.equal(verifyLog(log).valid, true);

  // The spec's worked example must be reconstructable from the stored entry.
  const entry = log[0];
  assert.equal(entry.patientId, 1);
  assert.equal(entry.caseId, 9);
  assert.deepEqual(entry.changes, [{ field: 'temperature', from: '100 F', to: '101 F' }]);

  // And the filters must be able to find it by patient and by case.
  assert.equal(filterEvents(log, { patientId: 1 }).length, 1);
  assert.equal(filterEvents(log, { caseId: 9 }).length, 1);
  assert.equal(filterEvents(log, { patientId: 2 }).length, 0);
});

test('diffValues produces the change entries the correction handler records', () => {
  const changes = diffValues({ temperature: '100 F', pulse: '80' }, { temperature: '101 F', pulse: '80' });
  assert.deepEqual(changes, [{ field: 'temperature', from: '100 F', to: '101 F' }]);
});

test('a signed case timeline contains the spec\'s example sequence', () => {
  const timeline = buildCaseTimeline({
    patient: { id: 1, name: 'Ramesh Sharma', created_at: '2026-10-06T09:00:00Z', created_by: 'Sita Devi' },
    caseRecord: { id: 9, patient_id: 1, created_at: '2026-10-06T09:05:00Z', created_by: 'Sita Devi' },
    groups: [[
      makeEvent(EVENT_TYPES.VOICE_CAPTURED, { actor: 'Sita Devi', timestamp: '2026-10-06T10:05:00Z' }),
      makeEvent(EVENT_TYPES.AI_EXTRACTION_COMPLETED, { actor: 'AI', timestamp: '2026-10-06T10:06:00Z' }),
      makeEvent(EVENT_TYPES.CONFLICT_DETECTED, { actor: 'System', timestamp: '2026-10-06T10:08:00Z' }),
      makeEvent(EVENT_TYPES.HUMAN_CORRECTION, { actor: 'Sita Devi', timestamp: '2026-10-06T10:10:00Z' }),
      makeEvent(EVENT_TYPES.REPORT_APPROVED, { actor: 'Sita Devi', timestamp: '2026-10-06T10:12:00Z' }),
    ]],
  });

  assert.deepEqual(timeline.map((e) => e.type), [
    'patient_registered', 'case_created', 'voice_captured', 'ai_extraction_completed',
    'conflict_detected', 'human_correction', 'report_approved',
  ]);
});

test('reportFromReview keeps human corrections in the signed report with their history', () => {
  const model = normalizeReport({
    facts: [{
      field: 'temperature', value: '101 F', status: 'human_corrected', source: 'worker',
      original_value: '100 F', evidence: [],
      corrections: [{ from: '100 F', to: '101 F', actor: 'Sita', timestamp: 't' }],
    }],
    conflicts: [],
  });
  const report = reportFromReview(model);
  const fact = report.confirmed[0];
  assert.equal(fact.value, '101 F');
  assert.equal(fact.original_value, '100 F');
  assert.equal(fact.corrections.length, 1);
});
