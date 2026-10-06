/**
 * Tests for patient registry helpers.
 *
 * Run with: npm test   (from arogyalekh-ui/)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPatientRecord,
  findDuplicatePatients,
  parseAge,
  hasAllergyData,
  normalizeName,
  displayClinicalValue,
  provenanceLabel,
  PROVENANCE,
} from './patientRegistry.js';

const fullForm = {
  name: 'Ramesh Sharma',
  age: '45',
  gender: 'Male',
  location: 'Village Rampur, Sector 4',
  phone: '+91 98765 43210',
  emergencyContact: 'Sunita Sharma 98111 22222',
  bloodGroup: 'B+',
  abhaId: '12-3456-7890-1234',
  allergies: 'Penicillin',
};

test('buildPatientRecord carries every field the form collects', () => {
  const record = buildPatientRecord(fullForm);
  assert.equal(record.name, 'Ramesh Sharma');
  assert.equal(record.age, 45);
  assert.equal(record.gender, 'Male');
  assert.equal(record.location, 'Village Rampur, Sector 4');
  // These five were previously typed in and discarded.
  assert.equal(record.phone, '+91 98765 43210');
  assert.equal(record.emergency_contact, 'Sunita Sharma 98111 22222');
  assert.equal(record.blood_group, 'B+');
  assert.equal(record.abha_id, '12-3456-7890-1234');
  assert.equal(record.allergies, 'Penicillin');
  assert.equal(record.allergy_status, 'documented');
});

test('buildPatientRecord keeps allergies reachable by the QA gate', () => {
  const record = buildPatientRecord(fullForm);
  // clinicalQa reads patient.allergies; undefined here silently disabled the check.
  assert.ok(record.allergies);
  assert.equal(record.allergies, 'Penicillin');
});

test('buildPatientRecord requires a name', () => {
  assert.throws(() => buildPatientRecord({ ...fullForm, name: '   ' }), /name is required/);
});

test('buildPatientRecord marks absent allergies as none documented, not as empty text', () => {
  const record = buildPatientRecord({ ...fullForm, allergies: '' });
  assert.equal(record.allergies, '');
  assert.equal(record.allergy_status, 'none_documented');
});

test('buildPatientRecord tolerates a completely empty form except the name', () => {
  const record = buildPatientRecord({ name: 'A' });
  assert.equal(record.name, 'A');
  assert.equal(record.age, null);
  assert.equal(record.gender, 'Unknown');
  assert.equal(record.blood_group, '');
  assert.equal(record.allergy_status, 'none_documented');
});

test('parseAge accepts plausible ages and rejects nonsense', () => {
  assert.equal(parseAge('45'), 45);
  assert.equal(parseAge(' 45 y '), 45);
  assert.equal(parseAge('0'), 0);
  assert.equal(parseAge('130'), 130);
  assert.equal(parseAge('abc'), null);
  assert.equal(parseAge(''), null);
  assert.equal(parseAge('-4'), null);
  assert.equal(parseAge('400'), null);
});

test('hasAllergyData distinguishes real allergies from negative placeholders', () => {
  assert.equal(hasAllergyData('Penicillin'), true);
  assert.equal(hasAllergyData('sulfa drugs'), true);
  assert.equal(hasAllergyData('None'), false);
  assert.equal(hasAllergyData('NIL'), false);
  assert.equal(hasAllergyData('No known allergies'), false);
  assert.equal(hasAllergyData(''), false);
  assert.equal(hasAllergyData('   '), false);
});

test('normalizeName ignores case and punctuation', () => {
  assert.equal(normalizeName('Ramesh  Sharma'), 'ramesh sharma');
  assert.equal(normalizeName('RAMESH-SHARMA'), 'ramesh sharma');
  assert.equal(normalizeName(''), '');
});

test('findDuplicatePatients catches an ABHA ID match first', () => {
  const patients = [
    { id: 1, name: 'Someone Else', abha_id: '12-3456-7890-1234' },
    { id: 2, name: 'Ramesh Sharma', age: 45 },
  ];
  const matches = findDuplicatePatients(patients, { name: 'Ramesh Sharma', age: '45', abhaId: '12-3456-7890-1234' });
  assert.equal(matches[0].patient.id, 1);
  assert.match(matches[0].reason, /ABHA/);
  assert.ok(matches.length >= 1);
});

test('findDuplicatePatients catches an identical phone number', () => {
  const patients = [{ id: 7, name: 'R Sharma', phone: '9876543210' }];
  const matches = findDuplicatePatients(patients, { name: 'Different Name', phone: '+91 98765 43210' });
  assert.equal(matches.length, 1);
  assert.match(matches[0].reason, /Phone/);
});

test('findDuplicatePatients catches same name and age', () => {
  const patients = [{ id: 3, name: 'Sunita Devi', age: 34 }];
  const matches = findDuplicatePatients(patients, { name: 'sunita devi', age: '34' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].reason, 'Same name and age');
});

test('findDuplicatePatients does not flag a same-name patient of a different age', () => {
  const patients = [{ id: 4, name: 'Ramesh Sharma', age: 45 }];
  const matches = findDuplicatePatients(patients, { name: 'Ramesh Sharma', age: '60' });
  // Still surfaced, but only as a weak same-name signal.
  assert.equal(matches.length, 1);
  assert.equal(matches[0].strength, 1);
});

test('findDuplicatePatients returns nothing for a genuinely new patient', () => {
  const patients = [{ id: 5, name: 'Amit Patel', age: 28, phone: '9000000000' }];
  assert.deepEqual(findDuplicatePatients(patients, { name: 'Brand New Person', age: '19', phone: '9111111111' }), []);
});

test('findDuplicatePatients tolerates missing input', () => {
  assert.deepEqual(findDuplicatePatients(null, { name: 'X' }), []);
  assert.deepEqual(findDuplicatePatients([{ id: 1 }], {}), []);
  assert.deepEqual(findDuplicatePatients([null, undefined], { name: 'X' }), []);
});

test('displayClinicalValue never fabricates a value', () => {
  const patient = { blood_group: 'B+', allergies: '' };
  assert.equal(displayClinicalValue(patient, 'blood_group'), 'B+');
  assert.equal(displayClinicalValue(patient, 'allergies'), 'Not recorded');
  assert.equal(displayClinicalValue(patient, 'phone'), 'Not recorded');
  assert.equal(displayClinicalValue(null, 'blood_group'), 'Not recorded');
});

test('provenance labels distinguish worker, AI, human and doctor', () => {
  assert.equal(provenanceLabel('worker'), PROVENANCE.WORKER);
  assert.equal(provenanceLabel('AI'), PROVENANCE.AI);
  assert.equal(provenanceLabel('human'), PROVENANCE.HUMAN);
  assert.equal(provenanceLabel('doctor'), PROVENANCE.DOCTOR);
  assert.equal(provenanceLabel('nonsense'), 'Source unknown');
  assert.equal(provenanceLabel(undefined), 'Source unknown');
});
