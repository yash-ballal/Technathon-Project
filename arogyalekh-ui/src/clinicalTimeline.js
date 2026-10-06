/**
 * Case history / timeline and provenance.
 *
 * Spec requirement: show a chronological view of what happened (patient registration,
 * case creation, voice or image capture, AI extraction, evidence processing,
 * missing-information detection, conflict detection, worker corrections, report
 * approval, doctor suggestions, prescription creation, submission, synchronisation),
 * each event carrying timestamp, actor, action and associated case — e.g.
 *   "10:05 — Voice note captured", "10:08 — Temperature conflict detected",
 *   "10:10 — Worker corrected temperature", "10:12 — Report approved".
 * Historical events must not be silently modifiable.
 *
 * Pure and dependency-free so it is unit testable.
 */

/** Event kinds the timeline knows how to describe. */
export const EVENT_TYPES = {
  PATIENT_REGISTERED: 'patient_registered',
  CASE_CREATED: 'case_created',
  VOICE_CAPTURED: 'voice_captured',
  IMAGE_CAPTURED: 'image_captured',
  TEXT_CAPTURED: 'text_captured',
  AI_EXTRACTION_STARTED: 'ai_extraction_started',
  AI_EXTRACTION_COMPLETED: 'ai_extraction_completed',
  EVIDENCE_PROCESSED: 'evidence_processed',
  MISSING_DETECTED: 'missing_detected',
  CONFLICT_DETECTED: 'conflict_detected',
  CONFLICT_RESOLVED: 'conflict_resolved',
  HUMAN_CORRECTION: 'human_correction',
  AI_OUTPUT_REJECTED: 'ai_output_rejected',
  CLARIFICATION_RAISED: 'clarification_raised',
  PRESCRIPTION_CREATED: 'prescription_created',
  DOCTOR_SUGGESTION: 'doctor_suggestion',
  REPORT_APPROVED: 'report_approved',
  CASE_SUBMITTED: 'case_submitted',
  SYNCHRONISED: 'synchronised',
  QA_RUN: 'qa_run',
  QA_BLOCKED: 'qa_blocked',
  QA_OVERRIDE: 'qa_override',
};

/** Human-readable labels, matching the spec's example wording style. */
export const EVENT_LABELS = {
  patient_registered: 'Patient registered',
  case_created: 'Case created',
  voice_captured: 'Voice note captured',
  image_captured: 'Image captured',
  text_captured: 'Notes entered',
  ai_extraction_started: 'AI extraction started',
  ai_extraction_completed: 'AI extraction completed',
  evidence_processed: 'Evidence processed',
  missing_detected: 'Missing information detected',
  conflict_detected: 'Conflict detected',
  conflict_resolved: 'Conflict resolved',
  human_correction: 'Worker corrected data',
  ai_output_rejected: 'AI output rejected',
  clarification_raised: 'Clarification question raised',
  prescription_created: 'Prescription created',
  doctor_suggestion: 'Doctor suggestion added',
  report_approved: 'Report approved',
  case_submitted: 'Case submitted',
  synchronised: 'Record synchronised',
  qa_run: 'Clinical QA run',
  qa_blocked: 'Clinical QA blocked signing',
  qa_override: 'Clinical QA override recorded',
};

export function eventLabel(type) {
  return EVENT_LABELS[type] || String(type || 'Event').replace(/_/g, ' ');
}

/** Events that must never be editable once written. */
export const IMMUTABLE_TYPES = new Set([
  EVENT_TYPES.AI_EXTRACTION_COMPLETED,
  EVENT_TYPES.HUMAN_CORRECTION,
  EVENT_TYPES.CONFLICT_RESOLVED,
  EVENT_TYPES.REPORT_APPROVED,
  EVENT_TYPES.CASE_SUBMITTED,
  EVENT_TYPES.QA_OVERRIDE,
  EVENT_TYPES.AI_OUTPUT_REJECTED,
]);

/**
 * Create a timeline event.
 *
 * @throws when an immutable event would be created without an actor or timestamp,
 *         because an unattributed clinical action is not auditable.
 */
export function makeEvent(type, { actor = '', timestamp = '', caseId = '', patientId = '', details = '', data = {} } = {}) {
  if (!type) throw new Error('Event type is required');
  if (IMMUTABLE_TYPES.has(type)) {
    if (!actor) throw new Error(`${eventLabel(type)} requires an actor`);
    if (!timestamp) throw new Error(`${eventLabel(type)} requires a timestamp`);
  }
  return {
    type,
    label: eventLabel(type),
    actor: actor || 'System',
    timestamp,
    caseId,
    patientId,
    details,
    data: data && typeof data === 'object' ? { ...data } : {},
  };
}

/** Append an event. Returns a new array; history is never mutated in place. */
export function appendEvent(events, event) {
  const list = Array.isArray(events) ? events : [];
  if (!event || !event.type) return list;
  return [...list, event];
}

/**
 * Order events chronologically (oldest first), leaving events without a usable
 * timestamp in their original relative order at the end.
 */
export function sortTimeline(events) {
  const list = Array.isArray(events) ? events : [];
  const stamped = [];
  const unstamped = [];
  list.forEach((event, index) => {
    if (!event) return;
    const value = Date.parse(event.timestamp);
    if (Number.isNaN(value)) unstamped.push({ event, index });
    else stamped.push({ event, value, index });
  });
  stamped.sort((a, b) => (a.value - b.value) || (a.index - b.index));
  return [...stamped.map((entry) => entry.event), ...unstamped.map((entry) => entry.event)];
}

/** Short clock time for display, e.g. "10:05". */
export function formatEventTime(timestamp) {
  if (!timestamp) return '';
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return String(timestamp);
  return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * One timeline line in the spec's form: "10:05 — Voice note captured (Sita Devi)".
 * The actor is included so responsibility is visible, not just the action.
 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const time = formatEventTime(event.timestamp);
  const label = event.label || eventLabel(event.type);
  const actor = event.actor && event.actor !== 'System' ? ` (${event.actor})` : '';
  const details = event.details ? ` — ${event.details}` : '';
  return `${time ? `${time} — ` : ''}${label}${actor}${details}`;
}

/**
 * Build a full timeline for a case from its parts.
 *
 * `groups` are arrays of already-made events (capture, extraction, review, approval),
 * which is how the app records them as the workflow proceeds.
 */
export function buildCaseTimeline({ patient = null, caseRecord = null, groups = [], extra = [] } = {}) {
  let events = [];

  if (patient) {
    events = appendEvent(
      events,
      makeEvent(EVENT_TYPES.PATIENT_REGISTERED, {
        actor: patient.created_by || 'System',
        timestamp: patient.created_at || '',
        patientId: patient.id,
        details: patient.name || '',
      })
    );
  }

  if (caseRecord) {
    events = appendEvent(
      events,
      makeEvent(EVENT_TYPES.CASE_CREATED, {
        actor: caseRecord.created_by || 'System',
        timestamp: caseRecord.created_at || '',
        caseId: caseRecord.id,
        patientId: caseRecord.patient_id,
      })
    );
  }

  (Array.isArray(groups) ? groups : []).forEach((group) => {
    (Array.isArray(group) ? group : []).forEach((event) => {
      events = appendEvent(events, event);
    });
  });

  (Array.isArray(extra) ? extra : []).forEach((event) => {
    events = appendEvent(events, event);
  });

  return sortTimeline(events);
}

/**
 * Detect an attempt to rewrite history.
 *
 * The timeline is append-only: a caller wanting to change an event must add a new
 * correcting event instead. This reports exactly which events were altered so the
 * caller can refuse the write.
 */
export function detectHistoryRewrite(original, candidate) {
  const before = Array.isArray(original) ? original : [];
  const after = Array.isArray(candidate) ? candidate : [];

  if (after.length < before.length) {
    return {
      tampered: true,
      reason: `Timeline would lose ${before.length - after.length} historical event(s).`,
      indices: [],
    };
  }

  const indices = [];
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i];
    const b = after[i];
    if (!b) {
      indices.push(i);
      continue;
    }
    const changed =
      a.type !== b.type ||
      a.actor !== b.actor ||
      a.timestamp !== b.timestamp ||
      a.details !== b.details ||
      a.caseId !== b.caseId ||
      a.patientId !== b.patientId;
    if (changed) indices.push(i);
  }

  if (indices.length > 0) {
    return {
      tampered: true,
      reason: `Historical event(s) at position ${indices.join(', ')} were modified. Add a new event instead.`,
      indices,
    };
  }

  return { tampered: false, reason: 'Append-only: existing events are unchanged.', indices: [] };
}

/** Provenance for a value, as the patient profile must distinguish. */
export const PROVENANCE = {
  WORKER: 'worker',
  AI: 'ai',
  HUMAN: 'human',
  DOCTOR: 'doctor',
};

export const PROVENANCE_LABELS = {
  worker: 'Entered by worker',
  ai: 'Extracted by AI',
  human: 'Corrected by human',
  doctor: 'Added by doctor',
};

export function provenanceLabel(kind) {
  return PROVENANCE_LABELS[kind] || 'Source unknown';
}

/** Roll up provenance counts so the profile can show what came from where. */
export function provenanceSummary(facts) {
  const counts = { worker: 0, ai: 0, human: 0, doctor: 0 };
  (Array.isArray(facts) ? facts : []).forEach((fact) => {
    const kind = fact?.provenance || fact?.source;
    if (counts[kind] !== undefined) counts[kind] += 1;
  });
  return counts;
}

/** Pending follow-ups and items needing attention, for the profile overview. */
export function attentionItems({ cases = [], conflicts = [], followUps = [], qaStatus = '' } = {}) {
  const items = [];

  (Array.isArray(followUps) ? followUps : []).forEach((text) => {
    if (text) items.push({ kind: 'follow_up', label: 'Pending follow-up', detail: String(text) });
  });

  (Array.isArray(conflicts) ? conflicts : []).forEach((conflict) => {
    if (conflict?.requires_resolution !== false) {
      items.push({
        kind: 'conflict',
        label: 'Unresolved conflict',
        detail: String(conflict?.field || '').replace(/_/g, ' '),
      });
    }
  });

  if (qaStatus === 'blocked') {
    items.push({ kind: 'qa', label: 'Case requires attention', detail: 'Clinical QA has blocking findings' });
  }

  const unsynced = (Array.isArray(cases) ? cases : []).filter((c) => c && (c.pendingSync || c.localOnly));
  if (unsynced.length > 0) {
    items.push({ kind: 'sync', label: 'Not yet synchronised', detail: `${unsynced.length} case(s) on this device only` });
  }

  return items;
}

/** Empty-state text for the timeline, so the panel is never blank. */
export function timelineEmptyMessage(events) {
  return (Array.isArray(events) ? events : []).length === 0
    ? 'No events recorded for this case yet. Capture notes or a photograph to begin.'
    : '';
}
