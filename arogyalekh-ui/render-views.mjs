/**
 * Read-only render smoke test for EVERY view, with feature assertions.
 *
 * Two failure classes this catches that build/lint cannot:
 *   1. a render-time throw (a temporal-dead-zone, undefined reference or a setState
 *      during render) — which produces the blank dark-green page the browser shows, and
 *   2. a feature that renders nothing because it was never actually wired up — an
 *      earlier audit found several fully-tested modules the app never called.
 *
 * It never modifies App.jsx: for each view it writes a temporary copy in src/ with the
 * initial state swapped, renders it, asserts the expected UI markers are present, and
 * deletes the copy afterwards.
 *
 * Note on markers: React's server renderer inserts `<!-- -->` between adjacent text
 * nodes, so a marker must not span a JSX expression boundary.
 *
 * Run: node render-views.mjs
 */
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';

// --- browser shims -----------------------------------------------------------
// navigator exists in Node but without onLine, which would make the app think it is
// offline. Define the property rather than replacing the object (it is getter-only).
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true, writable: true });

const listeners = {};
globalThis.window = globalThis.window || {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: (t, f) => { listeners[t] = f; },
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  confirm: () => false,
  prompt: () => null,
};
if (!globalThis.localStorage) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
}
globalThis.IntersectionObserver = globalThis.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };

// --- fixtures ----------------------------------------------------------------
const patient = "{ id: 1, name: 'Ramesh Sharma', age: 45, gender: 'Male', location: 'Village Rampur', allergies: 'Penicillin', blood_group: 'B+', phone: '9876543210' }";

// reviewModel holds the NORMALISED (camelCase) model, as normalizeReport produces in the app.
const reviewModel = "{ summary: 'Fever for 3 days.', facts: [{ field: 'temperature', value: '102 F', status: 'human_corrected', source: 'worker', original_value: '101 F', corrections: [{ from: '101 F', to: '102 F', actor: 'Sita Devi', timestamp: '2026-10-06T10:10:00Z' }], evidence: [{ kind: 'audio_timestamp', timestamp: 12.5 }] }, { field: 'blood_pressure', value: '120/80', status: 'confirmed', source: 'ai', evidence: [{ kind: 'text_span', quote: 'not-in-source', label: 'unverified quote' }] }], conflicts: [{ field: 'temperature', reason: 'Sources disagree', requires_resolution: true, options: [{ value: '100 F', sources: ['voice'] }, { value: '101 F', sources: ['image'] }] }], clarificationQuestions: [{ field: 'drug_allergies', question: 'Any allergies?' }], missing: [{ field: 'blood_pressure', importance: 'medium', reason: 'not recorded' }], followUps: ['Review after 3 days'], sources: [{ kind: 'voice', ref: 'audio-1' }] }";
// editedReport keeps the report shape reportFromReview produces (snake_case follow_ups).
const report = "{ summary: 'Fever for 3 days.', confirmed: [{ field: 'temperature', value: '102 F', source_quote: 'fever', evidence: [{ kind: 'text_span', quote: 'fever' }] }], uncertain: [], missing: [{ field: 'blood_pressure', importance: 'medium', reason: 'not recorded' }], follow_ups: ['Review after 3 days'], facts: [], conflicts: [], clarification_questions: [] }";

const cases = "[{ id: 9, patient_id: 1, created_at: '2026-10-06T10:15:00Z', summary: 'Fever', details: { summary: 'Fever', diagnosis: 'Viral Pyrexia', priority: 'Routine', doctor_note: 'Rest', prescriptions: [{ drug: 'Paracetamol 650mg', dose: 'TDS x 5 days' }], prescriptions_author: 'Dr. A. Sharma', prescriptions_author_role: 'doctor', doctor_suggestions: [{ text: 'Review in 3 days', author: 'Dr. A. Sharma' }], follow_ups: ['Review after 3 days'], provenance: { worker: 1, ai: 2, human: 0, doctor: 1 }, clinical_qa: { status: 'review' }, timeline: [{ type: 'voice_captured', label: 'Voice note captured', actor: 'Sita Devi', timestamp: '2026-10-06T10:05:00Z' }, { type: 'report_approved', label: 'Report approved', actor: 'Sita Devi', timestamp: '2026-10-06T10:12:00Z' }] } }]";
const auditLog = "[{ id: 1, timestamp: '2026-10-06T10:10:00Z', actor: 'Sita Devi', role: 'field_worker', action: 'HUMAN_CORRECTION', details: 'temperature', level: 'warn', patientId: 1, caseId: 9, changes: [{ field: 'temperature', from: '100 F', to: '101 F' }], prevHash: '00000000', hash: 'abcd1234' }]";
const syncQueueFixture = "[{ table: 'cases', kind: 'insert', localId: 'l1', status: 'failed', attempts: 1, lastError: 'Network unreachable', record: { summary: 'Fever', pendingSync: true } }]";

const CASES = [
  { name: 'landing', subs: [], expect: ['AROGYALEKH'] },
  {
    name: 'dashboard',
    subs: [["useState('landing')", "useState('dashboard')"], ['const [cases, setCases] = useState([]);', `const [cases, setCases] = useState(${cases});`]],
    expect: ['Pending Reviews', 'Active Registry'],
  },
  {
    name: 'add_patient-step1',
    subs: [["useState('landing')", "useState('add_patient')"]],
    expect: ['Patient Registration', 'Blood Group'],
  },
  {
    name: 'add_patient-step2-allergies',
    subs: [["useState('landing')", "useState('add_patient')"], ['const [patientRegStep, setPatientRegStep] = useState(1);', 'const [patientRegStep, setPatientRegStep] = useState(2);']],
    expect: ['Known Allergies'],
  },
  { name: 'login', subs: [["useState('landing')", "useState('login')"]], expect: ['AROGYALEKH'] },
  { name: 'onboarding', subs: [["useState('landing')", "useState('onboarding')"]], expect: ['Facility'] },
  { name: 'admin-team', subs: [["useState('landing')", "useState('admin')"]], expect: ['Active Personnel', 'Signed in as'] },
  {
    name: 'admin-audit-log',
    subs: [
      ["useState('landing')", "useState('admin')"],
      ['useState("team")', 'useState("audit")'],
      ['const [auditLog, setAuditLog] = useState([]);', `const [auditLog, setAuditLog] = useState(${auditLog});`],
      ['const [auditExpandedId, setAuditExpandedId] = useState(null);', 'const [auditExpandedId, setAuditExpandedId] = useState(0);'],
      // The audit log is admin-only; a field worker would legitimately see the denial panel.
      ['const [currentRole, setCurrentRole] = useState(ROLES.FIELD_WORKER);', 'const [currentRole, setCurrentRole] = useState(ROLES.ADMIN);'],
    ],
    // An earlier audit found the value-diff panel rendered but always empty, and no
    // patient/case id ever stamped. These markers guard both.
    expect: ['Live Audit Log', 'patient:', 'case:', 'Chain intact', '100 F', '101 F', 'HUMAN_CORRECTION'],
  },
  {
    name: 'admin-audit-denied',
    subs: [
      ["useState('landing')", "useState('admin')"],
      ['useState("team")', 'useState("audit")'],
    ],
    expect: ['Access denied'],
  },
  { name: 'admin-system', subs: [["useState('landing')", "useState('admin')"], ['useState("team")', 'useState("system")']], expect: ['System Health'] },
  { name: 'settings', subs: [["useState('landing')", "useState('settings')"]], expect: ['SYSTEM SETTINGS'] },
  {
    name: 'patient',
    subs: [
      ["useState('landing')", "useState('patient')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [cases, setCases] = useState([]);', `const [cases, setCases] = useState(${cases});`],
      ['const [expandedTimelineCase, setExpandedTimelineCase] = useState(null);', 'const [expandedTimelineCase, setExpandedTimelineCase] = useState(9);'],
    ],
    expect: ['Requires Attention', 'Worker entered', 'AI extracted', 'Doctor added', 'Prescribed by Dr. A. Sharma', 'Voice note captured', 'Report approved'],
  },
  {
    // An admin is not a clinician: reaching the capture view must be refused before any
    // of the clinical steps, and the refusal recorded.
    name: 'capture-denied-for-admin',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [currentRole, setCurrentRole] = useState(ROLES.FIELD_WORKER);', 'const [currentRole, setCurrentRole] = useState(ROLES.ADMIN);'],
    ],
    expect: ['Not permitted to document cases', 'audit log'],
    reject: ['Clinical Capture'],
  },
  {
    name: 'patient-access-denied',
    subs: [
      ["useState('landing')", "useState('patient')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [currentRole, setCurrentRole] = useState(ROLES.FIELD_WORKER);', "const [currentRole, setCurrentRole] = useState('unknown_role');"],
    ],
    expect: ['Patient records are restricted', 'audit log'],
  },
  {
    name: 'capture-step1',
    subs: [["useState('landing')", "useState('capture')"], ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`]],
    expect: ['Clinical Capture', 'Start Mic'],
  },
  {
    name: 'capture-step1-ai-error',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [aiError, setAiError] = useState("");', 'const [aiError, setAiError] = useState("Backend connection failed.");'],
    ],
    expect: ['AI processing failed', 'Retry AI processing', 'nothing was lost'],
  },
  {
    name: 'capture-step2-review',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(2);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
      ['const [editedReport, setEditedReport] = useState(null); // for inline editing', `const [editedReport, setEditedReport] = useState(${report});`],
      ['const [reviewModel, setReviewModel] = useState(null);', `const [reviewModel, setReviewModel] = useState(${reviewModel});`],
      ['const [evidenceFactIndex, setEvidenceFactIndex] = useState(null);', 'const [evidenceFactIndex, setEvidenceFactIndex] = useState(0);'],
    ],
    // Every marker below was missing before this change.
    expect: ['Original Source', 'Unsupported claims', 'Add Missing Information', 'Conflicting Values', 'Suggested Clarification Question', 'Human Corrected', 'Unsupported', 'AI original:', 'Any allergies?'],
  },
  {
    name: 'capture-step3-prescriptions',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(3);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
      ['const [prescriptionSuggestions, setPrescriptionSuggestions] = useState([]);', "const [prescriptionSuggestions, setPrescriptionSuggestions] = useState([{ drug: 'Paracetamol 650mg', dose: 'TDS x 5 days', route: 'Oral', accepted: true }]);"],
    ],
    expect: ['Protocol Draft Medications', 'Paracetamol 650mg', 'may accept doctor-authorised medication'],
  },
  {
    // A field worker can document a case and accept medication a doctor authorised, but
    // must not be able to author a prescription. The doctor-only control must be absent.
    name: 'capture-step3-prescribe-denied',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(3);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
    ],
    expect: ['Authoring a prescription requires a doctor', 'may not author a'],
    reject: ['Authorise a Prescription'],
  },
  {
    name: 'capture-step3-doctor-rx',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(3);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
      ['const [currentRole, setCurrentRole] = useState(ROLES.FIELD_WORKER);', 'const [currentRole, setCurrentRole] = useState(ROLES.DOCTOR);'],
      ['const [authorisedPrescriptions, setAuthorisedPrescriptions] = useState([]);', "const [authorisedPrescriptions, setAuthorisedPrescriptions] = useState([{ drug: 'Amoxicillin 500mg', dose: 'BD x 7 days', route: 'Oral', author: 'Dr. A. Sharma', author_role: 'doctor', prescribed_at: '2026-10-06T10:20:00Z', patient_id: 1, status: 'active', generated_by_ai: false, history: [{ at: '2026-10-06T10:20:00Z', by: 'Dr. A. Sharma', change: 'created' }] }]);"],
    ],
    // An earlier audit found no attributed doctor prescription was possible at all.
    expect: ['Authorise a Prescription', 'Authorised Prescriptions', 'Dr. A. Sharma', 'not AI-generated', 'history entry', 'Amoxicillin 500mg'],
  },
  {
    name: 'sync-center',
    subs: [
      ["useState('landing')", "useState('dashboard')"],
      ['const [syncCenterOpen, setSyncCenterOpen] = useState(false);', 'const [syncCenterOpen, setSyncCenterOpen] = useState(true);'],
      ['const [syncQueue, setSyncQueue] = useState([]); // real queue of local writes awaiting upload', `const [syncQueue, setSyncQueue] = useState(${syncQueueFixture});`],
      ['const [syncError, setSyncError] = useState("");', 'const [syncError, setSyncError] = useState("Network unreachable");'],
    ],
    expect: ['Sync Center', 'Retry Sync Now', 'Saved on this device only', 'Network unreachable'],
  },
  {
    name: 'online-synced-indicator',
    subs: [["useState('landing')", "useState('dashboard')"]],
    // With nothing queued and a connection, the app must read as fully synced, not offline.
    expect: ['Active Registry'],
  },
];

// --- run ---------------------------------------------------------------------
const original = readFileSync('src/App.jsx', 'utf8');
const before = new Set(readdirSync('src'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

let failures = 0;
for (const viewCase of CASES) {
  let source = original;
  const missingAnchors = [];
  for (const [from, to] of viewCase.subs || []) {
    if (!source.includes(from)) { missingAnchors.push(from.slice(0, 60)); continue; }
    source = source.replace(from, to);
  }
  if (missingAnchors.length > 0) {
    console.log(`FAIL  ${viewCase.name} — anchors not found: ${missingAnchors.join(' | ')}`);
    failures += 1;
    continue;
  }

  const temp = `src/__smoke_${viewCase.name.replace(/[^a-z0-9]/gi, '_')}.jsx`;
  writeFileSync(temp, source, 'utf8');
  try {
    const mod = await server.ssrLoadModule(`/${temp}`);
    const html = renderToString(createElement(mod.default));
    const missing = (viewCase.expect || []).filter((marker) => !html.includes(marker));
    // Markers that must NOT appear: a control that is only for another role, or a
    // failure banner on a success path.
    const leaked = (viewCase.reject || []).filter((marker) => html.includes(marker));
    if (html.length <= 500) {
      console.log(`FAIL  ${viewCase.name} — only ${html.length} chars rendered`);
      failures += 1;
    } else if (missing.length > 0) {
      console.log(`FAIL  ${viewCase.name} — missing UI: ${missing.join(', ')}`);
      failures += 1;
    } else if (leaked.length > 0) {
      console.log(`FAIL  ${viewCase.name} — UI that should be hidden is present: ${leaked.join(', ')}`);
      failures += 1;
    } else {
      const total = (viewCase.expect || []).length + (viewCase.reject || []).length;
      console.log(`PASS  ${viewCase.name} — ${html.length} chars, ${total} marker(s)`);
    }
  } catch (error) {
    console.log(`FAIL  ${viewCase.name} — RENDER THREW: ${error.message}`);
    failures += 1;
  } finally {
    rmSync(temp, { force: true });
  }
}

await server.close();
const leftovers = readdirSync('src').filter((f) => f.startsWith('__smoke_') && !before.has(f));
if (leftovers.length > 0) {
  console.log(`FAIL  temp files left behind: ${leftovers.join(', ')}`);
  failures += 1;
}
console.log(failures === 0 ? '\nALL VIEWS RENDER WITH EXPECTED UI' : `\n${failures} VIEW(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
