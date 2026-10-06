/**
 * Tests for roles and permissions.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES,
  ALL_ROLES,
  can,
  checkAccess,
  permissionsFor,
  roleLabel,
  isValidRole,
  allPermissions,
  canViewPatientRecords,
  canPrescribe,
  canAuthorPrescription,
  canViewAuditLog,
  canManageTeam,
  attributeToAuthor,
  requiresDoctorReview,
  doctorSuggestionState,
} from './roles.js';

test('all three roles exist with labels', () => {
  assert.deepEqual(ALL_ROLES.sort(), ['admin', 'doctor', 'field_worker']);
  ALL_ROLES.forEach((role) => {
    assert.ok(roleLabel(role).length > 0);
    assert.equal(isValidRole(role), true);
  });
  assert.equal(roleLabel('nonsense'), 'Unknown role');
});

test('an unknown role has no permissions at all (fails closed)', () => {
  assert.equal(can('nonsense', 'view_patients'), false);
  assert.equal(can(undefined, 'view_patients'), false);
  assert.equal(can(null, 'view_patients'), false);
  assert.deepEqual(permissionsFor('nonsense'), []);
});

test('a missing permission is denied', () => {
  assert.equal(can(ROLES.ADMIN, ''), false);
  assert.equal(can(ROLES.ADMIN, null), false);
  assert.equal(can(ROLES.ADMIN, 'made_up_permission'), false);
});

test('field workers can document but not author prescriptions', () => {
  assert.equal(can(ROLES.FIELD_WORKER, 'create_patient'), true);
  assert.equal(can(ROLES.FIELD_WORKER, 'create_case'), true);
  assert.equal(can(ROLES.FIELD_WORKER, 'approve_report'), true);
  assert.equal(can(ROLES.FIELD_WORKER, 'view_prescriptions'), true);
  assert.equal(can(ROLES.FIELD_WORKER, 'create_prescription'), false);
  assert.equal(can(ROLES.FIELD_WORKER, 'create_doctor_suggestion'), false);
});

test('only doctors author prescriptions and doctor suggestions', () => {
  assert.equal(canAuthorPrescription(ROLES.DOCTOR), true);
  assert.equal(canAuthorPrescription(ROLES.FIELD_WORKER), false);
  assert.equal(canAuthorPrescription(ROLES.ADMIN), false);
  assert.equal(can(ROLES.DOCTOR, 'create_doctor_suggestion'), true);
});

test('only admins reach the audit log and team management', () => {
  assert.equal(canViewAuditLog(ROLES.ADMIN), true);
  assert.equal(canViewAuditLog(ROLES.DOCTOR), false);
  assert.equal(canViewAuditLog(ROLES.FIELD_WORKER), false);
  assert.equal(canManageTeam(ROLES.ADMIN), true);
  assert.equal(canManageTeam(ROLES.DOCTOR), false);
});

test('all roles can view patient records (spec gates by role, not by denial)', () => {
  ALL_ROLES.forEach((role) => {
    assert.equal(canViewPatientRecords(role), true);
  });
  assert.equal(canViewPatientRecords('nonsense'), false);
});

test('canPrescribe spans authorised prescribing and doctor prescribing', () => {
  assert.equal(canPrescribe(ROLES.FIELD_WORKER), true);
  assert.equal(canPrescribe(ROLES.DOCTOR), true);
  assert.equal(canPrescribe(ROLES.ADMIN), false);
});

test('checkAccess returns a usable reason for denial', () => {
  const denied = checkAccess(ROLES.FIELD_WORKER, 'create_prescription');
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /Field Worker/);
  assert.match(denied.reason, /create prescription/);

  const allowed = checkAccess(ROLES.DOCTOR, 'create_prescription');
  assert.equal(allowed.allowed, true);

  const unknown = checkAccess('nonsense', 'view_patients');
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reason, /Unknown role/);

  assert.equal(checkAccess(ROLES.ADMIN, '').allowed, false);
});

test('permissionsFor lists a role\'s permissions and is a superset check', () => {
  const worker = permissionsFor(ROLES.FIELD_WORKER);
  assert.ok(worker.includes('create_case'));
  assert.ok(!worker.includes('create_prescription'));
  assert.deepEqual(permissionsFor(ROLES.ADMIN).includes('view_audit_log'), true);
});

test('allPermissions covers every permission referenced in the tests', () => {
  const all = allPermissions();
  ['view_patients', 'create_prescription', 'view_audit_log', 'resolve_conflicts'].forEach((name) => {
    assert.ok(all.includes(name), `${name} should be listed`);
  });
});

test('attributeToAuthor refuses to let a non-doctor author a prescription', () => {
  const result = attributeToAuthor(ROLES.FIELD_WORKER, 'Sita Devi', { drug: 'Paracetamol' });
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
  assert.match(result.reason, /cannot author/);
});

test('attributeToAuthor refuses an anonymous prescription (never AI-attributed)', () => {
  const result = attributeToAuthor(ROLES.DOCTOR, '   ', { drug: 'Amoxicillin' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /never be attributed to the AI/);
});

test('attributeToAuthor stamps doctor identity and marks it not AI-generated', () => {
  const result = attributeToAuthor(ROLES.DOCTOR, 'Dr. A. Sharma', { drug: 'Amoxicillin 500mg' });
  assert.equal(result.ok, true);
  assert.equal(result.record.author, 'Dr. A. Sharma');
  assert.equal(result.record.author_role, 'doctor');
  assert.equal(result.record.provenance, 'doctor');
  assert.equal(result.record.generated_by_ai, false);
  assert.equal(result.record.drug, 'Amoxicillin 500mg');
});

test('requiresDoctorReview flags urgent cases, conflicts and blocked QA', () => {
  assert.equal(requiresDoctorReview({ priority: 'Routine' }).required, false);
  assert.equal(requiresDoctorReview({}).required, false);

  const urgent = requiresDoctorReview({ priority: 'Urgent' });
  assert.equal(urgent.required, true);
  assert.match(urgent.reasons[0], /Urgent/);

  const conflicted = requiresDoctorReview({ conflicts: [{ field: 'temperature' }] });
  assert.equal(conflicted.required, true);

  const blocked = requiresDoctorReview({ qaStatus: 'blocked' });
  assert.equal(blocked.required, true);
  assert.equal(blocked.reasons.length, 1);

  const many = requiresDoctorReview({ priority: 'Urgent', conflicts: [{ field: 'x' }], qaStatus: 'blocked' });
  assert.equal(many.reasons.length, 3);
});

test('doctors are not a mandatory gate for ordinary cases', () => {
  // Spec: "doctors do not need to approve every case".
  assert.equal(requiresDoctorReview({ priority: 'Routine', conflicts: [], qaStatus: 'clear' }).required, false);
});

test('doctorSuggestionState explains an empty list rather than showing a blank panel', () => {
  const empty = doctorSuggestionState([], ROLES.FIELD_WORKER);
  assert.equal(empty.visible, true);
  assert.match(empty.emptyMessage, /Most cases do not require clinical review/);

  const withItems = doctorSuggestionState([{ id: 1 }], ROLES.FIELD_WORKER);
  assert.equal(withItems.visible, true);
  assert.equal(withItems.emptyMessage, '');

  const denied = doctorSuggestionState([], 'nonsense');
  assert.equal(denied.visible, false);
  assert.match(denied.emptyMessage, /do not have access/);
});
