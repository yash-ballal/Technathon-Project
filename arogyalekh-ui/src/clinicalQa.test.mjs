/**
 * Tests for the Clinical Workflow QA rule engine.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runClinicalQa,
  formatMissingItem,
  formatFactValue,
  qaAuditSnapshot,
  QA_LEVEL,
} from './clinicalQa.js';

const patient = { id: 1, name: 'Ramesh Sharma', age: 45, gender: 'Male' };

function baseReport(overrides = {}) {
  return {
    summary: 'Patient presented with acute fever for 3 days.',
    confirmed: [{ field: 'diagnosis', value: 'Viral Pyrexia', source_quote: 'fever 3 days' }],
    uncertain: [],
    missing: [],
    follow_ups: ['Review after 3 days'],
    ...overrides,
  };
}

test('formatMissingItem renders backend objects and plain strings', () => {
  assert.equal(formatMissingItem('blood_pressure'), 'blood_pressure');
  assert.equal(
    formatMissingItem({ field: 'blood_pressure', importance: 'medium', reason: 'Not recorded' }),
    'blood_pressure: medium — Not recorded'
  );
  assert.equal(formatMissingItem({ field: 'pulse' }), 'pulse');
  assert.equal(formatMissingItem(null), '');
  assert.ok(!formatMissingItem({ field: 'pulse', importance: 'high' }).includes('[object Object]'));
});

test('formatFactValue unwraps fact objects and stringifies nested ones', () => {
  assert.equal(formatFactValue('fever'), 'fever');
  assert.equal(formatFactValue(101.2), '101.2');
  // A fact object carries its payload in `value`; the field name is not part of the value.
  assert.equal(formatFactValue({ field: 'medication', value: 'Paracetamol' }), 'Paracetamol');
  assert.equal(formatFactValue({ field: 'pulse' }), 'pulse');
  assert.equal(formatFactValue(['a', 'b']), 'a, b');
  assert.match(formatFactValue({ nested: true }), /nested/);
});

test('clean encounter reports status clear', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport(),
    diagnosis: 'Acute Viral Pharyngitis',
    prescriptions: [{ drug: 'Paracetamol 650mg', dose: 'TDS x 5 days', route: 'Oral' }],
    notes: 'Advised rest and fluids.',
    priority: 'Routine',
  });
  assert.equal(qa.status, 'clear');
  assert.deepEqual(qa.blockingMessages, []);
  assert.deepEqual(qa.warningMessages, []);
});

test('patient identity mismatch on the document blocks signing', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({
      confirmed: [{ field: 'patient_name', value: 'Sunita Devi', source_quote: 'Sunita' }],
    }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.equal(qa.blocking[0].id, 'patient_identity');
  assert.match(qa.blockingMessages[0], /Sunita Devi/);
});

test('backend "Patient Identity Mismatch" flag blocks signing', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({
      missing: [
        {
          field: 'Patient Identity Mismatch',
          importance: 'high',
          reason: 'The name on the document does not match the active patient record.',
        },
      ],
    }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.equal(qa.blocking[0].id, 'patient_identity_document');
});

test('missing high-importance data blocks, medium warns, low informs', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({
      missing: [
        { field: 'drug_allergy', importance: 'high', reason: 'Allergy status unknown' },
        { field: 'blood_pressure', importance: 'medium', reason: 'Not documented' },
        { field: 'occupation', importance: 'low', reason: 'Optional social history' },
      ],
    }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.equal(qa.blocking.length, 1);
  assert.equal(qa.warnings.length, 1);
  assert.equal(qa.infos.length, 1);
});

test('unmeasured critical vitals warn without blocking', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({ missing: [{ field: 'temperature', importance: 'low', reason: 'Not measured' }] }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'review');
  assert.match(qa.warningMessages[0], /temperature/i);
});

test('documented allergy conflicts with a matching prescription', () => {
  const qa = runClinicalQa({
    patient: { ...patient, allergies: 'Penicillin' },
    report: baseReport(),
    diagnosis: 'Lower respiratory tract infection',
    prescriptions: [{ drug: 'Amoxicillin 500mg', dose: 'BD x 7 days', route: 'Oral' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.equal(qa.blocking[0].id, 'allergy_conflict');
  assert.match(qa.blockingMessages[0], /Amoxicillin 500mg/i);
});

test('allergy conflict also detected against a medication listed in the report', () => {
  const qa = runClinicalQa({
    patient: { ...patient, allergies: 'Sulfa drugs' },
    report: baseReport({
      confirmed: [
        { field: 'diagnosis', value: 'Viral Pyrexia', source_quote: 'fever' },
        { field: 'medication', value: 'Cotrimoxazole 480mg BD', source_quote: 'cotrimoxazole' },
      ],
    }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.match(qa.blockingMessages[0], /cotrimoxazole/i);
});

test('"no known allergy" placeholders never raise conflicts', () => {
  const qa = runClinicalQa({
    patient: { ...patient, allergies: 'None' },
    report: baseReport(),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Amoxicillin 500mg', dose: 'BD x 7 days' }],
    notes: 'ok',
  });
  assert.equal(qa.blockingMessages.length, 0);
});

test('dose anomalies, missing fields and unstated frequency are flagged', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport(),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [
      { drug: 'Paracetamol', dose: 'TDS x 5 days' }, // no numeric quantity
      { drug: 'Amoxicillin', dose: '5000mg BD' }, // implausible per-dose quantity
      { drug: 'Metformin', dose: '500mg' }, // no frequency
      { drug: '', dose: 'BD' }, // unnamed
    ],
    notes: 'ok',
  });
  const ids = qa.warnings.map((w) => w.id);
  assert.ok(ids.includes('dose_unquantified_0'));
  assert.ok(ids.includes('dose_high_1'));
  assert.ok(ids.includes('frequency_unstated_2'));
  assert.ok(ids.includes('prescription_unnamed_3'));
  assert.equal(qa.status, 'review');
});

test('encounter without any prescription warns instead of blocking', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport(),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [],
    notes: 'Advised rest.',
  });
  assert.equal(qa.status, 'review');
  assert.equal(qa.warnings[0].id, 'prescription_absent');
});

test('absent diagnosis and summary blocks signing', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({ summary: '' }),
    diagnosis: '',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  assert.equal(qa.status, 'blocked');
  assert.equal(qa.blocking[0].id, 'diagnosis_absent');
});

test('urgent priority without notes warns; uncertainty and follow-ups are surfaced', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({
      uncertain: [{ field: 'drug_allergies', value: 'illegible', source_quote: '??' }],
      follow_ups: [],
    }),
    diagnosis: 'Chest pain',
    prescriptions: [{ drug: 'Aspirin 300mg', dose: 'STAT' }],
    notes: '',
    priority: 'Urgent',
  });
  const ids = qa.checks.map((c) => c.id);
  assert.ok(ids.includes('urgent_without_notes'));
  assert.ok(ids.includes('uncertain_0'));
  assert.ok(ids.includes('follow_up_absent'));
  assert.equal(qa.status, 'review');
});

test('tolerates a null/empty input without throwing', () => {
  const qa = runClinicalQa();
  assert.equal(qa.status, 'blocked');
  assert.ok(Array.isArray(qa.checks));
  assert.ok(qa.checkedAt);
});

test('qaAuditSnapshot produces a persistable summary', () => {
  const qa = runClinicalQa({
    patient,
    report: baseReport({ missing: [{ field: 'blood_pressure', importance: 'medium', reason: 'Not documented' }] }),
    diagnosis: 'Viral Pyrexia',
    prescriptions: [{ drug: 'Paracetamol 500mg', dose: 'TDS' }],
    notes: 'ok',
  });
  const snapshot = qaAuditSnapshot(qa);
  assert.equal(snapshot.status, 'review');
  assert.equal(snapshot.warnings.length, 1);
  assert.equal(snapshot.blocking.length, 0);
  assert.ok(snapshot.checked_at);
  assert.equal(qaAuditSnapshot(null), null);
});

test('every finding carries a message and a known level', () => {
  const levels = new Set(Object.values(QA_LEVEL));
  const qa = runClinicalQa({
    patient,
    report: baseReport({ uncertain: [{ field: 'x', value: 'y' }] }),
    diagnosis: '',
    prescriptions: [],
  });
  assert.ok(qa.checks.length > 0);
  qa.checks.forEach((check) => {
    assert.ok(typeof check.message === 'string' && check.message.length > 0);
    assert.ok(levels.has(check.level));
    assert.ok(typeof check.id === 'string' && check.id.length > 0);
  });
});
