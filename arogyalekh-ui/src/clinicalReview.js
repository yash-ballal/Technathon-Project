/**
 * Clinical review model for the AI review/edit screen.
 *
 * Implements the spec's central quality-assurance rules:
 *   - every extracted fact has a visible status
 *     (Confirmed / Uncertain / Missing / Conflict / Human Corrected),
 *   - evidence is attached to the fact it supports and is viewable,
 *   - unsupported AI claims are flagged rather than silently accepted,
 *   - conflicts show both values and must be resolved by a human,
 *   - human corrections are preserved as history instead of overwriting AI output.
 *
 * Pure and dependency-free so it can be unit tested with `node --test`.
 */

/** Display metadata for each fact status. Tones map onto the existing palette. */
export const FACT_STATUS = {
  confirmed: { key: 'confirmed', label: 'Confirmed', tone: 'emerald', description: 'Extracted and supported by evidence.' },
  uncertain: { key: 'uncertain', label: 'Uncertain', tone: 'amber', description: 'Illegible or ambiguous in the source.' },
  missing: { key: 'missing', label: 'Missing', tone: 'rose', description: 'Expected but not documented.' },
  conflict: { key: 'conflict', label: 'Conflict', tone: 'rose', description: 'Two sources disagree; a human must resolve this.' },
  human_corrected: { key: 'human_corrected', label: 'Human Corrected', tone: 'mint', description: 'Changed by a reviewer; the AI value is kept in history.' },
};

export const ALL_FACT_STATUSES = Object.keys(FACT_STATUS);

export function statusMeta(status) {
  return FACT_STATUS[status] || FACT_STATUS.uncertain;
}

/** Human-readable description of one evidence record. */
export function evidenceText(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const quote = evidence.quote ? `"${evidence.quote}"` : '';
  switch (evidence.kind) {
    case 'audio_timestamp':
      return `Voice note at ${evidence.timestamp != null ? `${evidence.timestamp}s` : 'unknown time'}${quote ? `: ${quote}` : ''}`;
    case 'transcript':
      return `Voice transcript${quote ? `: ${quote}` : ''}`;
    case 'image_region': {
      const region = Array.isArray(evidence.region) ? evidence.region.join(', ') : 'unknown region';
      return `Handwritten note image, region [${region}]`;
    }
    case 'worker_note':
      return `Reviewer note${evidence.ref ? ` (${evidence.ref})` : ''}${quote ? `: ${quote}` : ''}`;
    case 'text_span':
    default:
      return `${evidence.label === 'unverified quote' ? 'Unverified quote' : 'Source text'}${quote ? `: ${quote}` : ''}`;
  }
}

/** True when a fact's evidence could not be located in the source it claims. */
export function isUnsupported(fact) {
  const evidence = Array.isArray(fact?.evidence) ? fact.evidence : [];
  if (evidence.length === 0) return false;
  return evidence.some((ev) => ev && ev.label === 'unverified quote');
}

function normalizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((ev) => ev && typeof ev === 'object');
}

/**
 * Normalise either report shape into one review model.
 *
 * The backend contract returns `facts`/`conflicts`/`clarification_questions`,
 * while older payloads only have `confirmed`/`uncertain`/`missing`. Both are
 * accepted so the screen keeps working against either.
 */
export function normalizeReport(raw) {
  const report = raw && typeof raw === 'object' ? raw : {};

  let facts = Array.isArray(report.facts)
    ? report.facts.map((fact) => ({
        field: fact?.field ?? '',
        value: fact?.value ?? '',
        status: ALL_FACT_STATUSES.includes(fact?.status) ? fact.status : 'confirmed',
        source: fact?.source ?? 'ai',
        source_ref: fact?.source_ref ?? '',
        evidence: normalizeEvidence(fact?.evidence),
        original_value: fact?.original_value ?? null,
        corrections: Array.isArray(fact?.corrections) ? fact.corrections : [],
      }))
    : [];

  if (facts.length === 0) {
    // Legacy shape: derive facts from the three arrays.
    (Array.isArray(report.confirmed) ? report.confirmed : []).forEach((item) => {
      facts.push({
        field: item?.field ?? '',
        value: item?.value ?? '',
        status: 'confirmed',
        source: item?.source ?? 'ai',
        source_ref: item?.source_ref ?? '',
        evidence: normalizeEvidence(item?.evidence).length
          ? normalizeEvidence(item.evidence)
          : item?.source_quote
            ? [{ kind: 'text_span', quote: item.source_quote }]
            : [],
        original_value: null,
        corrections: [],
      });
    });
    (Array.isArray(report.uncertain) ? report.uncertain : []).forEach((item) => {
      facts.push({
        field: item?.field ?? '',
        value: item?.value ?? '',
        status: 'uncertain',
        source: item?.source ?? 'ai',
        source_ref: '',
        evidence: item?.source_quote ? [{ kind: 'text_span', quote: item.source_quote }] : [],
        original_value: null,
        corrections: [],
      });
    });
  }

  const conflicts = (Array.isArray(report.conflicts) ? report.conflicts : []).map((conflict) => ({
    field: conflict?.field ?? '',
    reason: conflict?.reason ?? '',
    importance: conflict?.importance ?? 'high',
    requires_resolution: conflict?.requires_resolution !== false,
    options: (Array.isArray(conflict?.options) ? conflict.options : []).map((option) => ({
      value: option?.value ?? '',
      sources: Array.isArray(option?.sources) ? option.sources : [],
      evidence: normalizeEvidence(option?.evidence),
    })),
  }));

  return {
    summary: typeof report.summary === 'string' ? report.summary : '',
    facts,
    conflicts,
    clarificationQuestions: Array.isArray(report.clarification_questions) ? report.clarification_questions : [],
    missing: Array.isArray(report.missing) ? report.missing : [],
    followUps: Array.isArray(report.follow_ups) ? report.follow_ups : [],
    sources: Array.isArray(report.sources) ? report.sources : [],
    identityBlock: report.identity_block || null,
  };
}

/**
 * Record a human correction, preserving the AI value and every previous edit.
 *
 * This replaces the old behaviour of writing straight into `fact.value`, which
 * destroyed the original AI output and left no audit trail.
 */
export function applyCorrection(facts, index, newValue, { actor = 'Field Worker', timestamp = '' } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (index < 0 || index >= list.length) return list;

  return list.map((fact, i) => {
    if (i !== index) return fact;

    const previous = fact.value;
    if (String(previous) === String(newValue)) return fact;

    const history = Array.isArray(fact.corrections) ? [...fact.corrections] : [];
    history.push({ from: previous, to: newValue, actor, timestamp });

    return {
      ...fact,
      value: newValue,
      status: 'human_corrected',
      source: 'worker',
      // Preserve the very first AI value, not the most recent edit.
      original_value: fact.status === 'human_corrected' ? fact.original_value : previous,
      corrections: history,
    };
  });
}

/** Reject an AI output: it is removed from the report body but kept for history. */
export function rejectFact(facts, index, { actor = 'Field Worker', timestamp = '', reason = '' } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (index < 0 || index >= list.length) return list;

  return list.map((fact, i) => {
    if (i !== index) return fact;
    const history = Array.isArray(fact.corrections) ? [...fact.corrections] : [];
    history.push({ from: fact.value, to: null, actor, timestamp, reason: reason || 'Rejected during review' });
    return {
      ...fact,
      status: 'missing',
      source: 'worker',
      rejected: true,
      original_value: fact.status === 'human_corrected' ? fact.original_value : fact.value,
      value: '',
      corrections: history,
    };
  });
}

/** Resolve a conflict by recording the reviewer's chosen value (never auto-picked). */
export function resolveConflict(conflicts, field, chosenValue, { actor = 'Field Worker', timestamp = '' } = {}) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  return list.map((conflict) => {
    if (conflict.field !== field) return conflict;
    return {
      ...conflict,
      requires_resolution: false,
      resolution: { value: chosenValue, actor, timestamp, options: conflict.options },
    };
  });
}

/** Conflicts still awaiting a human decision. */
export function unresolvedConflicts(report) {
  const conflicts = Array.isArray(report?.conflicts) ? report.conflicts : [];
  return conflicts.filter((conflict) => conflict.requires_resolution !== false);
}

/** Facts that still need human attention before the report can be approved. */
export function pendingReviewItems(report) {
  const facts = Array.isArray(report?.facts) ? report.facts : [];
  const pending = [];

  unresolvedConflicts(report).forEach((conflict) => {
    pending.push({ kind: 'conflict', field: conflict.field, reason: conflict.reason || `Sources disagree on ${conflict.field}` });
  });

  facts.forEach((fact, index) => {
    if (fact.status === 'uncertain') {
      pending.push({ kind: 'uncertain', field: fact.field, index, reason: 'AI extraction is uncertain and needs confirmation' });
    }
    if (isUnsupported(fact)) {
      pending.push({ kind: 'unsupported', field: fact.field, index, reason: 'Evidence for this claim could not be found in the source' });
    }
  });

  return pending;
}

/** Counts per status, used for the review summary. */
export function statusCounts(facts) {
  const counts = { confirmed: 0, uncertain: 0, missing: 0, conflict: 0, human_corrected: 0 };
  (Array.isArray(facts) ? facts : []).forEach((fact) => {
    if (counts[fact?.status] !== undefined) counts[fact.status] += 1;
  });
  return counts;
}

function toLegacyFact(fact) {
  return {
    field: fact.field,
    value: fact.value,
    status: fact.status,
    source: fact.source,
    source_quote: (fact.evidence || []).find((ev) => ev && ev.quote)?.quote || '',
    evidence: fact.evidence || [],
    original_value: fact.original_value ?? null,
    corrections: fact.corrections || [],
  };
}

/**
 * Rebuild a persistable / QA-consumable report from the review model.
 *
 * The review screen edits `facts`; everything downstream (the QA gate, the saved
 * case record) still consumes the report shape, so this is the single place that
 * converts between them — including turning unresolved conflicts and rejected
 * facts into entries the QA gate can act on.
 */
export function reportFromReview(review) {
  const model = review && typeof review === 'object' ? review : {};
  const facts = Array.isArray(model.facts) ? model.facts : [];

  const confirmed = facts
    .filter((fact) => fact.status === 'confirmed' || fact.status === 'human_corrected')
    .filter((fact) => !fact.rejected)
    .map(toLegacyFact);

  const uncertain = facts.filter((fact) => fact.status === 'uncertain').map(toLegacyFact);

  const missing = (Array.isArray(model.missing) ? model.missing : []).map((entry) =>
    entry && typeof entry === 'object'
      ? { ...entry }
      : { field: entry, importance: 'medium', reason: '' }
  );

  const conflicts = Array.isArray(model.conflicts) ? model.conflicts : [];
  unresolvedConflicts(model).forEach((conflict) => {
    missing.push({
      field: conflict.field,
      importance: 'high',
      reason: conflict.reason || `Sources disagree on ${conflict.field}`,
      status: 'conflict',
    });
  });

  return {
    summary: model.summary || '',
    confirmed,
    uncertain,
    missing,
    conflicts,
    facts,
    follow_ups: Array.isArray(model.followUps) ? model.followUps : [],
  };
}
