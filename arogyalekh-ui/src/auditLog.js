/**
 * Tamper-evident append-only audit log.
 *
 * Spec requirement: "The audit system should be append-oriented/tamper-evident so
 * that historical actions cannot simply be deleted or silently rewritten", with a
 * "Who → Did What → To Which Patient/Case → When" record, filters
 * (actor, role, patient, case, action type, date/time) and previous→new values when
 * a field changed.
 *
 * HONEST LIMITATION — please read before relying on this for compliance:
 * entries are chained by hash so that editing, reordering or removing an entry breaks
 * the chain and `verifyLog()` reports exactly where. The default hash is a pure-JS
 * FNV-1a, which is used because it runs identically in the browser and in Node tests
 * with no dependency. FNV-1a is NOT collision-resistant: this detects accidental
 * corruption and naive edits, not a determined attacker who recomputes the chain.
 * For real tamper-evidence, inject a cryptographic hash, e.g.
 *   import { createHash } from 'node:crypto';
 *   const hash = (text) => createHash('sha256').update(text).digest('hex');
 * or SubtleCrypto's SHA-256 in the browser. The interface below accepts either.
 */

/** Pure-JS FNV-1a (32-bit) hash, returned as 8 hex characters. */
export function fnv1aHex(text) {
  let hash = 0x811c9dc5;
  const input = String(text);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const GENESIS_HASH = '0'.repeat(8);

/** Fields that make up an entry's immutable payload, in a stable order. */
export function entryPayload(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [
    entry.id ?? '',
    entry.timestamp ?? '',
    entry.actor ?? '',
    entry.role ?? '',
    entry.action ?? '',
    entry.patientId ?? '',
    entry.caseId ?? '',
    entry.level ?? '',
    entry.details ?? '',
    entry.prevHash ?? '',
  ];
  // Changes are part of the sealed payload: editing a diff must break the chain.
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  changes.forEach((change) => {
    parts.push(`${change.field ?? ''}:${change.from ?? ''}->${change.to ?? ''}`);
  });
  return parts.join('\u241f');
}

/** Hash one entry in the context of the entry before it. */
export function computeEntryHash(entry, prevHash, hashFn = fnv1aHex) {
  const sealed = { ...entry, prevHash: prevHash ?? GENESIS_HASH };
  return hashFn(`${GENESIS_HASH}|${prevHash ?? GENESIS_HASH}|${entryPayload(sealed)}`);
}

/**
 * Append an event. Returns a NEW log; the input is never mutated, so an existing
 * reference cannot be used to rewrite history in place.
 */
export function appendEntry(log, event, { hashFn = fnv1aHex } = {}) {
  const entries = Array.isArray(log) ? log : [];
  const previous = entries.length > 0 ? entries[entries.length - 1] : null;
  const prevHash = previous ? previous.hash : GENESIS_HASH;

  const base = {
    id: event?.id ?? (previous ? Number(previous.id) + 1 : 1),
    timestamp: event?.timestamp ?? '',
    actor: event?.actor ?? 'Unknown',
    role: event?.role ?? '',
    action: event?.action ?? '',
    patientId: event?.patientId ?? '',
    caseId: event?.caseId ?? '',
    level: event?.level ?? 'info',
    details: event?.details ?? '',
    changes: Array.isArray(event?.changes) ? event.changes.map((c) => ({ ...c })) : [],
    prevHash,
  };
  const hash = computeEntryHash(base, prevHash, hashFn);
  return [...entries, { ...base, hash }];
}

/**
 * Walk the chain and report whether it is intact.
 *
 * @returns {{valid: boolean, brokenAt: number|null, reason: string}}
 */
export function verifyLog(log, { hashFn = fnv1aHex } = {}) {
  const entries = Array.isArray(log) ? log : [];
  if (entries.length === 0) return { valid: true, brokenAt: null, reason: 'empty log' };

  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') {
      return { valid: false, brokenAt: i, reason: 'entry is not an object' };
    }
    if ((entry.prevHash ?? GENESIS_HASH) !== prevHash) {
      return { valid: false, brokenAt: i, reason: 'entry was reordered, removed or inserted' };
    }
    const expected = computeEntryHash({ ...entry, prevHash }, prevHash, hashFn);
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: i, reason: 'entry contents were modified after being written' };
    }
    prevHash = entry.hash;
  }
  return { valid: true, brokenAt: null, reason: 'chain intact' };
}

/** Compute a previous→new diff for a changed record. */
export function diffValues(before, after) {
  const changes = [];
  const keys = new Set([
    ...Object.keys(before && typeof before === 'object' ? before : {}),
    ...Object.keys(after && typeof after === 'object' ? after : {}),
  ]);
  keys.forEach((key) => {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    const fromText = from === null || from === undefined ? '' : String(from);
    const toText = to === null || to === undefined ? '' : String(to);
    if (fromText !== toText) changes.push({ field: key, from: fromText, to: toText });
  });
  return changes;
}

function withinRange(timestamp, from, to) {
  if (!from && !to) return true;
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) return false;
  if (from && value < Date.parse(from)) return false;
  if (to && value > Date.parse(to)) return false;
  return true;
}

/**
 * Filter events for the audit-log screen.
 * All criteria are optional and combine with AND; `search` matches loosely.
 */
export function filterEvents(log, filters = {}) {
  const entries = Array.isArray(log) ? log : [];
  const actor = (filters.actor || '').toLowerCase().trim();
  const role = (filters.role || '').toLowerCase().trim();
  const patient = String(filters.patientId ?? '').trim();
  const caseId = String(filters.caseId ?? '').trim();
  const action = (filters.action || '').toLowerCase().trim();
  const level = (filters.level || '').toLowerCase().trim();
  const search = (filters.search || '').toLowerCase().trim();

  return entries.filter((entry) => {
    if (!entry) return false;
    if (actor && !String(entry.actor || '').toLowerCase().includes(actor)) return false;
    if (role && String(entry.role || '').toLowerCase() !== role) return false;
    if (patient && String(entry.patientId ?? '') !== patient) return false;
    if (caseId && String(entry.caseId ?? '') !== caseId) return false;
    if (action && !String(entry.action || '').toLowerCase().includes(action)) return false;
    if (level && String(entry.level || '').toLowerCase() !== level) return false;
    if (!withinRange(entry.timestamp, filters.from, filters.to)) return false;
    if (search) {
      const haystack = `${entry.actor || ''} ${entry.action || ''} ${entry.details || ''} ${entry.patientId || ''} ${entry.caseId || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** Distinct values present in the log, for populating filter controls. */
export function filterFacets(log) {
  const entries = Array.isArray(log) ? log : [];
  const facets = { actors: new Set(), roles: new Set(), levels: new Set(), actions: new Set(), patientIds: new Set() };
  entries.forEach((entry) => {
    if (!entry) return;
    if (entry.actor) facets.actors.add(entry.actor);
    if (entry.role) facets.roles.add(entry.role);
    if (entry.level) facets.levels.add(entry.level);
    if (entry.action) facets.actions.add(entry.action);
    if (entry.patientId !== undefined && entry.patientId !== '') facets.patientIds.add(String(entry.patientId));
  });
  return {
    actors: [...facets.actors].sort(),
    roles: [...facets.roles].sort(),
    levels: [...facets.levels].sort(),
    actions: [...facets.actions].sort(),
    patientIds: [...facets.patientIds].sort(),
  };
}

/** Human-readable audit line: who did what to whom, when. */
export function describeEvent(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const actor = entry.actor || 'Unknown actor';
  const role = entry.role ? ` (${entry.role})` : '';
  const action = entry.action || 'did something';
  const target = entry.patientId !== '' && entry.patientId !== undefined
    ? ` on patient #${entry.patientId}`
    : entry.caseId !== '' && entry.caseId !== undefined
      ? ` on case #${entry.caseId}`
      : '';
  const when = entry.timestamp ? ` at ${entry.timestamp}` : '';
  return `${actor}${role} → ${action}${target}${when}`;
}
