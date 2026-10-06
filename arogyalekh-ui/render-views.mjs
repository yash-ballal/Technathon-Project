/**
 * Read-only render smoke test for EVERY view.
 *
 * The blank-page bug just found ("Cannot access 'addAuditEvent' before initialization")
 * was a render-time throw, which `npm run build` cannot catch — esbuild/rollup don't
 * evaluate temporal dead zones. A static render of only the landing view would have
 * missed it in every other screen too, so this renders each view's JSX path.
 *
 * It never modifies App.jsx: for each view it writes a temporary copy in src/ with the
 * initial state swapped, renders it, and deletes the copy afterwards.
 *
 * Run: node render-views.mjs
 */
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

// --- browser shims -----------------------------------------------------------
const listeners = {};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
}
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

// --- the views to exercise ---------------------------------------------------
const patient = "{ id: 1, name: 'Ramesh Sharma', age: 45, gender: 'Male', location: 'Village Rampur', allergies: 'Penicillin', blood_group: 'B+' }";
const report = "{ summary: 'Fever for 3 days.', confirmed: [{ field: 'temperature', value: '101 F', source_quote: 'fever', evidence: [{ kind: 'text_span', quote: 'fever' }] }], uncertain: [], missing: [{ field: 'blood_pressure', importance: 'medium', reason: 'not recorded' }], follow_ups: ['Review after 3 days'], facts: [{ field: 'temperature', value: '101 F', status: 'confirmed', source: 'ai', evidence: [{ kind: 'audio_timestamp', timestamp: 12.5 }] }], conflicts: [{ field: 'temperature', reason: 'Sources disagree', requires_resolution: true, options: [{ value: '100 F', sources: ['voice'] }, { value: '101 F', sources: ['image'] }] }], clarification_questions: [{ field: 'drug_allergies', question: 'Any allergies?' }] }";

const CASES = [
  { name: 'landing', subs: [] },
  { name: 'dashboard', subs: [["useState('landing')", "useState('dashboard')"]] },
  { name: 'add_patient', subs: [["useState('landing')", "useState('add_patient')"]] },
  { name: 'login', subs: [["useState('landing')", "useState('login')"]] },
  { name: 'onboarding', subs: [["useState('landing')", "useState('onboarding')"]] },
  { name: 'admin', subs: [["useState('landing')", "useState('admin')"]] },
  { name: 'settings', subs: [["useState('landing')", "useState('settings')"]] },
  {
    name: 'patient',
    subs: [["useState('landing')", "useState('patient')"], ['useState(null); // for inline editing', 'useState(null);'], ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`]],
  },
  {
    name: 'capture-step1',
    subs: [["useState('landing')", "useState('capture')"], ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`]],
  },
  {
    name: 'capture-step2 (review screen)',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(2);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
      ['const [editedReport, setEditedReport] = useState(null); // for inline editing', `const [editedReport, setEditedReport] = useState(${report});`],
      ['const [reviewModel, setReviewModel] = useState(null);', `const [reviewModel, setReviewModel] = useState(${report});`],
    ],
  },
  {
    name: 'capture-step3 (prescriptions)',
    subs: [
      ["useState('landing')", "useState('capture')"],
      ['const [selectedPatient, setSelectedPatient] = useState(null);', `const [selectedPatient, setSelectedPatient] = useState(${patient});`],
      ['const [caseStep, setCaseStep] = useState(1);', 'const [caseStep, setCaseStep] = useState(3);'],
      ['const [report, setReport] = useState(null);', `const [report, setReport] = useState(${report});`],
      ['const [prescriptionSuggestions, setPrescriptionSuggestions] = useState([]);', "const [prescriptionSuggestions, setPrescriptionSuggestions] = useState([{ drug: 'Paracetamol 650mg', dose: 'TDS x 5 days', route: 'Oral', accepted: true }]);"],
    ],
  },
];

const original = readFileSync('src/App.jsx', 'utf8');
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });

let failures = 0;
for (const viewCase of CASES) {
  let source = original;
  let missing = [];
  for (const [from, to] of viewCase.subs || []) {
    if (!source.includes(from)) { missing.push(from); continue; }
    source = source.replace(from, to);
  }
  if (missing.length > 0) {
    console.log(`FAIL  ${viewCase.name} — anchors not found: ${missing.join(' | ')}`);
    failures += 1;
    continue;
  }

  const temp = `src/__smoke_${viewCase.name.replace(/[^a-z0-9]/gi, '_')}.jsx`;
  writeFileSync(temp, source, 'utf8');
  try {
    const mod = await server.ssrLoadModule(`/${temp}`);
    const html = renderToString(createElement(mod.default));
    const meaningful = html.length > 500;
    console.log(`${meaningful ? 'PASS' : 'FAIL'}  ${viewCase.name} — ${html.length} chars`);
    if (!meaningful) failures += 1;
  } catch (error) {
    console.log(`FAIL  ${viewCase.name} — RENDER THREW: ${error.message}`);
    failures += 1;
  } finally {
    rmSync(temp, { force: true });
  }
}

await server.close();
console.log(failures === 0 ? '\nALL VIEWS RENDER' : `\n${failures} VIEW(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
