/**
 * Roles and permissions.
 *
 * Spec requirement: access to patient information must be controlled by role;
 * only authorised users may create or modify prescriptions and doctor suggestions;
 * and the audit log is for authorised administrators. The spec also states doctors do
 * not need to approve every case — a doctor's involvement is a clinical intervention,
 * not a mandatory gate.
 *
 * None of this existed before: there were no role or permission checks anywhere in the
 * app, so every surface was reachable by anyone.
 *
 * Pure and dependency-free so it is unit testable.
 */

export const ROLES = {
  FIELD_WORKER: 'field_worker',
  DOCTOR: 'doctor',
  ADMIN: 'admin',
};

export const ALL_ROLES = Object.values(ROLES);

/** Human-readable role names for the UI. */
export const ROLE_LABELS = {
  field_worker: 'Field Worker',
  doctor: 'Doctor',
  admin: 'Administrator',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || 'Unknown role';
}

/**
 * Permissions per role.
 *
 * Deliberate design notes:
 *  - a field worker can document encounters and prescribe only medications a doctor
 *    has already authorised (`prescribe_authorised`), never free-form ones;
 *  - a doctor may create prescriptions and doctor suggestions, and may review cases,
 *    but cannot administer the audit log;
 *  - an admin runs the audit log and team access but is not a clinician, so cannot
 *    author prescriptions;
 *  - `view_audit_log` is admin-only because the spec scopes it to administrators.
 */
export const PERMISSIONS = {
  field_worker: new Set([
    'view_patients',
    'create_patient',
    'create_case',
    'edit_case',
    'approve_report',
    'view_prescriptions',
    'prescribe_authorised',
    'resolve_conflicts',
    'sync_offline_records',
  ]),
  doctor: new Set([
    'view_patients',
    'create_case',
    'edit_case',
    'approve_report',
    'view_prescriptions',
    'create_prescription',
    'create_doctor_suggestion',
    'resolve_conflicts',
    'sync_offline_records',
  ]),
  admin: new Set([
    'view_patients',
    'view_audit_log',
    'manage_team',
    'sync_offline_records',
  ]),
};

/** All permission names, useful for tests and admin screens. */
export function allPermissions() {
  const names = new Set();
  Object.values(PERMISSIONS).forEach((set) => set.forEach((name) => names.add(name)));
  return [...names].sort();
}

export function isValidRole(role) {
  return ALL_ROLES.includes(role);
}

/**
 * Check one permission.
 *
 * Fails closed: an unknown, missing or malformed role has no permissions, so a bug
 * upstream cannot silently grant clinical rights.
 */
export function can(role, permission) {
  if (!isValidRole(role) || !permission) return false;
  return PERMISSIONS[role].has(permission);
}

/** List a role's permissions (empty for an unknown role). */
export function permissionsFor(role) {
  if (!isValidRole(role)) return [];
  return [...PERMISSIONS[role]].sort();
}

/**
 * Requirement check used by screens and handlers.
 *
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAccess(role, permission) {
  if (!permission) return { allowed: false, reason: 'No permission was specified.' };
  if (!isValidRole(role)) {
    return { allowed: false, reason: `Unknown role "${role ?? 'none'}": access denied. Sign in with a valid role.` };
  }
  if (!can(role, permission)) {
    return {
      allowed: false,
      reason: `${roleLabel(role)} is not permitted to ${String(permission).replace(/_/g, ' ')}.`,
    };
  }
  return { allowed: true, reason: 'Allowed.' };
}

/** Convenience guards for the three surfaces the spec calls out. */
export const canViewPatientRecords = (role) => can(role, 'view_patients');
export const canPrescribe = (role) => can(role, 'create_prescription') || can(role, 'prescribe_authorised');
export const canAuthorPrescription = (role) => can(role, 'create_prescription');
export const canViewAuditLog = (role) => can(role, 'view_audit_log');
export const canManageTeam = (role) => can(role, 'manage_team');

/**
 * Attribute a prescription or suggestion to the person who authored it.
 *
 * Spec: these records "must be clearly attributed to the doctor and should never
 * appear as though they were generated or approved by the AI". This refuses to create
 * an authorised prescription without an identified author.
 */
export function attributeToAuthor(role, author, record = {}) {
  const name = typeof author === 'string' ? author.trim() : '';
  if (!canAuthorPrescription(role)) {
    return {
      ok: false,
      reason: `${roleLabel(role)} cannot author a prescription or doctor suggestion.`,
      record: null,
    };
  }
  if (!name) {
    return {
      ok: false,
      reason: 'An identified author is required: prescriptions must never be attributed to the AI.',
      record: null,
    };
  }
  return {
    ok: true,
    reason: 'Attributed.',
    record: {
      ...record,
      author: name,
      author_role: role,
      provenance: 'doctor',
      // Explicit so no renderer can mistake this for an AI suggestion.
      generated_by_ai: false,
    },
  };
}

/**
 * Whether a case needs a doctor's review. The spec is explicit that doctors do not
 * approve every case, so this is a triage hint, not a gate.
 */
export function requiresDoctorReview({ priority = '', conflicts = [], qaStatus = '' } = {}) {
  const reasons = [];
  if (String(priority).toLowerCase() === 'urgent') reasons.push('Case is marked Urgent.');
  if (Array.isArray(conflicts) && conflicts.length > 0) reasons.push(`${conflicts.length} unresolved conflict(s).`);
  if (qaStatus === 'blocked') reasons.push('Clinical QA has blocking findings.');
  return { required: reasons.length > 0, reasons };
}

/** Doctor suggestions are optional by design; an empty list is a valid state. */
export function doctorSuggestionState(suggestions, role) {
  if (!canViewPatientRecords(role)) {
    return { visible: false, emptyMessage: 'You do not have access to patient records.' };
  }
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (list.length === 0) {
    return {
      visible: true,
      emptyMessage: 'No doctor suggestions for this case. Most cases do not require clinical review.',
    };
  }
  return { visible: true, emptyMessage: '' };
}
