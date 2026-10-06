/**
 * Patient registry helpers: record building, duplicate detection and clinical
 * field display.
 *
 * Pure and dependency-free so the rules can be unit tested with `node --test`.
 *
 * Why this module exists: the registration form collects nine fields, but the
 * original handler persisted only four of them, silently discarding allergies,
 * blood group, phone, emergency contact and ABHA ID. Allergies in particular are
 * read by the clinical QA gate, so dropping them made the allergy-conflict check
 * incapable of ever firing.
 */

const ALLERGY_NONE_VALUES = new Set([
  'none', 'nil', 'no', 'nka', 'nkda', 'not known', 'no known allergy',
  'no known allergies', 'none known', 'na', 'n/a', '-',
]);

/** Trim a form value to a string. */
export function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Parse an age input into a number, or null when it is not a plausible age.
 * Rejects negatives and absurd values rather than storing garbage.
 */
export function parseAge(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const age = Number.parseFloat(match[0]);
  if (!Number.isFinite(age) || age < 0 || age > 130) return null;
  return Math.round(age);
}

/** True when the given allergy text records an actual allergy. */
export function hasAllergyData(value) {
  const text = clean(value);
  if (!text) return false;
  return !ALLERGY_NONE_VALUES.has(text.toLowerCase());
}

/**
 * Build the full patient record from the registration form state.
 *
 * Every field the form collects is carried through. Empty optional fields are
 * stored as empty strings so the profile can distinguish "not recorded" from a
 * value, and `allergies` is only set when a real allergy is documented.
 */
export function buildPatientRecord(form = {}) {
  const name = clean(form.name);
  if (!name) throw new Error('Patient name is required');

  const age = parseAge(form.age);
  const allergies = clean(form.allergies);

  const record = {
    name,
    age,
    gender: clean(form.gender) || 'Unknown',
    location: clean(form.location),
    phone: clean(form.phone),
    emergency_contact: clean(form.emergencyContact),
    blood_group: clean(form.bloodGroup),
    abha_id: clean(form.abhaId),
    allergies,
    allergy_status: hasAllergyData(allergies) ? 'documented' : 'none_documented',
  };

  return record;
}

/** Normalise a name for comparison: case, punctuation and spacing insensitive. */
export function normalizeName(name) {
  return clean(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizePhone(phone) {
  const digits = clean(phone).replace(/[^0-9]/g, '');
  // Indian numbers are written both with and without a +91 country code, so compare
  // the subscriber number: 9876543210 and +91 98765 43210 are the same person.
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

/**
 * Find existing patients that look like the one being registered.
 *
 * The spec requires preventing "accidental duplicate registration ... using
 * configured identifiers or matching information". Phone match is treated as
 * decisive; otherwise name+age, or an exact ABHA ID match.
 *
 * @returns {Array} matching patients, strongest match first
 */
export function findDuplicatePatients(patients, candidate) {
  const list = Array.isArray(patients) ? patients : [];
  const name = normalizeName(candidate?.name);
  const phone = normalizePhone(candidate?.phone);
  const abha = clean(candidate?.abhaId || candidate?.abha_id).toLowerCase();
  const age = parseAge(candidate?.age);

  const matches = [];
  list.forEach((patient) => {
    if (!patient) return;
    let reason = '';
    let strength = 0;

    const patientAbha = clean(patient.abha_id).toLowerCase();
    const patientPhone = normalizePhone(patient.phone);
    const patientName = normalizeName(patient.name);
    const patientAge = parseAge(patient.age);

    if (abha && patientAbha && abha === patientAbha) {
      reason = 'ABHA ID already registered';
      strength = 4;
    } else if (phone && patientPhone && phone === patientPhone) {
      reason = 'Phone number already registered';
      strength = 3;
    } else if (name && patientName && name === patientName && age !== null && patientAge !== null && age === patientAge) {
      reason = 'Same name and age';
      strength = 2;
    } else if (name && patientName && name === patientName) {
      reason = 'Same name';
      strength = 1;
    }

    if (reason) matches.push({ patient, reason, strength });
  });

  matches.sort((a, b) => b.strength - a.strength);
  return matches;
}

/** Human-readable clinical value for the profile, never a hardcoded demo value. */
export function displayClinicalValue(patient, field) {
  const raw = patient ? patient[field] : '';
  const text = clean(raw);
  if (!text) return 'Not recorded';
  return text;
}

/** Provenance labels required by the spec's patient profile / timeline. */
export const PROVENANCE = {
  WORKER: 'Worker entered',
  AI: 'AI extracted',
  HUMAN: 'Human corrected',
  DOCTOR: 'Doctor added',
};

export function provenanceLabel(kind) {
  return PROVENANCE[String(kind || '').toUpperCase()] || 'Source unknown';
}
