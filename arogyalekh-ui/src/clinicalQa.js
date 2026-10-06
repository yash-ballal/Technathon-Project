/**
 * Clinical Workflow QA — pre-signing rule engine for the AROGYALEKH capture workflow.
 *
 * Pure and dependency-free on purpose: no React, no DOM, no fetch. Every finding is
 * derived from data the capture workflow already holds (patient record, AI report,
 * diagnosis, notes, accepted prescriptions), so the rules can be unit tested with
 * `node --test` and reused later by a server-side implementation.
 */

export const QA_LEVEL = {
  BLOCK: 'block',
  WARN: 'warn',
  INFO: 'info',
};

// Vitals that a signed encounter is normally expected to state. Absence is a warning,
// never a hard block, because a field worker may legitimately be unable to measure them.
const CRITICAL_METRIC_FIELDS = [
  'blood_pressure',
  'bp',
  'temperature',
  'temp',
  'pulse',
  'heart_rate',
  'respiratory_rate',
  'spo2',
  'oxygen_saturation',
  'weight',
  'blood_sugar',
  'grbs',
];

// Curated cross-reactivity groups: a documented allergy to any member of a group is
// treated as a conflict with every member of that group. Deliberately small and
// explicit rather than exhaustive, so the check never guesses.
const DRUG_CLASSES = {
  penicillin: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin', 'piperacillin', 'augmentin', 'amoxyclav', 'coamoxiclav'],
  cephalosporin: ['cephalexin', 'ceftriaxone', 'cefixime', 'cefuroxime', 'cefotaxime', 'cefadroxil'],
  sulfa: ['sulfamethoxazole', 'cotrimoxazole', 'trimethoprim', 'sulfasalazine'],
  nsaid: ['ibuprofen', 'diclofenac', 'aceclofenac', 'naproxen', 'ketorolac', 'aspirin', 'nimesulide'],
};

const FREQUENCY_TOKENS = [
  'od', 'bd', 'tds', 'tid', 'qid', 'hs', 'sos', 'prn', 'stat',
  'q4h', 'q6h', 'q8h', 'q12h', 'weekly', 'daily', 'once', 'bd.', 'nocte', 'morning', 'night',
];

// Words that carry no identifying weight when matching a drug name against an allergy.
const IGNORED_MATCH_TOKENS = new Set([
  'tab', 'tabs', 'tablet', 'cap', 'caps', 'capsule', 'syp', 'syrup', 'susp', 'suspension',
  'inj', 'injection', 'sachet', 'sachets', 'ointment', 'cream', 'drops', 'solution', 'oral',
  'iv', 'im', 'mg', 'ml', 'g', 'iu', 'unit', 'units', 'mcg', 'dose', 'drug', 'medicine',
  'therapy', 'of', 'and', 'with', 'plus', 'for', 'days', 'day', 'week', 'weeks', 'month',
  'and', 'the', 'per', 'pr', 'sos', 'prn', 'od', 'bd', 'tds', 'qid', 'hs', 'stat',
]);

function normalize(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(text) {
  const normalized = normalize(text);
  return normalized ? normalized.split(' ') : [];
}

function significantTokens(text) {
  return tokens(text).filter((t) => t.length >= 4 && !IGNORED_MATCH_TOKENS.has(t));
}

function hasText(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Render a report `missing[]` entry (string or {field, importance, reason}) as text. */
export function formatMissingItem(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    const field = item.field ? String(item.field) : 'Unspecified field';
    const reason = item.reason ? String(item.reason) : '';
    const importance = item.importance ? String(item.importance) : '';
    const suffix = [importance, reason].filter(Boolean).join(' — ');
    return suffix ? `${field}: ${suffix}` : field;
  }
  return String(item);
}

/** Render any extracted fact value as text, including nested structures. */
export function formatFactValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((entry) => formatFactValue(entry)).filter(Boolean).join(', ');
    }
    if (hasText(value.value)) return formatFactValue(value.value);
    if (hasText(value.field)) return formatMissingItem(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function drugClassesIn(text) {
  const normalized = normalize(text);
  if (!normalized) return new Set();
  const words = new Set(normalized.split(' '));
  const classes = new Set();
  Object.entries(DRUG_CLASSES).forEach(([className, members]) => {
    if (words.has(className)) classes.add(className);
    if (members.some((member) => words.has(member))) classes.add(className);
  });
  return classes;
}

function collectAllergyText(patient, report) {
  const sources = [];
  if (patient) {
    [patient.allergies, patient.drug_allergies, patient.allergy, patient.known_allergies]
      .forEach((value) => {
        if (hasText(value) && typeof value !== 'object') sources.push(String(value));
      });
  }
  const confirmed = Array.isArray(report?.confirmed) ? report.confirmed : [];
  confirmed.forEach((fact) => {
    const field = normalize(fact?.field);
    if (field.includes('allerg')) {
      const value = formatFactValue(fact?.value);
      if (value.trim()) sources.push(value);
    }
  });
  return sources.filter((text) => {
    const normalized = normalize(text);
    return normalized && !['none', 'nil', 'no', 'nka', 'not known', 'no known allergy'].includes(normalized);
  });
}

function splitMedicationText(text) {
  const cleaned = String(text === null || text === undefined ? '' : text).trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  // A single "Tab A 500mg TDS, Tab B 10mg OD" style line may still hold several drugs
  // once the commas are gone, so fall back to splitting on dose/frequency boundaries.
  if (parts.length === 1) {
    const byDose = parts[0]
      .split(/(?=\b(?:tab|cap|syp|inj|sachet|tablet|capsule|syrup|injection)\.?\s)/i)
      .map((part) => part.trim().replace(/^(?:and|then|plus)\s+/i, ''))
      .filter(Boolean);
    return byDose;
  }
  return parts;
}

function collectMedicationText(report, prescriptions) {
  const medications = [];
  (Array.isArray(prescriptions) ? prescriptions : []).forEach((rx) => {
    const name = normalize(rx?.drug);
    if (name) medications.push({ label: name, source: 'prescription' });
  });
  const confirmed = Array.isArray(report?.confirmed) ? report.confirmed : [];
  confirmed.forEach((fact) => {
    const field = normalize(fact?.field);
    if (field.includes('medic') || field.includes('drug') || field.includes('prescription') || field.includes('rx')) {
      splitMedicationText(formatFactValue(fact?.value)).forEach((part) =>
        medications.push({ label: normalize(part), source: 'report' })
      );
    }
  });
  return medications;
}

function patientNameCheck(patient, report) {
  const expected = normalize(patient?.name);
  const confirmed = Array.isArray(report?.confirmed) ? report.confirmed : [];
  const nameFacts = confirmed.filter((fact) => normalize(fact?.field).includes('name'));

  for (const fact of nameFacts) {
    const candidate = normalize(formatFactValue(fact?.value));
    if (!candidate) continue;

    if (!expected) {
      return {
        id: 'patient_identity',
        level: QA_LEVEL.BLOCK,
        message: `The document names "${formatFactValue(fact.value)}" but no active patient record is bound to this encounter.`,
      };
    }

    const sameName = candidate === expected || candidate.includes(expected) || expected.includes(candidate);
    if (!sameName) {
      return {
        id: 'patient_identity',
        level: QA_LEVEL.BLOCK,
        message: `Patient identity mismatch: document names "${formatFactValue(fact.value)}" but the active record is "${patient.name}".`,
      };
    }
  }
  return null;
}

function missingInformationChecks(report) {
  const checks = [];
  const missing = Array.isArray(report?.missing) ? report.missing : [];

  missing.forEach((entry, index) => {
    const field = normalize(typeof entry === 'string' ? entry : entry?.field);
    const importance = normalize(typeof entry === 'object' && entry ? entry?.importance : '');
    const label = formatMissingItem(entry) || `Item ${index + 1}`;

    if (field.includes('identity mismatch')) {
      checks.push({
        id: 'patient_identity_document',
        level: QA_LEVEL.BLOCK,
        message: `Patient identity mismatch flagged on the document: ${formatMissingItem(entry)}`,
      });
      return;
    }

    if (importance === 'high' || importance === 'critical') {
      checks.push({
        id: `missing_high_${index}`,
        level: QA_LEVEL.BLOCK,
        message: `Missing high-importance clinical information — ${label}`,
      });
      return;
    }

    const isCriticalMetric = CRITICAL_METRIC_FIELDS.some((metric) => field.includes(normalize(metric)));
    if (isCriticalMetric || importance === 'medium') {
      checks.push({
        id: `missing_warn_${index}`,
        level: QA_LEVEL.WARN,
        message: `Unconfirmed clinical detail — ${label}`,
      });
      return;
    }

    checks.push({
      id: `missing_info_${index}`,
      level: QA_LEVEL.INFO,
      message: `Not documented — ${label}`,
    });
  });

  return checks;
}

function uncertainChecks(report) {
  const uncertain = Array.isArray(report?.uncertain) ? report.uncertain : [];
  return uncertain.map((entry, index) => ({
    id: `uncertain_${index}`,
    level: QA_LEVEL.WARN,
    message: `Unverified AI extraction — ${formatFactValue(entry)}`,
  }));
}

function allergyChecks(patient, report, prescriptions) {
  const allergyTexts = collectAllergyText(patient, report);
  if (allergyTexts.length === 0) return [];

  const medications = collectMedicationText(report, prescriptions);
  if (medications.length === 0) return [];

  const checks = [];
  const reported = new Set();

  allergyTexts.forEach((allergyText) => {
    const allergyClasses = drugClassesIn(allergyText);
    const allergyTokens = significantTokens(allergyText);

    medications.forEach((med) => {
      const medClasses = drugClassesIn(med.label);
      const classConflict = [...allergyClasses].some((className) => medClasses.has(className));
      const medTokens = tokens(med.label);
      const tokenConflict = allergyTokens.some((token) => medTokens.includes(token));

      if (!classConflict && !tokenConflict) return;

      const key = `${normalize(allergyText)}|${med.label}`;
      if (reported.has(key)) return;
      reported.add(key);

      checks.push({
        id: 'allergy_conflict',
        level: QA_LEVEL.BLOCK,
        message: `Allergy conflict: "${med.label}" (${med.source}) is contraindicated by the documented allergy "${allergyText}".`,
      });
    });
  });

  return checks;
}

function prescriptionChecks(prescriptions) {
  const accepted = Array.isArray(prescriptions) ? prescriptions : [];
  const checks = [];

  if (accepted.length === 0) {
    checks.push({
      id: 'prescription_absent',
      level: QA_LEVEL.WARN,
      message: 'No medication or advice line is attached to this encounter.',
    });
    return checks;
  }

  accepted.forEach((rx, index) => {
    const drug = normalize(rx?.drug);
    const dose = normalize(rx?.dose);

    if (!drug) {
      checks.push({
        id: `prescription_unnamed_${index}`,
        level: QA_LEVEL.WARN,
        message: `Prescription ${index + 1} has no drug name.`,
      });
      return;
    }

    // Dose may be stated as the strength inside the prescription line ("Paracetamol 650mg")
    // or as a standalone dose field ("TDS x 5 days"), so both texts are combined.
    const doseText = `${drug} ${dose}`.trim();

    if (!dose) {
      checks.push({
        id: `dose_missing_${index}`,
        level: QA_LEVEL.WARN,
        message: `${rx.drug}: dose is missing.`,
      });
      return;
    }

    const quantity = doseText.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu)\b/);
    if (!quantity) {
      checks.push({
        id: `dose_unquantified_${index}`,
        level: QA_LEVEL.WARN,
        message: `${rx.drug}: dose "${rx.dose}" states no numeric quantity with a unit.`,
      });
    } else {
      const amount = Number.parseFloat(quantity[1]);
      const unit = quantity[2];
      if (unit === 'mg' && amount > 2000) {
        checks.push({
          id: `dose_high_${index}`,
          level: QA_LEVEL.WARN,
          message: `${rx.drug}: single dose ${amount}mg is above the usual adult per-dose range — verify before signing.`,
        });
      }
      if (unit === 'g' && amount > 2) {
        checks.push({
          id: `dose_high_${index}`,
          level: QA_LEVEL.WARN,
          message: `${rx.drug}: single dose ${amount}g is above the usual adult per-dose range — verify before signing.`,
        });
      }
    }

    const doseWords = new Set(doseText.split(' '));
    const statesFrequency =
      FREQUENCY_TOKENS.some((token) => doseWords.has(token)) || /\bx\s*\d/.test(dose) || /\bq\d/.test(dose);
    if (!statesFrequency) {
      checks.push({
        id: `frequency_unstated_${index}`,
        level: QA_LEVEL.WARN,
        message: `${rx.drug}: dosing frequency is not stated in "${rx.dose}".`,
      });
    }
  });

  return checks;
}

function clinicalContextChecks(report, diagnosis, notes, priority) {
  const checks = [];

  if (!hasText(diagnosis) && !hasText(report?.summary)) {
    checks.push({
      id: 'diagnosis_absent',
      level: QA_LEVEL.BLOCK,
      message: 'No diagnosis or clinical summary has been recorded for this encounter.',
    });
  }

  if (normalize(priority) === 'urgent' && !hasText(notes)) {
    checks.push({
      id: 'urgent_without_notes',
      level: QA_LEVEL.WARN,
      message: 'Priority is marked Urgent but no clinical notes were recorded.',
    });
  }

  const followUps = Array.isArray(report?.follow_ups) ? report.follow_ups : [];
  if (followUps.length === 0) {
    checks.push({
      id: 'follow_up_absent',
      level: QA_LEVEL.INFO,
      message: 'No follow-up instruction recorded.',
    });
  }

  return checks;
}

/**
 * Run every clinical QA rule for one encounter.
 *
 * @param {object} input
 * @param {object|null} input.patient Active patient record (name, allergies, ...).
 * @param {object|null} input.report  Structured report: {summary, confirmed, uncertain, missing, follow_ups}.
 * @param {string} [input.diagnosis]  Finalised primary diagnosis.
 * @param {Array}  [input.prescriptions] Accepted prescriptions ({drug, dose, route}).
 * @param {string} [input.notes]      Free-text clinical notes.
 * @param {string} [input.priority]   'Routine' | 'Urgent' | ...
 * @returns {{status: 'blocked'|'review'|'clear', checks: Array, blocking: Array, warnings: Array, infos: Array, blockingMessages: string[], warningMessages: string[], checkedAt: string}}
 */
export function runClinicalQa({ patient = null, report = null, diagnosis = '', prescriptions = [], notes = '', priority = '' } = {}) {
  const checks = [
    patientNameCheck(patient, report),
    ...missingInformationChecks(report),
    ...clinicalContextChecks(report, diagnosis, notes, priority),
    ...allergyChecks(patient, report, prescriptions),
    ...prescriptionChecks(prescriptions),
    ...uncertainChecks(report),
  ].filter(Boolean);

  const blocking = checks.filter((check) => check.level === QA_LEVEL.BLOCK);
  const warnings = checks.filter((check) => check.level === QA_LEVEL.WARN);
  const infos = checks.filter((check) => check.level === QA_LEVEL.INFO);

  return {
    status: blocking.length > 0 ? 'blocked' : warnings.length > 0 ? 'review' : 'clear',
    checks,
    blocking,
    warnings,
    infos,
    blockingMessages: blocking.map((check) => check.message),
    warningMessages: warnings.map((check) => check.message),
    checkedAt: new Date().toISOString(),
  };
}

/** Compact QA payload for persisting alongside a signed encounter. */
export function qaAuditSnapshot(qa) {
  if (!qa) return null;
  return {
    status: qa.status,
    blocking: qa.blockingMessages,
    warnings: qa.warningMessages,
    checked_at: qa.checkedAt,
  };
}
