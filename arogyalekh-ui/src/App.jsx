import { useState, useEffect, useRef, useCallback } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { supabase } from './supabaseClient';
import { runClinicalQa, qaAuditSnapshot, formatMissingItem, formatFactValue } from './clinicalQa';
import {
  buildPatientRecord,
  findDuplicatePatients,
  displayClinicalValue,
} from './patientRegistry';
import {
  normalizeReport,
  applyCorrection,
  rejectFact,
  resolveConflict,
  pendingReviewItems,
  statusCounts,
  statusMeta,
  evidenceText,
  reportFromReview,
  isUnsupported,
} from './clinicalReview';
import {
  ROLES,
  ROLE_LABELS,
  roleLabel,
  can,
  canPrescribe,
  canViewAuditLog,
  checkAccess,
  attributeToAuthor,
  doctorSuggestionState,
} from './roles';
import {
  appendEntry,
  verifyLog,
  filterEvents,
  filterFacets,
  describeEvent,
} from './auditLog';
import {
  enqueue,
  overallSyncState,
  flushQueue,
  pendingOperations,
  failedOperations,
  operationKey,
  storageOrigin,
  originLabel,
  syncStateMeta,
  syncCenterEmptyMessage,
  SYNC_STATE,
} from './syncQueue';
import {
  EVENT_TYPES,
  makeEvent,
  buildCaseTimeline,
  describeEvent as describeTimelineEvent,
  provenanceSummary,
  attentionItems,
  detectHistoryRewrite,
} from './clinicalTimeline';
import './App.css';

gsap.registerPlugin(ScrollTrigger);

// The audit log is persisted so history survives a reload (spec: append-oriented
// accountability record, not a per-session console).
const AUDIT_STORAGE_KEY = 'arogyalekh_audit_log';

export default function App() {
  // Navigation & View States
  const [view, setView] = useState('landing');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [toastType, setToastType] = useState("success"); // success | error | warning | info

  // Minimal Opening Animation Stages:
  // 0: Initial frame (0.0s): EMPTY dark green screen + ONLY 4 small mint squares in corners (no boxes, no words, no grid)
  // 1: Phase 1 (0.35s): 4 squares glide smoothly inward toward center (staying small)
  // 2: Phase 2 (1.3s): AROGYALEKH logo reveals in center directly on dark green background (NO BOX, NO GRID)
  // 3: Phase 3 (2.2s): Logo slides upward smoothly (translateY)
  // 4: Settled Landing Page (3.0s): Seamless transition to Section 1 ("Healthcare documentation" / CAPTURE-STRUCTURE-VERIFY-CARE / asha1.jpg / "made simpler.")
  const [introStage, setIntroStage] = useState(0);

  // Existing Patient & Case States
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [patients, setPatients] = useState([]);
  const [cases, setCases] = useState([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  // Existing Case Extraction States
  const [inputText, setInputText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [report, setReport] = useState(null);
  const [loadingAI, setLoadingAI] = useState(false);
  const [aiError, setAiError] = useState("");

  // New Case Workflow States
  const [caseStep, setCaseStep] = useState(1); // 1: Input, 2: AI Review, 3: Prescription, 4: Approve
  const [editedReport, setEditedReport] = useState(null); // for inline editing
  const [prescriptionSuggestions, setPrescriptionSuggestions] = useState([]);
  const [doctorNote, setDoctorNote] = useState("");
  const [selectedDiagnosis, setSelectedDiagnosis] = useState("");
  const [caseCategory, setCaseCategory] = useState("OPD");
  const [casePriority, setCasePriority] = useState("Routine");

  // Clinical review model (statuses, evidence, conflicts) backing the review screen
  const [reviewModel, setReviewModel] = useState(null);
  const [evidenceFactIndex, setEvidenceFactIndex] = useState(null);
  // Event-level case history, captured as the workflow proceeds
  const [captureEvents, setCaptureEvents] = useState([]);
  const [reviewEvents, setReviewEvents] = useState([]);
  const [caseStartedAt, setCaseStartedAt] = useState("");
  const [expandedTimelineCase, setExpandedTimelineCase] = useState(null);
  // Add-missing-information inputs on the review screen
  const [newFactField, setNewFactField] = useState("");
  const [newFactValue, setNewFactValue] = useState("");
  // Doctor-authored prescriptions for the current encounter
  const [rxDrug, setRxDrug] = useState("");
  const [rxDose, setRxDose] = useState("");
  const [authorisedPrescriptions, setAuthorisedPrescriptions] = useState([]);

  // Enhanced Patient Registration States
  const [newPatientName, setNewPatientName] = useState("");
  const [newPatientAge, setNewPatientAge] = useState("");
  const [newPatientGender, setNewPatientGender] = useState("Male");
  const [newPatientLocation, setNewPatientLocation] = useState("");
  const [newPatientPhone, setNewPatientPhone] = useState("");
  const [newPatientBloodGroup, setNewPatientBloodGroup] = useState("");
  const [newPatientAllergies, setNewPatientAllergies] = useState("");
  const [newPatientEmergencyContact, setNewPatientEmergencyContact] = useState("");
  const [newPatientAbhaId, setNewPatientAbhaId] = useState("");
  const [isSubmittingPatient, setIsSubmittingPatient] = useState(false);
  const [patientRegStep, setPatientRegStep] = useState(1); // 1: Basic, 2: Medical, 3: Confirm

  // Auth States (Preserved in authentication area)
  const [isSignUp, setIsSignUp] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");

  // Onboarding States
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [clinicName, setClinicName] = useState("Rampur Community Health Center");
  const [phcCode, setPhcCode] = useState("PHC-UP-8842");
  const [primaryDialect, setPrimaryDialect] = useState("Hinglish & Regional Dialects (en-IN)");

  // Admin Tab State
  const [adminTab, setAdminTab] = useState("team");

  // Role state (spec: patient access, prescriptions and the audit log are role-gated).
  // Chosen at sign-in; defaults to field worker so a fresh session is least-privileged
  // for clinical actions while still able to document.
  const [currentRole, setCurrentRole] = useState(ROLES.FIELD_WORKER);

  // Audit log filters (spec: filter by actor, role, patient, case, action, date/time)
  const [auditFilters, setAuditFilters] = useState({
    actor: "", role: "", patientId: "", caseId: "", action: "", from: "", to: "", search: "",
  });
  // Expanded audit entry (spec: show previous and new value when a field changed)
  const [auditExpandedId, setAuditExpandedId] = useState(null);

  // Offline / Network State
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncQueue, setSyncQueue] = useState([]); // real queue of local writes awaiting upload
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [syncCenterOpen, setSyncCenterOpen] = useState(false);

  // Audit Log State (append-only, hash-chained)
  const [auditLog, setAuditLog] = useState([]);
  const [auditIntegrity, setAuditIntegrity] = useState({ valid: true, brokenAt: null, reason: "chain intact" });

  // ==========================================
  // AUDIT LOG HELPERS
  // ==========================================
  // Declared before the synchronisation helpers below, which call it. Placing it after
  // them left `addAuditEvent` in its temporal dead zone during render, which threw and
  // rendered a blank page.
  // Signature: (action, details, level, changes, context)
  //   changes: [{ field, from, to }]  — field-level edits, shown in the audit detail view
  //   context: { patientId, caseId }  — the "to which patient/case" half of the record
  const addAuditEvent = useCallback((action, details = "", level = "info", changes = [], context = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      actor: authEmail || "Field Worker",
      role: currentRole,
      action,
      details,
      level, // info | warn | error | success
      changes: Array.isArray(changes) ? changes : [],
      patientId: context?.patientId ?? "",
      caseId: context?.caseId ?? "",
    };
    // Append-only, hash-chained: history cannot be rewritten in place, and verifyLog()
    // reports exactly where any edit or removal happened.
    setAuditLog((prev) => {
      const next = appendEntry(prev, entry);
      setAuditIntegrity(verifyLog(next));
      try {
        localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable or full: the log still works for this session.
      }
      return next;
    });
  }, [authEmail, currentRole]);

  /**
   * Enforce a permission and record the refusal.
   * Spec: the audit log must record unauthorised access attempts.
   */
  // Pure: safe to call during render. It must NOT call setState, or rendering a view
  // the role cannot see would trigger an infinite re-render loop.
  const requireAccess = useCallback((permission) => checkAccess(currentRole, permission).allowed, [currentRole]);

  /**
   * Report a refused access attempt.
   *
   * Called from an effect (never during render) so recording the denial cannot cause a
   * render loop, while the attempt is still captured in the audit log.
   */
  const recordDeniedAccess = useCallback((permission, what, context = {}) => {
    const decision = checkAccess(currentRole, permission);
    addAuditEvent("ACCESS_DENIED", `${what}: ${decision.reason}`, "error", [], context);
    showToast(decision.reason, "error");
  }, [currentRole, addAuditEvent]);

  // ==========================================
  // CASE TIMELINE HELPERS
  // ==========================================
  // Declared before the synchronisation helpers below, which append a SYNCHRONISED
  // event to a case. Placing them after would leave appendCaseEvent in its temporal
  // dead zone during render and throw a blank page.
  /**
   * Refuse to persist a timeline whose history was altered.
   * Spec: "The timeline should not allow users to silently modify historical events."
   */
  const guardTimelineRewrite = useCallback((originalEvents, nextEvents) => {
    const verdict = detectHistoryRewrite(originalEvents || [], nextEvents || []);
    if (verdict.tampered) {
      addAuditEvent("TIMELINE_REWRITE_BLOCKED", verdict.reason, "error");
      showToast("History cannot be modified: " + verdict.reason, "error");
      return false;
    }
    return true;
  }, [addAuditEvent]);

  /**
   * Append an event to an already-saved case's timeline.
   *
   * The timeline is append-only: adding to it is allowed, rewriting it is not (see
   * guardTimelineRewrite). Used for actions that happen after a case is signed.
   */
  const appendCaseEvent = useCallback((caseId, event) => {
    setCases((prev) => prev.map((entry) => {
      if (entry.id !== caseId) return entry;
      const existing = Array.isArray(entry.details?.timeline) ? entry.details.timeline : [];
      const nextTimeline = [...existing, event];
      // Append-only: the guard refuses if saving this would alter or drop any event
      // already on record (spec: history must not be silently modifiable).
      if (!guardTimelineRewrite(existing, nextTimeline)) return entry;
      return { ...entry, details: { ...entry.details, timeline: nextTimeline } };
    }));
  }, [guardTimelineRewrite]);

  // ==========================================
  // OFFLINE DETECTION + REAL SYNCHRONISATION
  // ==========================================
  /** Send one queued operation to the server. Throws on failure so the queue can react. */
  const sendQueuedOperation = useCallback(async (operation) => {
    const record = operation?.record || {};
    const table = operation?.table || 'cases';
    const { error } = await supabase.from(table).insert([record]);
    if (error) throw new Error(error.message || "Upload rejected by the server.");
    return true;
  }, []);

  // Flush the queue oldest-first. Stops at the first failure and keeps everything
  // unsent, so nothing is lost and the error is actionable.
  const runSync = useCallback(async (queue, reason = "manual") => {
    setSyncBusy(true);
    setSyncError("");
    try {
      const result = await flushQueue(queue, sendQueuedOperation, { online: navigator.onLine });
      setSyncQueue(result.queue);
      if (result.synced.length > 0) {
        addAuditEvent("SYNC_COMPLETED", `${result.synced.length} record(s) uploaded (${reason})`, "success", [], {});
        showToast(`${result.synced.length} record(s) synchronised.`, "success");
        // Spec: synchronisation is part of the case timeline. Each flushed operation's
        // record carries its case, so the event can be attached where it belongs.
        (queue || []).forEach((operation) => {
          if (!result.synced.includes(operationKey(operation))) return;
          const caseId = operation?.record?.case_id;
          if (operation?.table === 'cases' && caseId) {
            appendCaseEvent(caseId, makeEvent(EVENT_TYPES.SYNCHRONISED, {
              actor: 'System',
              timestamp: new Date().toISOString(),
              caseId,
              patientId: operation.record.patient_id,
              details: `Uploaded to the server (${reason})`,
            }));
          }
          // A case created offline has no id until the server assigns one, so it has no
          // timeline yet to attach to. Its upload is still recorded in the audit log
          // above, which is where that sync event is visible.
        });
      }
      if (result.stopped && result.reason && result.reason !== "offline" && result.synced.length === 0) {
        setSyncError(result.reason);
        addAuditEvent("SYNC_FAILED", result.reason, "error");
      }
      return result;
    } finally {
      setSyncBusy(false);
    }
  }, [addAuditEvent, sendQueuedOperation, appendCaseEvent]);

  // Keep a ref so the online listener always flushes the current queue without
  // re-registering listeners on every queue change.
  const syncQueueRef = useRef([]);
  useEffect(() => { syncQueueRef.current = syncQueue; }, [syncQueue]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      const queued = syncQueueRef.current;
      if (queued.length > 0) {
        showToast("Connection restored. Syncing queued records...", "success");
        runSync(queued, "reconnect");
      } else {
        showToast("Connection restored.", "success");
      }
    };
    const handleOffline = () => {
      setIsOnline(false);
      showToast("You are offline. Records will be saved locally.", "warning");
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [runSync]);

  /**
   * Persist a clinical record: straight to the server when online, otherwise queue it
   * locally so the worker is never blocked and nothing is lost.
   */
  const persistRecord = useCallback(async (table, record) => {
    if (navigator.onLine) {
      // Mirror into the queue first: if the insert fails or the tab closes mid-request,
      // the data still exists locally instead of vanishing.
      const localId = `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const { data, error } = await supabase.from(table).insert([record]).select();
        if (error) throw new Error(error.message);
        return { data: data?.[0] ?? null, queued: false, error: null };
      } catch (err) {
        const queued = enqueue(syncQueueRef.current, {
          table, kind: 'insert', localId,
          record: { ...record, pendingSync: true },
          queuedAt: new Date().toISOString(),
        });
        setSyncQueue(queued);
        addAuditEvent("RECORD_QUEUED", `${table} kept locally: ${err.message}`, "warn");
        return { data: null, queued: true, error: err.message };
      }
    }

    const localId = `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queued = enqueue(syncQueueRef.current, {
      table, kind: 'insert', localId,
      record: { ...record, pendingSync: true },
      queuedAt: new Date().toISOString(),
    });
    setSyncQueue(queued);
    addAuditEvent("RECORD_QUEUED", `${table} saved on this device (offline)`, "warn");
    return { data: null, queued: true, error: null };
  }, [addAuditEvent]);

  // Show quick toast notification
  const showToast = (msg, type = "success") => {
    setToastMessage(msg);
    setToastType(type);
    setTimeout(() => setToastMessage(""), 3500);
  };

  useEffect(() => {
    fetchPatients();
  }, []);

  // Restore the persisted audit log and re-verify its hash chain on load.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUDIT_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      setAuditLog(parsed);
      const integrity = verifyLog(parsed);
      setAuditIntegrity(integrity);
      if (!integrity.valid) {
        // Surface tampering loudly rather than quietly loading a broken log.
        setAuditLog((prev) => appendEntry(prev, {
          action: 'AUDIT_CHAIN_BROKEN',
          details: `Integrity check failed at entry ${integrity.brokenAt}: ${integrity.reason}`,
          level: 'error',
          actor: 'System',
          timestamp: new Date().toISOString(),
        }));
      }
    } catch {
      // Corrupt storage must not prevent the app from starting.
    }
  }, []);

  // Opening Animation Timer (4 small squares -> center logo -> 4 words travel & converge -> slide up):
  useEffect(() => {
    if (view !== 'landing') {
      setIntroStage(4);
      return;
    }

    setIntroStage(0);
    const t1 = setTimeout(() => setIntroStage(1), 600);
    const t2 = setTimeout(() => setIntroStage(2), 1500);
    const t3 = setTimeout(() => setIntroStage(3), 3000);
    const t4 = setTimeout(() => setIntroStage(4), 3800);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [view]);

  // Scroll-reveal state for ASHA2 image
  const [asha2Visible, setAsha2Visible] = useState(false);
  const asha2Ref = useRef(null);

  useEffect(() => {
    if (view !== 'landing') return;
    const target = asha2Ref.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Trigger when ~15-25% of the image enters the viewport
        setAsha2Visible(entry.isIntersecting);
      },
      {
        threshold: 0.15,
        rootMargin: "0px 0px -40px 0px",
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [view]);

  // Section 3: Scroll-Pinned Process Timeline Scrubbing
  const processScrollRef = useRef(null);
  const [processProgress, setProcessProgress] = useState(0);

  useEffect(() => {
    if (view !== 'landing') return;

    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (!processScrollRef.current) return;
          const rect = processScrollRef.current.getBoundingClientRect();
          const totalScroll = rect.height - window.innerHeight;
          if (totalScroll <= 0) return;
          const currentScroll = -rect.top;
          const progress = Math.min(Math.max(currentScroll / totalScroll, 0), 1);
          setProcessProgress(progress);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [view]);

  const [isDesktop, setIsDesktop] = useState(true);
  const [hoveredProcessCard, setHoveredProcessCard] = useState(null);
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Helper to calculate smooth card entrance from left with scrub
  const getCardAnimStyle = (progress, start, end, baseX, baseY, targetRot) => {
    let p = 0;
    if (progress <= start) p = 0;
    else if (progress >= end) p = 1;
    else {
      const raw = (progress - start) / (end - start);
      p = raw * raw * (3 - 2 * raw); // Smooth cubic ease-in-out
    }

    const finalX = isDesktop ? baseX : 0;
    const finalY = isDesktop ? baseY : 0;
    const currentX = finalX - (1 - p) * (isDesktop ? 650 : 360);
    const opacity = p;
    const scale = 0.92 + 0.08 * p;
    const rot = targetRot * p;

    return {
      transform: `translate3d(${currentX}px, ${finalY}px, 0) scale(${scale}) rotate(${rot}deg)`,
      opacity,
      pointerEvents: p > 0.5 ? 'auto' : 'none',
    };
  };

  const activeProcessStep =
    processProgress < 0.20 ? 1 :
    processProgress < 0.38 ? 2 :
    processProgress < 0.56 ? 3 :
    processProgress < 0.74 ? 4 : 5;

  // Section 04: Visual Fly-Through ScrollTrigger Timeline (From Field to Record)
  const fieldRecordSectionRef = useRef(null);

  useEffect(() => {
    if (view !== 'landing') return;

    const ctx = gsap.context(() => {
      /* ========================================
         AROGYALEKH FIELD → RECORD FLY-THROUGH
      ======================================== */

      const fieldRecordTimeline = gsap.timeline({
        scrollTrigger: {
          trigger: ".field-record-space",
          start: "top top",
          end: "bottom bottom",
          scrub: 0.7,
        },
      });

      /* Title enters */

      fieldRecordTimeline

        .fromTo(
          ".field-record-title",
          {
            scale: 0.12,
            opacity: 0,
            filter: "blur(18px)",
          },
          {
            scale: 1,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.7,
            ease: "none",
          }
        )

        /* ========================================
           IMAGE 01 — ASHA1
        ======================================== */

        .fromTo(
          ".field-image-one",
          {
            scale: 0.04,
            xPercent: -80,
            yPercent: -30,
            opacity: 0,
            filter: "blur(22px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.75,
            ease: "none",
          },
          "-=0.45"
        )

        .to(".field-image-one", {
          scale: 3.5,
          xPercent: -95,
          yPercent: -75,
          opacity: 0,
          filter: "blur(10px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 02 — ASHA2
        ======================================== */

        .fromTo(
          ".field-image-two",
          {
            scale: 0.04,
            xPercent: 90,
            yPercent: -50,
            opacity: 0,
            filter: "blur(22px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.75,
            ease: "none",
          },
          "-=0.5"
        )

        .to(".field-image-two", {
          scale: 3.8,
          xPercent: 90,
          yPercent: -80,
          opacity: 0,
          filter: "blur(11px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 03 — ASHA3
        ======================================== */

        .fromTo(
          ".field-image-three",
          {
            scale: 0.03,
            xPercent: -100,
            yPercent: 100,
            opacity: 0,
            filter: "blur(24px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.75,
            ease: "none",
          },
          "-=0.5"
        )

        .to(".field-image-three", {
          scale: 4,
          xPercent: -85,
          yPercent: 95,
          opacity: 0,
          filter: "blur(12px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 04 — ASHA4
        ======================================== */

        .fromTo(
          ".field-image-four",
          {
            scale: 0.04,
            xPercent: 100,
            yPercent: 90,
            opacity: 0,
            filter: "blur(24px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.75,
            ease: "none",
          },
          "-=0.5"
        )

        .to(".field-image-four", {
          scale: 3.5,
          xPercent: 100,
          yPercent: 80,
          opacity: 0,
          filter: "blur(12px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 05 — ASHA5
        ======================================== */

        .fromTo(
          ".field-image-five",
          {
            scale: 0.02,
            opacity: 0,
            filter: "blur(26px)",
          },
          {
            scale: 1,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.7,
            ease: "none",
          },
          "-=0.45"
        )

        .to(".field-image-five", {
          scale: 6,
          opacity: 0,
          filter: "blur(14px)",
          duration: 0.9,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 06 — ASHA6
        ======================================== */

        .fromTo(
          ".field-image-six",
          {
            scale: 0.025,
            xPercent: 85,
            yPercent: -80,
            opacity: 0,
            filter: "blur(25px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.7,
            ease: "none",
          },
          "-=0.45"
        )

        .to(".field-image-six", {
          scale: 4,
          xPercent: 90,
          yPercent: -90,
          opacity: 0,
          filter: "blur(12px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 07 — ASHA7
        ======================================== */

        .fromTo(
          ".field-image-seven",
          {
            scale: 0.03,
            xPercent: -100,
            yPercent: 85,
            opacity: 0,
            filter: "blur(25px)",
          },
          {
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.7,
            ease: "none",
          },
          "-=0.5"
        )

        .to(".field-image-seven", {
          scale: 4,
          xPercent: -95,
          yPercent: 80,
          opacity: 0,
          filter: "blur(12px)",
          duration: 0.85,
          ease: "power2.in",
        })

        /* ========================================
           IMAGE 08 — ASHA8
        ======================================== */

        .fromTo(
          ".field-image-eight",
          {
            scale: 0.025,
            opacity: 0,
            filter: "blur(26px)",
          },
          {
            scale: 1,
            opacity: 1,
            filter: "blur(0px)",
            duration: 0.75,
            ease: "none",
          },
          "-=0.45"
        )

        .to(".field-image-eight", {
          scale: 5.5,
          opacity: 0,
          filter: "blur(14px)",
          duration: 0.9,
          ease: "power2.in",
        })

        /* ========================================
           TITLE LEAVES
        ======================================== */

        .to(
          ".field-record-title",
          {
            scale: 2.4,
            opacity: 0,
            filter: "blur(10px)",
            duration: 0.8,
            ease: "power2.in",
          },
          "-=0.55"
        )

        .to(
          ".field-record-center-copy, .field-record-scroll",
          {
            opacity: 0,
            y: 40,
            duration: 0.45,
          },
          "-=0.65"
        );

      const refreshTimeout = setTimeout(() => {
        ScrollTrigger.refresh();
      }, 250);

      return () => clearTimeout(refreshTimeout);
    }, fieldRecordSectionRef);

    return () => ctx.revert();
  }, [view]);

  // --- EXISTING LOGIC: Fetch Patients ---
  const fetchPatients = async () => {
    setLoadingData(true);
    setDataError(null);
    try {
      const { data, error } = await supabase.from('patients').select('*').order('id', { ascending: true });
      if (error) {
        setDataError("Failed to load patient registry. Check your connection.");
        addAuditEvent("FETCH_PATIENTS_ERROR", error.message, "error");
      } else if (data) {
        setPatients(data);
        addAuditEvent("FETCH_PATIENTS_OK", `Loaded ${data.length} patient records`, "info");
      }
    } catch (err) {
      setDataError("Network error. Operating in offline mode.");
      addAuditEvent("FETCH_PATIENTS_NETWORK_ERR", err.message, "error");
    }
    setLoadingData(false);
  };

  // --- EXISTING LOGIC: Select Patient & Load Cases ---
  const handleSelectPatient = async (patient) => {
    setSelectedPatient(patient);
    setLoadingData(true);
    setDataError(null);
    setView('patient');

    try {
      const { data, error } = await supabase
        .from('cases')
        .select('*')
        .eq('patient_id', patient.id)
        .order('id', { ascending: false });

      if (error) {
        setDataError("Could not load case history.");
        addAuditEvent("FETCH_CASES_ERROR", `Patient ${patient.id}: ${error.message}`, "error", [], { patientId: patient.id });
      } else if (data) {
        setCases(data);
        addAuditEvent("PATIENT_SELECTED", `${patient.name} (ID: ${patient.id})`, "info", [], { patientId: patient.id });
      }
    } catch (err) {
      setDataError("Network error loading case history.");
      addAuditEvent("FETCH_CASES_NETWORK_ERR", err.message, "error", [], { patientId: patient.id });
    }
    setLoadingData(false);
  };

  // --- EXISTING LOGIC: Register Patient ---
  const handleRegisterPatient = async (e) => {
    e.preventDefault();
    if (!newPatientName || !newPatientAge || !newPatientLocation) {
      return showToast("Please fill in all required fields.", "error");
    }

    // Duplicate guard (spec: "prevent accidental duplicate registration using
    // configured identifiers or matching information").
    const candidate = {
      name: newPatientName,
      age: newPatientAge,
      phone: newPatientPhone,
      abhaId: newPatientAbhaId,
    };
    const duplicates = findDuplicatePatients(patients, candidate).filter((m) => m.strength >= 3);
    if (duplicates.length > 0) {
      const existing = duplicates[0];
      const proceed = window.confirm(
        `POSSIBLE DUPLICATE PATIENT\n\n${existing.reason}: #${String(existing.patient.id).padStart(4, '0')} ${existing.patient.name}.\n\nRegister as a new patient anyway?`
      );
      if (!proceed) {
        addAuditEvent("DUPLICATE_REGISTRATION_BLOCKED", `${existing.reason} — matched #${existing.patient.id}`, "warn", [], { patientId: existing.patient.id });
        showToast("Registration cancelled: an existing patient already matches.", "warning");
        return;
      }
      addAuditEvent("DUPLICATE_REGISTRATION_OVERRIDE", `${existing.reason} — matched #${existing.patient.id}`, "warn", [], { patientId: existing.patient.id });
    }

    setIsSubmittingPatient(true);

    // Persist every field the form collects. Previously only name/age/gender/location
    // were stored, which silently discarded allergies (and so disabled allergy QA).
    let newRecord;
    try {
      newRecord = buildPatientRecord({
        name: newPatientName,
        age: newPatientAge,
        gender: newPatientGender,
        location: newPatientLocation,
        phone: newPatientPhone,
        emergencyContact: newPatientEmergencyContact,
        bloodGroup: newPatientBloodGroup,
        abhaId: newPatientAbhaId,
        allergies: newPatientAllergies,
      });
    } catch (err) {
      setIsSubmittingPatient(false);
      return showToast(err.message, "error");
    }

    // Offline-aware save: online it posts, offline it queues locally so registration is
    // never blocked or lost (spec: create or continue permitted cases while offline).
    const persisted = await persistRecord('patients', {
      ...newRecord,
      created_by: authEmail || "Field Worker",
      created_role: currentRole,
    });

    if (persisted.error) {
      showToast("Database error: " + persisted.error, "error");
      addAuditEvent("REGISTER_PATIENT_ERROR", persisted.error, "error");
    } else {
      // Reset form
      setNewPatientName("");
      setNewPatientAge("");
      setNewPatientGender("Male");
      setNewPatientLocation("");
      setNewPatientPhone("");
      setNewPatientBloodGroup("");
      setNewPatientAllergies("");
      setNewPatientEmergencyContact("");
      setNewPatientAbhaId("");
      setPatientRegStep(1);

      if (persisted.queued) {
        showToast("Patient saved on this device. It will upload when you are back online.", "warning");
        addAuditEvent("REGISTER_PATIENT_QUEUED", newRecord.name, "warn");
        setView('dashboard');
        setIsSubmittingPatient(false);
        return;
      }

      const created = persisted.data;
      if (created) setPatients([...patients, created]);
      showToast("Patient record successfully created.", "success");
      addAuditEvent("REGISTER_PATIENT_OK", `${newRecord.name}${created ? ` (ID: ${created.id})` : ''}`, "success", [], { patientId: created ? created.id : '' });
      // Spec: "The worker should then be able to immediately proceed from
      // registration into New Case, avoiding unnecessary navigation."
      if (created) {
        await handleSelectPatient(created);
        setView('capture');
      } else {
        setView('dashboard');
      }
    }
    setIsSubmittingPatient(false);
  };

  // --- EXISTING LOGIC: Delete Patient ---
  const handleDeletePatient = async (patientId) => {
    if (!window.confirm("CRITICAL WARNING: Are you sure you want to delete this patient? This will permanently erase them and ALL their clinical records. This cannot be undone.")) return;

    try {
      await supabase.from('cases').delete().eq('patient_id', patientId);
      const { error } = await supabase.from('patients').delete().eq('id', patientId);

      if (error) {
        showToast("Error deleting patient: " + error.message, "error");
        addAuditEvent("DELETE_PATIENT_ERROR", error.message, "error");
      } else {
        setPatients((prev) => prev.filter(p => p.id !== patientId));
        setView('dashboard');
        showToast("Patient record deleted.", "warning");
        addAuditEvent("DELETE_PATIENT", `Patient ID: ${patientId}`, "warn", [], { patientId });
      }
    } catch (err) {
      showToast("Failed to delete: " + err.message, "error");
    }
  };

  const runQaGate = useCallback((step = caseStep, overrideReport = null) => {
    try {
      const result = runClinicalQa({
        patient: selectedPatient,
        report: overrideReport || editedReport || report,
        diagnosis: selectedDiagnosis,
        prescriptions: prescriptionSuggestions.filter((p) => p.accepted),
        notes: doctorNote,
        priority: casePriority,
      });
      addAuditEvent(
        "CLINICAL_QA_RUN",
        `Step ${step} | ${result.status.toUpperCase()} | ${result.blocking.length} blocking, ${result.warnings.length} warnings`,
        result.blocking.length > 0 ? "error" : result.warnings.length > 0 ? "warn" : "success",
        [],
        { patientId: selectedPatient?.id }
      );
      const blocking = result.blockingMessages || [];
      if (blocking.length > 0) {
        showToast(`Clinical QA flagged ${blocking.length} blocking item(s). Review before signing.`, "error");
      } else if (result.warningMessages.length > 0) {
        showToast(`Clinical QA: ${result.warningMessages.length} item(s) to verify.`, "warning");
      } else {
        showToast("Clinical QA passed: no issues detected.", "success");
      }
      return result;
    } catch (err) {
      showToast("Clinical QA could not run: " + err.message, "error");
      addAuditEvent("CLINICAL_QA_ERROR", err.message, "error");
      return null;
    }
  }, [selectedPatient, editedReport, report, selectedDiagnosis, prescriptionSuggestions, doctorNote, casePriority, caseStep, addAuditEvent]);

  // --- EXISTING LOGIC: Voice Recording ---
  const startVoiceRecording = () => {
    if (!('webkitSpeechRecognition' in window)) {
      return showToast("Voice recognition not supported in this browser. Please use Google Chrome or Microsoft Edge.", "error");
    }
    const recognition = new window.webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-IN';

    recognition.onstart = () => {
      setIsRecording(true);
      addAuditEvent("VOICE_RECORDING_START", "Microphone activated", "info", [], { patientId: selectedPatient?.id });
      // Spec's worked example begins "10:05 — Voice note captured".
      setCaptureEvents((prev) => [
        ...prev,
        makeEvent(EVENT_TYPES.VOICE_CAPTURED, {
          actor: authEmail || "Field Worker",
          timestamp: new Date().toISOString(),
          patientId: selectedPatient?.id,
          details: "Microphone capture started",
        }),
      ]);
    };
    recognition.onresult = (event) => {
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + " ";
        }
      }
      if (finalTranscript) setInputText((prev) => prev + finalTranscript);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
  };

  // --- EXISTING LOGIC: Image Upload ---
  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
      addAuditEvent("IMAGE_ATTACHED", file.name, "info", [], { patientId: selectedPatient?.id });
      // Timeline event (spec: "Image captured")
      setCaptureEvents((prev) => [
        ...prev,
        makeEvent(EVENT_TYPES.IMAGE_CAPTURED, {
          actor: authEmail || "Field Worker",
          timestamp: new Date().toISOString(),
          patientId: selectedPatient?.id,
          details: file.name,
        }),
      ]);
    }
  };

  // --- EXISTING LOGIC: Extract Case via Backend API ---
  const extractCase = async () => {
    if (!inputText.trim() && !imageFile) return showToast("Please enter notes or upload an image.", "error");
    setLoadingAI(true);
    setAiError("");
    const startedAt = new Date().toISOString();
    setCaseStartedAt(startedAt);
    addAuditEvent("AI_PROCESSING_START", `Patient: ${selectedPatient?.name}`, "info", [], { patientId: selectedPatient?.id });

    // Timeline events for what was captured (spec: voice note / notes / image per event).
    const newCaptureEvents = [];
    if (inputText.trim()) {
      newCaptureEvents.push(makeEvent(EVENT_TYPES.TEXT_CAPTURED, {
        actor: authEmail || "Field Worker", timestamp: startedAt, patientId: selectedPatient?.id,
        details: `${inputText.trim().slice(0, 40)}${inputText.trim().length > 40 ? '…' : ''}`,
      }));
    }
    newCaptureEvents.push(makeEvent(EVENT_TYPES.AI_EXTRACTION_STARTED, {
      actor: authEmail || "Field Worker", timestamp: startedAt, patientId: selectedPatient?.id,
    }));
    setCaptureEvents((prev) => [...prev, ...newCaptureEvents]);

    try {
      const formData = new FormData();
      if (inputText) formData.append("text", inputText);
      if (selectedPatient) formData.append("patient_name", selectedPatient.name);
      if (imageFile) formData.append("image", imageFile);

      const response = await fetch("http://127.0.0.1:8000/api/process-case", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || "Backend connection failed.");
      }

      const data = await response.json();
      setReport(data.report);
      setEditedReport(JSON.parse(JSON.stringify(data.report))); // deep clone for editing
      // Build the review model (statuses, evidence, conflicts) from whichever report
      // shape the backend returned, then normalise the report back out of it so the
      // QA gate and the saved record see unresolved conflicts as blocking items.
      const model = normalizeReport(data.report);
      setReviewModel(model);
      setEditedReport(JSON.parse(JSON.stringify(reportFromReview(model))));

      // Timeline: what the pipeline found, so the reviewer can see how the report was produced.
      const completedAt = new Date().toISOString();
      const pipelineEvents = [
        makeEvent(EVENT_TYPES.AI_EXTRACTION_COMPLETED, {
          actor: 'AI', timestamp: completedAt, patientId: selectedPatient?.id,
          details: `${model.facts.length} fact(s) extracted`,
        }),
      ];
      if (model.facts.some((f) => (f.evidence || []).length > 0)) {
        pipelineEvents.push(makeEvent(EVENT_TYPES.EVIDENCE_PROCESSED, {
          actor: 'System', timestamp: completedAt, patientId: selectedPatient?.id,
          details: 'Evidence attached to extracted facts',
        }));
      }
      if (model.missing.length > 0) {
        pipelineEvents.push(makeEvent(EVENT_TYPES.MISSING_DETECTED, {
          actor: 'System', timestamp: completedAt, patientId: selectedPatient?.id,
          details: `${model.missing.length} item(s) not documented`,
        }));
      }
      model.conflicts.forEach((conflict) => {
        pipelineEvents.push(makeEvent(EVENT_TYPES.CONFLICT_DETECTED, {
          actor: 'System', timestamp: completedAt, patientId: selectedPatient?.id,
          details: String(conflict.field || '').replace(/_/g, ' '),
        }));
      });
      if (model.clarificationQuestions.length > 0) {
        pipelineEvents.push(makeEvent(EVENT_TYPES.CLARIFICATION_RAISED, {
          actor: 'System', timestamp: completedAt, patientId: selectedPatient?.id,
          details: `${model.clarificationQuestions.length} question(s) suggested`,
        }));
      }
      setReviewEvents((prev) => [...prev, ...pipelineEvents]);
      // Generate prescription suggestions from report
      generatePrescriptionSuggestions(data.report);
      showToast("Clinical analysis synthesized successfully.", "success");
      addAuditEvent("AI_PROCESSING_OK", `Extracted ${data.report?.confirmed?.length || 0} confirmed fields`, "success", [], { patientId: selectedPatient?.id });
      setCaseStep(2); // Move to AI Review step
    } catch (error) {
      // Spec: an error must explain what happened and offer a next action, and must
      // never cause captured information to disappear.
      setAiError(error.message || "AI processing failed.");
      showToast("AI Processing Error: " + error.message, "error");
      addAuditEvent("AI_PROCESSING_ERROR", error.message, "error", [], { patientId: selectedPatient?.id });
    }
    setLoadingAI(false);
  };

  // Generate protocol-draft medication suggestions.
  //
  // These are DRAFTS. The spec requires that prescriptions never look AI-generated, so
  // the UI labels them as protocol drafts the clinician accepts under their own name.
  const generatePrescriptionSuggestions = (report) => {
    const confirmed = Array.isArray(reviewModel?.facts) ? reviewModel.facts : [];
    const byField = (needle) => confirmed.find((f) => String(f.field || '').toLowerCase().includes(needle));
    const caseSummary = editedReport?.summary || report?.summary || '';
    const profile = [
      selectedPatient?.allergies && `allergies: ${selectedPatient.allergies}`,
      selectedPatient?.blood_group && `blood group ${selectedPatient.blood_group}`,
      selectedPatient?.age ? `age ${selectedPatient.age}` : '',
    ].filter(Boolean).join(', ');

    const synthesized = [
      byField('complaint')?.value || byField('diagnosis')?.value || caseSummary,
      byField('diagnosis')?.value,
      byField('temperature')?.value,
      byField('pulse')?.value,
      doctorNote,
      profile,
      caseSummary,
      caseCategory,
    ].filter(Boolean).join(' ').toLowerCase();

    const suggestions = [];
    if (synthesized.includes('fever') || synthesized.includes('pyrexia') || synthesized.includes('temperature')) {
      suggestions.push({ drug: 'Paracetamol 650mg', dose: 'TDS x 5 days', route: 'Oral', type: 'draft' });
      suggestions.push({ drug: 'ORS Sachets', dose: 'PRN', route: 'Oral', type: 'draft' });
    }
    if (synthesized.includes('cough') || synthesized.includes('respiratory')) {
      suggestions.push({ drug: 'Amoxicillin 500mg', dose: 'BD x 7 days', route: 'Oral', type: 'draft' });
      suggestions.push({ drug: 'Guaifenesin Syrup', dose: '10ml TDS', route: 'Oral', type: 'draft' });
    }
    if (synthesized.includes('bp') || synthesized.includes('hypertension')) {
      suggestions.push({ drug: 'Amlodipine 5mg', dose: 'OD', route: 'Oral', type: 'draft' });
    }
    if (synthesized.includes('diabetes') || synthesized.includes('sugar') || synthesized.includes('glucose')) {
      suggestions.push({ drug: 'Metformin 500mg', dose: 'BD with meals', route: 'Oral', type: 'draft' });
    }
    if (suggestions.length === 0) {
      suggestions.push({ drug: 'Paracetamol 500mg', dose: 'SOS', route: 'Oral', type: 'draft' });
    }
    setPrescriptionSuggestions(suggestions.map((s, i) => ({ ...s, id: i, accepted: false })));
  };

  // --- EXISTING LOGIC: Approve & Sign Case ---
  const handleApprove = async () => {
    if (!report || !selectedPatient) return;

    const finalReport = editedReport || report;
    const acceptedPrescriptions = prescriptionSuggestions.filter(p => p.accepted);

    // Clinical QA gate: re-evaluated here so it always reflects the values being signed,
    // never a stale snapshot. Blocking findings stop the signing unless the clinician
    // records an explicit, auditable override reason. The result itself needs no state:
    // its findings surface through the existing toast, confirm dialog and audit log.
    const qa = runQaGate(3);
    let overrideReason = "";
    if (qa) {
      if (qa.blocking.length > 0) {
        const proceed = window.confirm(
          "CLINICAL QA BLOCKED SIGNING\n\n" +
            qa.blockingMessages.map((m, i) => `${i + 1}. ${m}`).join("\n") +
            "\n\nOverride and sign anyway? This override is written to the audit log."
        );
        if (!proceed) {
          addAuditEvent("CLINICAL_QA_SIGN_BLOCKED", qa.blockingMessages.join(" | "), "error", [], { patientId: selectedPatient?.id });
          showToast("Signing stopped: resolve the blocking QA items or explicitly override.", "warning");
          return;
        }
        overrideReason = window.prompt(
          "Override justification required (recorded in the audit log). Leave blank to cancel signing.",
          ""
        );
        if (!overrideReason || !overrideReason.trim()) {
          addAuditEvent("CLINICAL_QA_OVERRIDE_CANCELLED", qa.blockingMessages.join(" | "), "warn");
          showToast("Override cancelled. Record not signed.", "warning");
          return;
        }
        overrideReason = overrideReason.trim();
        addAuditEvent("CLINICAL_QA_OVERRIDE", `Reason: ${overrideReason} | Blocked: ${qa.blockingMessages.join(" | ")}`, "warn", [], { patientId: selectedPatient?.id });
      } else if (qa.warnings.length > 0) {
        addAuditEvent("CLINICAL_QA_ATTESTED", `Signed with ${qa.warnings.length} acknowledged warning(s)`, "warn");
      }
    }

    const newRecord = {
      patient_id: selectedPatient.id,
      summary: finalReport.summary,
      details: {
        ...finalReport,
        doctor_note: doctorNote,
        diagnosis: selectedDiagnosis || finalReport.summary,
        category: caseCategory,
        priority: casePriority,
        prescriptions: acceptedPrescriptions,
        // Hand-entered by the clinician as protocol drafts; attributed to nobody.
        prescriptions_author: '',
        prescriptions_author_role: '',
        // Authorised prescriptions are separate: each carries its own doctor identity,
        // date, patient/case and change history (spec requirement).
        authorised_prescriptions: authorisedPrescriptions,
        doctor_suggestions: [],
        clinical_qa: qaAuditSnapshot(qa) ? { ...qaAuditSnapshot(qa), override_reason: overrideReason || null } : null,
        approved_at: new Date().toISOString(),
        // Event-level history for this case (spec: case history/timeline), recorded so the
        // final report can always be traced back to how it was produced.
        timeline: buildCaseTimeline({
          patient: selectedPatient,
          groups: [captureEvents, reviewEvents],
          extra: [
            makeEvent(EVENT_TYPES.CASE_CREATED, {
              actor: authEmail || "Field Worker",
              timestamp: new Date().toISOString(),
              patientId: selectedPatient.id,
            }),
            makeEvent(EVENT_TYPES.AI_EXTRACTION_COMPLETED, {
              actor: "AI",
              timestamp: caseStartedAt || new Date().toISOString(),
              patientId: selectedPatient.id,
            }),
          ],
        }),
        provenance: provenanceSummary(reviewModel ? reviewModel.facts : finalReport.confirmed),
        created_by: authEmail || "Field Worker",
        created_role: currentRole,
      },
    };

    // Persist through the offline-aware path: online it posts, offline it queues locally,
    // so a signed encounter is never lost to a dropped connection.
    // Note: a case persisted while offline has no server id yet, so its SYNCHRONISED
    // timeline event is attached after upload (see runSync), not here.
    const persisted = await persistRecord('cases', newRecord);
    if (persisted.error) {
      showToast("Could not save the record: " + persisted.error, "error");
      addAuditEvent("APPROVE_CASE_ERROR", persisted.error, "error");
      return;
    }
    if (persisted.data) setCases((prev) => [persisted.data, ...prev]);
    setReport(null);
    setEditedReport(null);
    setReviewModel(null);
    setInputText("");
    setImageFile(null);
    setImagePreview(null);
    setDoctorNote("");
    setSelectedDiagnosis("");
    setCaseStep(1);
    setPrescriptionSuggestions([]);
    setAuthorisedPrescriptions([]);
    setRxDrug("");
    setRxDose("");
    setNewFactField("");
    setNewFactValue("");
    setCaptureEvents([]);
    setReviewEvents([]);
    setCaseStartedAt("");
    setView('patient');
    if (persisted.queued) {
      showToast("Encounter signed and saved on this device. It will upload automatically.", "warning");
      addAuditEvent("CASE_APPROVED_OFFLINE", `Patient: ${selectedPatient.name} · queued for sync`, "warn", [], { patientId: selectedPatient.id });
    } else {
      showToast("Clinical encounter approved & signed to record.", "success");
      addAuditEvent("CASE_APPROVED", `Patient: ${selectedPatient.name} | Priority: ${casePriority}`, "success", [], { patientId: selectedPatient.id, caseId: persisted.data?.id ?? "" });
      if (persisted.data) {
        // Spec's worked example ends "10:12 — Report approved".
        appendCaseEvent(persisted.data.id, makeEvent(EVENT_TYPES.REPORT_APPROVED, {
          actor: authEmail || "Field Worker",
          timestamp: new Date().toISOString(),
          caseId: persisted.data.id,
          patientId: selectedPatient.id,
          details: selectedDiagnosis || finalReport.summary?.slice(0, 40) || "",
        }));
        appendCaseEvent(persisted.data.id, makeEvent(EVENT_TYPES.CASE_SUBMITTED, {
          actor: authEmail || "Field Worker",
          timestamp: new Date().toISOString(),
          caseId: persisted.data.id,
          patientId: selectedPatient.id,
          details: "Submitted to the record",
        }));
      }
    }
  };

  // --- REVIEW MODEL ACTIONS (spec: AI drafts -> evidence verifies -> human approves) ---
  const syncReviewToReport = (model) => {
    setReviewModel(model);
    setEditedReport(JSON.parse(JSON.stringify(reportFromReview(model))));
  };

  const handleFactCorrection = (index, newValue) => {
    if (!reviewModel) return;
    const before = reviewModel.facts[index];
    const updatedFacts = applyCorrection(reviewModel.facts, index, newValue, {
      actor: authEmail || "Field Worker",
      timestamp: new Date().toISOString(),
    });
    // Corrections are recorded as history, never as a silent overwrite.
    if (updatedFacts[index] !== before) {
      addAuditEvent(
        "HUMAN_CORRECTION",
        `${before.field}: "${formatFactValue(before.value)}" -> "${newValue}" (AI value retained)`,
        "warn",
        [{ field: before.field, from: formatFactValue(before.value), to: String(newValue) }],
        { patientId: selectedPatient?.id }
      );
      // Timeline line, e.g. "10:10 — Worker corrected temperature".
      setReviewEvents((prev) => [
        ...prev,
        makeEvent(EVENT_TYPES.HUMAN_CORRECTION, {
          actor: authEmail || "Field Worker",
          timestamp: new Date().toISOString(),
          patientId: selectedPatient?.id,
          details: `${String(before.field).replace(/_/g, ' ')}: ${formatFactValue(before.value)} -> ${newValue}`,
          data: { field: before.field, from: before.value, to: newValue },
        }),
      ]);
    }
    syncReviewToReport({ ...reviewModel, facts: updatedFacts });
  };

  const handleConflictResolution = (field, chosenValue) => {
    if (!reviewModel) return;
    const updatedConflicts = resolveConflict(reviewModel.conflicts, field, chosenValue, {
      actor: authEmail || "Field Worker",
      timestamp: new Date().toISOString(),
    });
    const conflict = reviewModel.conflicts.find((entry) => entry.field === field);
    const rejectedValues = (conflict?.options || [])
      .filter((option) => String(option.value) !== String(chosenValue))
      .map((option) => option.value)
      .join(" / ");
    // Value-level record: what was chosen, and what it replaced (spec: previous → new value).
    addAuditEvent(
      "CONFLICT_RESOLVED",
      `${field} = "${formatFactValue(chosenValue)}" (human decision)`,
      "warn",
      [{ field, from: rejectedValues, to: formatFactValue(chosenValue) }],
      { patientId: selectedPatient?.id }
    );
    setReviewEvents((prev) => [
      ...prev,
      makeEvent(EVENT_TYPES.CONFLICT_RESOLVED, {
        actor: authEmail || "Field Worker",
        timestamp: new Date().toISOString(),
        patientId: selectedPatient?.id,
        details: `${String(field).replace(/_/g, ' ')} = ${formatFactValue(chosenValue)}`,
        data: { field, chosen: chosenValue, rejected: rejectedValues },
      }),
    ]);
    syncReviewToReport({ ...reviewModel, conflicts: updatedConflicts });
  };

  // --- EXISTING LOGIC: Delete Case ---
  const deleteCase = async (caseId) => {
    if (!window.confirm("Delete this clinical record permanently?")) return;

    try {
      const { error } = await supabase.from('cases').delete().eq('id', caseId);
      if (!error) {
        setCases((prev) => prev.filter(c => c.id !== caseId));
        showToast("Encounter record removed.", "warning");
        addAuditEvent("DELETE_CASE", `Case ID: ${caseId}`, "warn", [], { caseId, patientId: selectedPatient?.id ?? "" });
      }
    } catch (err) {
      showToast("Failed to delete case: " + err.message, "error");
    }
  };

  const formatVal = formatFactValue;

  // Filter patients by search query
  const filteredPatients = patients.filter(p => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.name?.toLowerCase().includes(q) ||
      p.location?.toLowerCase().includes(q) ||
      String(p.id).includes(q)
    );
  });

  // Audit log filtering + facet lists for the filter controls.
  const filteredAuditLog = filterEvents(auditLog, auditFilters);
  const auditFacets = filterFacets(auditLog);

  // Record refused access attempts. This runs as an effect, after the render that
  // denied the view, so it cannot cause a render loop.
  useEffect(() => {
    if (view !== 'patient' && view !== 'capture' && view !== 'add_patient') return;
    const needed = view === 'patient' ? 'view_patients' : view === 'capture' ? 'create_case' : 'create_patient';
    if (checkAccess(currentRole, needed).allowed) return;
    const what = view === 'patient'
      ? `open a patient record${selectedPatient ? ` (${selectedPatient.name})` : ''}`
      : view === 'capture'
        ? 'start a new case'
        : 'register a new patient';
    recordDeniedAccess(needed, what, selectedPatient ? { patientId: selectedPatient.id } : {});
  }, [view, currentRole, selectedPatient, recordDeniedAccess]);

  // Review-screen derived values: the original source text and any AI claim whose quoted
  // evidence could not be located in that source (a likely fabrication).
  const captureTextSource = reviewModel ? (editedReport?.raw_source_text || inputText || "") : "";
  const unsupportedFacts = reviewModel && Array.isArray(reviewModel.facts)
    ? reviewModel.facts.filter((fact) => isUnsupported(fact))
    : [];
  // Only an authorised prescriber (a doctor) may author a prescription.
  const canAuthorPrescriptionRecord = can(currentRole, 'create_prescription');

  // Cases a doctor should look at: unresolved conflicts or blocking QA findings.
  // Doctors are not a gate on every case, so ordinary cases are excluded.
  const pendingReviewCases = cases.map((entry) => {
    const details = entry.details || {};
    const conflicts = Array.isArray(details.conflicts) ? details.conflicts.filter((c) => c && c.requires_resolution !== false) : [];
    const blocked = details.clinical_qa?.status === 'blocked';
    const reason = blocked
      ? 'blocking QA findings'
      : conflicts.length > 0
        ? `${conflicts.length} unresolved conflict(s)`
        : '';
    return reason ? { id: entry.id, reason } : null;
  }).filter(Boolean);

  // Patient profile derived data: provenance of the latest case and anything needing attention.
  const latestCase = cases.length > 0 ? cases[0] : null;
  const caseProvenance = latestCase?.details?.provenance || null;
  const profileAttention = attentionItems({
    cases,
    conflicts: (latestCase?.details?.conflicts || []).filter((c) => c && c.requires_resolution !== false),
    followUps: latestCase?.details?.follow_ups || [],
    qaStatus: latestCase?.details?.clinical_qa?.status || '',
  }).slice(0, 6);

  // ==========================================
  // OFFLINE / SYNC INDICATOR BANNER (spec: Online/Offline/Syncing/Synced/Pending/Failed)
  // ==========================================
  const syncState = overallSyncState(syncQueue, { online: isOnline });
  const syncMeta = syncStateMeta(syncState);

  const OfflineBanner = () => {
    // Shown while offline, or whenever something still needs attention online.
    const needsAttention = syncState === SYNC_STATE.OFFLINE || syncState === SYNC_STATE.PENDING
      || syncState === SYNC_STATE.FAILED || syncState === SYNC_STATE.SYNCING;

    const tone = {
      amber: 'bg-amber-900/90 border-amber-500/50 text-amber-200',
      rose: 'bg-rose-950/90 border-rose-500/50 text-rose-200',
      blue: 'bg-[#0b2b20]/95 border-[#164634] text-[#A3D9BE]',
    }[syncMeta.tone] || 'bg-amber-900/90 border-amber-500/50 text-amber-200';
    const dot = { amber: 'bg-amber-400', rose: 'bg-rose-400', blue: 'bg-blue-400' }[syncMeta.tone] || 'bg-amber-400';
    const pending = pendingOperations(syncQueue).length;

    return (
      <>
        {needsAttention && (
          <div className={`fixed top-0 inset-x-0 z-[60] ${tone} border-b px-4 py-2 flex items-center justify-center gap-3 backdrop-blur-sm`}>
            <span className={`w-2 h-2 rounded-full ${dot} ${syncState === SYNC_STATE.SYNCING ? 'animate-pulse' : ''}`}></span>
            <span className="text-xs font-mono uppercase tracking-wider font-bold">
              {syncMeta.label}
              {pending > 0 ? ` — ${pending} record(s) awaiting upload` : ''}
            </span>
            {syncError && (
              <span className="text-[10px] font-mono truncate max-w-[16rem]" title={syncError}>{syncError}</span>
            )}
            <button
              type="button"
              onClick={() => setSyncCenterOpen(true)}
              className="text-[10px] font-mono uppercase tracking-wider underline underline-offset-4 hover:text-white transition-colors"
            >
              Sync Center
            </button>
          </div>
        )}
        <SyncCenter />
      </>
    );
  };

  // ==========================================
  // SYNC CENTER (spec: inspect progress, recover from failures)
  // ==========================================
  const SyncCenter = () => {
    if (!syncCenterOpen) return null;
    const pending = pendingOperations(syncQueue);
    const failed = failedOperations(syncQueue);
    const empty = syncCenterEmptyMessage(syncQueue, isOnline);

    return (
      <div className="fixed inset-0 z-[70] bg-[#072118]/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-[#0b2b20] border border-[#164634] rounded-[2px] shadow-2xl flex flex-col max-h-[80vh]">
          <div className="p-5 border-b border-[#164634] flex justify-between items-start">
            <div>
              <h2 className="text-lg font-bold text-[#D8FCE8]">Sync Center</h2>
              <p className="text-xs text-[#A3D9BE]">{syncMeta.description}</p>
            </div>
            <button onClick={() => setSyncCenterOpen(false)} className="text-[#648E77] hover:text-[#D8FCE8] text-xs font-mono uppercase">Close</button>
          </div>

          <div className="p-5 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-[#072118] border border-[#164634] p-3 rounded-[1px]">
                <span className="block text-[10px] font-mono text-[#648E77] uppercase mb-1">Awaiting</span>
                <span className="text-xl font-bold text-amber-200">{pending.length}</span>
              </div>
              <div className="bg-[#072118] border border-[#164634] p-3 rounded-[1px]">
                <span className="block text-[10px] font-mono text-[#648E77] uppercase mb-1">Failed</span>
                <span className="text-xl font-bold text-rose-300">{failed.length}</span>
              </div>
              <div className="bg-[#072118] border border-[#164634] p-3 rounded-[1px]">
                <span className="block text-[10px] font-mono text-[#648E77] uppercase mb-1">Connection</span>
                <span className="text-sm font-bold text-[#D8FCE8]">{isOnline ? 'Online' : 'Offline'}</span>
              </div>
            </div>

            {syncError && (
              <div className="p-3 border border-rose-500/40 bg-rose-950/20 rounded-[1px] text-xs text-rose-200">
                {syncError}
              </div>
            )}

            {syncBusy && (
              <div className="flex items-center gap-3 p-3 border border-[#164634] bg-[#072118] rounded-[1px]">
                <div className="w-4 h-4 border-2 border-[#164634] border-t-[#B5F5D1] rounded-full animate-spin shrink-0"></div>
                <span className="text-[10px] font-mono text-[#A3D9BE] uppercase tracking-wider">
                  Uploading — do not close this window
                </span>
              </div>
            )}

            {empty ? (
              <p className="text-xs text-[#A3D9BE]">{empty}</p>
            ) : (
              <div className="space-y-2">
                {pending.map((operation) => (
                  <div key={operationKey(operation)} className="p-3 bg-[#072118] border-l-2 border-[#164634] rounded-r-[1px] flex justify-between items-center gap-3 text-[10px] font-mono">
                    <div className="min-w-0">
                      <span className="block text-[#D8FCE8] uppercase">{operation.table} · {operation.kind}</span>
                      <span className="text-[#648E77]">{operation.record?.name || operation.record?.summary?.slice(0, 40) || operation.localId}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className={operation.status === 'failed' ? 'text-rose-300 uppercase' : 'text-amber-200 uppercase'}>
                        {operation.status}
                      </span>
                      <span className="block text-[#648E77]">{originLabel(storageOrigin(operation.record))}</span>
                      {operation.lastError && <span className="block text-rose-300 truncate max-w-[10rem]" title={operation.lastError}>{operation.lastError}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-3 pt-2 border-t border-[#164634]">
              <button
                type="button"
                disabled={syncBusy || !isOnline || pendingOperations(syncQueue).length === 0}
                onClick={() => runSync(syncQueue, "manual")}
                className="flex-1 bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-2.5 rounded-[2px] font-bold text-xs uppercase tracking-wider disabled:opacity-50 transition-colors"
              >
                {syncBusy ? 'Syncing...' : 'Retry Sync Now'}
              </button>
              <button
                type="button"
                disabled={failed.length === 0}
                onClick={() => {
                  // Recovery action: reset attempt counters so a stuck record retries.
                  const reset = syncQueue.map((op) =>
                    op.status === SYNC_STATE.FAILED ? { ...op, status: SYNC_STATE.PENDING, attempts: 0, lastError: '' } : op
                  );
                  setSyncQueue(reset);
                  addAuditEvent("SYNC_RETRY_RESET", `${failed.length} failed record(s) reset for retry`, "warn", [], {});
                  runSync(reset, "retry-reset");
                }}
                className="flex-1 bg-transparent border border-[#164634] text-[#A3D9BE] hover:text-[#D8FCE8] py-2.5 rounded-[2px] font-bold text-xs uppercase tracking-wider disabled:opacity-40 transition-colors"
              >
                Reset &amp; Retry Failed
              </button>
            </div>
            <p className="text-[10px] font-mono text-[#648E77]">
              Records shown here are saved on this device only. Nothing is discarded until it reaches the server.
            </p>
          </div>
        </div>
      </div>
    );
  };

  // ==========================================
  // GLOBAL HEADER (MATCHING EXACT REFERENCE SCALE)
  // ==========================================
  const Header = () => (
    <header className={`sticky z-40 bg-[#072118] border-b border-[#164634]/30 ${!isOnline ? 'top-8' : 'top-0'}`}>
      <div className="max-w-7xl mx-auto px-6 sm:px-10 h-20 flex items-center justify-between">
        {/* Brand Area on LEFT: Logo + Wordmark (Matching Reference Scale) */}
        <div
          onClick={() => setView('landing')}
          className="flex items-center gap-3 cursor-pointer group select-none"
        >
          <div className="w-7 h-7 rounded-[2px] bg-[#B5F5D1] text-[#072118] flex items-center justify-center font-bold text-xs tracking-tighter transition-transform group-hover:scale-105">
            AL
          </div>
          <span className="text-base sm:text-lg font-bold tracking-[0.16em] text-[#D8FCE8] group-hover:text-white transition-colors">
            AROGYALEKH
          </span>
        </div>

        {/* Right Section: Offline indicator + Compact Rectangular Menu Button */}
        <div className="flex items-center gap-5">
          {/* Offline indicator dot in header */}
          {!isOnline && (
            <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-amber-400 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              Offline
            </span>
          )}
          {isOnline && (
            <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-emerald-400/70 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Online
            </span>
          )}
          <button
            onClick={() => setView('login')}
            className="hidden sm:inline-block text-xs font-mono tracking-wider uppercase text-[#648E77] hover:text-[#D8FCE8] transition-colors"
          >
            Staff Portal
          </button>

          {/* Compact rectangular button matching screenshot: "Menü" with two horizontal lines */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="px-3.5 py-1.5 rounded-[2px] bg-[#B5F5D1] text-[#072118] font-bold text-xs tracking-wider hover:bg-[#c8fae0] transition-all active:scale-95 flex items-center gap-2 shadow-sm select-none"
            aria-label="Toggle Navigation Menu"
          >
            <span>Menü</span>
            {menuOpen ? (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 9h16M4 15h16" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </header>
  );

  // ==========================================
  // FULL-SCREEN NAVIGATION OVERLAY (MATCHING SCREENSHOT 1)
  // Left-aligned, 52-72px typography, exact 5 items: HOME, CLINIC, WORKER, ADMIN, SETTINGS
  // ==========================================
  const FullScreenMenu = () => {
    if (!menuOpen) return null;

    const navItems = [
      { id: 'landing', label: 'HOME' },
      { id: 'onboarding', label: 'CLINIC' },
      { id: 'dashboard', label: 'WORKER' },
      { id: 'admin', label: 'ADMIN' },
      { id: 'settings', label: 'SETTINGS' },
    ];

    return (
      <div className="fixed inset-0 z-50 bg-[#072118] text-[#D8FCE8] flex flex-col justify-between overflow-y-auto animate-menu-reveal">
        {/* Top Bar with exact same geometry as Header */}
        <div className="w-full">
          <div className="max-w-7xl mx-auto px-6 sm:px-10 h-20 flex items-center justify-between border-b border-[#164634]/30">
            <div
              onClick={() => { setView('landing'); setMenuOpen(false); }}
              className="flex items-center gap-3 cursor-pointer group select-none"
            >
              <div className="w-7 h-7 rounded-[2px] bg-[#B5F5D1] text-[#072118] flex items-center justify-center font-bold text-xs tracking-tighter">
                AL
              </div>
              <span className="text-base sm:text-lg font-bold tracking-[0.16em] text-[#D8FCE8]">
                AROGYALEKH
              </span>
            </div>

            <button
              onClick={() => setMenuOpen(false)}
              className="px-3.5 py-1.5 rounded-[2px] bg-[#B5F5D1] text-[#072118] font-bold text-xs tracking-wider hover:bg-[#c8fae0] transition-all active:scale-95 flex items-center gap-2 shadow-sm"
            >
              <span>Menü</span>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* LEFT-ALIGNED NAVIGATION LIST (MATCHING SCREENSHOT 1: 52-72px, Left Aligned) */}
        <div className="max-w-7xl w-full mx-auto px-6 sm:px-10 my-auto py-10">
          <nav className="pl-0 sm:pl-2">
            <ul className="space-y-4 sm:space-y-6">
              {navItems.map((item, idx) => {
                const isActive =
                  (item.id === 'landing' && view === 'landing') ||
                  (item.id === 'onboarding' && view === 'onboarding') ||
                  (item.id === 'dashboard' && ['dashboard', 'patient', 'capture', 'add_patient'].includes(view)) ||
                  (item.id === 'admin' && view === 'admin') ||
                  (item.id === 'settings' && view === 'settings');

                return (
                  <li key={item.id} className="overflow-hidden">
                    <button
                      onClick={() => {
                        setView(item.id);
                        setMenuOpen(false);
                      }}
                      style={{ animationDelay: `${idx * 50}ms` }}
                      className={`block text-left transition-all duration-300 hover:translate-x-3 text-5xl sm:text-6xl md:text-7xl font-normal sm:font-medium tracking-tight animate-menu-item-in ${
                        isActive
                          ? 'text-white'
                          : 'text-[#648E77] hover:text-[#D8FCE8]'
                      }`}
                    >
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* Menu Footer (Matching Screenshot 1: Tagline on Left, Info on Right) */}
        <div className="w-full pb-8">
          <div className="max-w-7xl mx-auto px-6 sm:px-10 pt-6 border-t border-[#164634]/60 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 text-xs font-mono text-[#648E77]">
            <div>Healthcare documentation made simpler.</div>
            <div>
              <span
                onClick={() => { setView('login'); setMenuOpen(false); }}
                className="text-[#648E77] hover:text-[#B5F5D1] cursor-pointer"
              >
                Staff Portal & Sign In →
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Toast Notification Banner
  const Toast = () => {
    if (!toastMessage) return null;
    const colors = {
      success: { bg: 'bg-[#0b2b20]', border: 'border-[#B5F5D1]/30', dot: 'bg-[#B5F5D1]', text: 'text-[#D8FCE8]' },
      error: { bg: 'bg-rose-950', border: 'border-rose-500/30', dot: 'bg-rose-400', text: 'text-rose-200' },
      warning: { bg: 'bg-amber-950', border: 'border-amber-500/30', dot: 'bg-amber-400', text: 'text-amber-200' },
      info: { bg: 'bg-[#0b2b20]', border: 'border-[#B5F5D1]/30', dot: 'bg-blue-400', text: 'text-[#D8FCE8]' },
    };
    const c = colors[toastType] || colors.success;
    return (
      <div className={`fixed bottom-6 right-6 z-50 ${c.bg} ${c.text} border ${c.border} px-5 py-3 rounded-[2px] shadow-xl flex items-center gap-3 animate-reveal-slow`}>
        <span className={`w-2 h-2 rounded-full ${c.dot}`}></span>
        <span className="text-sm font-medium">{toastMessage}</span>
      </div>
    );
  };

  // ==========================================
  // VIEW: LANDING PAGE (EXACT REFERENCE CHOREOGRAPHY & EDITORIAL SCROLL)
  // ==========================================
  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-between selection:bg-[#B5F5D1] selection:text-[#072118] overflow-x-clip">
        <OfflineBanner />
        <Header />
        <FullScreenMenu />
        <Toast />

        {/* ======================================================== */}
        {/* MINIMAL INTRO OVERLAY (STAGES 0 TO 3) */}
        {/* ONLY: 4 TINY MINT SQUARES + CENTER LOGO + LOGO SLIDE UP */}
        {/* ABSOLUTELY NO WORDS, NO BOXES, NO 2x2 GRIDS */}
        {/* ======================================================== */}
        {introStage < 4 && (
          <div
            className={`fixed inset-0 z-50 bg-[#072118] flex items-center justify-center overflow-hidden select-none transition-opacity duration-700 ${
              introStage === 3 ? 'opacity-0 pointer-events-none' : 'opacity-100'
            }`}
          >
            {/* Center origin container for 4-square transforms */}
            <div className="relative w-full h-full flex items-center justify-center">
              
              {/* SQUARE 1: TOP-LEFT (Small 14px Mint Square) */}
              <div
                className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-[#B5F5D1] rounded-[1px] shadow-sm transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] pointer-events-none"
                style={{
                  transform:
                    introStage >= 3
                      ? 'translate(-42vw, -55vh)'
                      : 'translate(-42vw, -38vh)',
                  opacity: introStage >= 3 ? 0 : 1,
                }}
              />

              {/* SQUARE 2: TOP-RIGHT (Small 14px Mint Square) */}
              <div
                className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-[#B5F5D1] rounded-[1px] shadow-sm transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] pointer-events-none"
                style={{
                  transform:
                    introStage >= 3
                      ? 'translate(42vw, -55vh)'
                      : 'translate(42vw, -38vh)',
                  opacity: introStage >= 3 ? 0 : 1,
                }}
              />

              {/* SQUARE 3: BOTTOM-LEFT (Small 14px Mint Square) */}
              <div
                className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-[#B5F5D1] rounded-[1px] shadow-sm transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] pointer-events-none"
                style={{
                  transform:
                    introStage >= 3
                      ? 'translate(-42vw, 55vh)'
                      : 'translate(-42vw, 38vh)',
                  opacity: introStage >= 3 ? 0 : 1,
                }}
              />

              {/* SQUARE 4: BOTTOM-RIGHT (Small 14px Mint Square) */}
              <div
                className="absolute w-3.5 h-3.5 sm:w-4 sm:h-4 bg-[#B5F5D1] rounded-[1px] shadow-sm transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] pointer-events-none"
                style={{
                  transform:
                    introStage >= 3
                      ? 'translate(42vw, 55vh)'
                      : 'translate(42vw, 38vh)',
                  opacity: introStage >= 3 ? 0 : 1,
                }}
              />

              {/* CENTER LOGO (Directly on dark-green background, NO BOX, NO GRID) */}
              <div
                className="absolute flex flex-col items-center justify-center transition-all duration-800 ease-[cubic-bezier(0.16,1,0.3,1)] z-10 pointer-events-none"
                style={{
                  opacity: introStage >= 1 ? 1 : 0,
                  transform:
                    introStage >= 3
                      ? 'translateY(-130px) scale(0.95)'
                      : introStage >= 1
                      ? 'translateY(0) scale(1)'
                      : 'translateY(0) scale(0.85)',
                }}
              >
                <div className="w-12 h-12 rounded-[2px] bg-[#B5F5D1] text-[#072118] flex items-center justify-center font-bold text-lg mb-2 shadow-[0_0_25px_rgba(181,245,209,0.35)]">
                  AL
                </div>
                <span className="text-xl sm:text-2xl font-bold tracking-[0.22em] text-[#D8FCE8]">
                  AROGYALEKH
                </span>
                <span className="text-[10px] font-mono text-[#648E77] tracking-widest mt-1">
                  CLINICAL INTELLIGENCE PLATFORM
                </span>
              </div>

              {/* 4 CONVERGING WORDS: TRAVEL FROM CORNERS/SIDES TOWARD THE CENTER */}
              {/* TOP-LEFT WORD: CAPTURE */}
              <span
                className="absolute text-xs sm:text-sm font-mono font-bold tracking-[0.25em] text-[#B5F5D1] pointer-events-none transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] z-10 select-none"
                style={{
                  transform:
                    introStage < 2
                      ? 'translate(-55vw, -45vh)'
                      : introStage === 2
                      ? 'translate(-95px, -68px)'
                      : 'translate(-95px, -198px)',
                  opacity: introStage === 2 ? 1 : 0,
                }}
              >
                CAPTURE
              </span>

              {/* TOP-RIGHT WORD: STRUCTURE */}
              <span
                className="absolute text-xs sm:text-sm font-mono font-bold tracking-[0.25em] text-[#B5F5D1] pointer-events-none transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] z-10 select-none"
                style={{
                  transform:
                    introStage < 2
                      ? 'translate(55vw, -45vh)'
                      : introStage === 2
                      ? 'translate(95px, -68px)'
                      : 'translate(95px, -198px)',
                  opacity: introStage === 2 ? 1 : 0,
                }}
              >
                STRUCTURE
              </span>

              {/* BOTTOM-LEFT WORD: VERIFY */}
              <span
                className="absolute text-xs sm:text-sm font-mono font-bold tracking-[0.25em] text-[#B5F5D1] pointer-events-none transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] z-10 select-none"
                style={{
                  transform:
                    introStage < 2
                      ? 'translate(-55vw, 45vh)'
                      : introStage === 2
                      ? 'translate(-95px, 68px)'
                      : 'translate(-95px, -62px)',
                  opacity: introStage === 2 ? 1 : 0,
                }}
              >
                VERIFY
              </span>

              {/* BOTTOM-RIGHT WORD: CARE */}
              <span
                className="absolute text-xs sm:text-sm font-mono font-bold tracking-[0.25em] text-[#B5F5D1] pointer-events-none transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] z-10 select-none"
                style={{
                  transform:
                    introStage < 2
                      ? 'translate(55vw, 45vh)'
                      : introStage === 2
                      ? 'translate(95px, 68px)'
                      : 'translate(95px, -62px)',
                  opacity: introStage === 2 ? 1 : 0,
                }}
              >
                CARE
              </span>

              {/* Minimal Skip Option */}
              <button
                onClick={() => setIntroStage(4)}
                className="absolute bottom-6 right-6 text-[10px] font-mono uppercase tracking-widest text-[#648E77]/60 hover:text-[#B5F5D1] transition-colors z-20"
              >
                Skip ↷
              </button>
            </div>
          </div>
        )}

        <main className="w-full">
          {/* ======================================================== */}
          {/* SECTION 1: HOMEPAGE IMAGE SECTION (HEALTHCARE DOCUMENTATION // ASHA 1 // MADE SIMPLER) */}
          {/* WITH FOUR CONCEPT WORDS: CAPTURE, STRUCTURE, VERIFY, CARE */}
          {/* ======================================================== */}
          <section className="relative min-h-[calc(100vh-5rem)] flex flex-col items-center justify-center px-4 sm:px-8 py-3 sm:py-6 overflow-hidden select-none">
            
            {/* TOP HEADLINE: Healthcare documentation */}
            <div className="text-center w-full mb-2 sm:mb-4 transition-all duration-700 animate-reveal-slow">
              <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight text-[#D8FCE8] text-center leading-none">
                Healthcare documentation
              </h1>
            </div>

            {/* CENTRAL IMAGE CANVAS WITH FOUR CONCEPT WORDS */}
            <div className="relative w-full max-w-4xl mx-auto flex flex-col items-center justify-center my-2 sm:my-3">
              
              {/* TOP CONCEPT WORDS: CAPTURE (Top Left) & STRUCTURE (Top Right) */}
              <div className="w-full max-w-[680px] flex justify-between items-center px-1 mb-2 text-xs sm:text-sm md:text-base font-mono font-bold tracking-[0.25em] text-[#648E77] select-none">
                <span className="hover:text-[#B5F5D1] transition-colors">CAPTURE</span>
                <span className="hover:text-[#B5F5D1] transition-colors">STRUCTURE</span>
              </div>

              {/* CENTRAL FRAMED IMAGE: asha1.jpg (Wide Horizontal Rectangle, 45-55vw Desktop) */}
              <div className="relative z-20 w-[88vw] sm:w-[48vw] max-w-[680px] aspect-[16/10] max-h-[320px] sm:max-h-[360px] rounded-[2px] border border-[#B5F5D1]/50 overflow-hidden bg-[#072118] shadow-2xl group transition-all duration-500 flex items-center justify-center">
                <img
                  src="/assets/images/asha1.jpg"
                  alt="Frontline ASHA Healthcare Worker"
                  className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.02]"
                  onError={(e) => {
                    e.target.style.display = 'none';
                    const fallback = e.target.parentElement.querySelector('.fallback-frame');
                    if (fallback) fallback.style.display = 'flex';
                  }}
                />
                {/* Fallback frame in case of image load delay */}
                <div className="fallback-frame hidden w-full h-full bg-[#0b2b20] items-center justify-center flex-col p-8 text-center">
                  <div className="w-10 h-10 rounded-[2px] bg-[#B5F5D1] text-[#072118] flex items-center justify-center font-bold text-sm mb-3">
                    AL
                  </div>
                  <span className="text-xs font-mono text-[#B5F5D1] uppercase tracking-widest">AROGYALEKH PLATFORM</span>
                  <span className="text-xs text-[#648E77] mt-2 max-w-xs">Frontline Clinical Documentation Protocol</span>
                </div>
              </div>

              {/* BOTTOM CONCEPT WORDS: VERIFY (Bottom Left) & CARE (Bottom Right) */}
              <div className="w-full max-w-[680px] flex justify-between items-center px-1 mt-2 text-xs sm:text-sm md:text-base font-mono font-bold tracking-[0.25em] text-[#648E77] select-none">
                <span className="hover:text-[#B5F5D1] transition-colors">VERIFY</span>
                <span className="hover:text-[#B5F5D1] transition-colors">CARE</span>
              </div>
            </div>

            {/* BOTTOM HEADLINE: made simpler. */}
            <div className="text-center w-full mt-2 sm:mt-4 transition-all duration-700 animate-reveal-slow">
              <h2 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight text-[#D8FCE8] text-center leading-none">
                made simpler.
              </h2>
            </div>
          </section>

          {/* ======================================================== */}
          {/* SECTION 2: EDITORIAL ACTION BAR & FULL-SCREEN MISSION SLIDE */}
          {/* ======================================================== */}
          <div className="max-w-5xl mx-auto px-6 py-12 flex flex-col sm:flex-row items-center justify-center gap-4 border-t border-[#164634]/60">
            <button
              onClick={() => setView('dashboard')}
              className="w-full sm:w-auto px-8 py-3.5 rounded-[2px] bg-[#B5F5D1] text-[#072118] font-bold text-xs uppercase tracking-wider hover:bg-[#c8fae0] transition-all active:scale-95 shadow-md flex items-center justify-center gap-2"
            >
              <span>Launch Worker Dashboard</span>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </button>

            <button
              onClick={() => setView('onboarding')}
              className="w-full sm:w-auto px-6 py-3.5 rounded-[2px] bg-[#0b2b20] text-[#D8FCE8] border border-[#164634] font-bold text-xs uppercase tracking-wider hover:border-[#B5F5D1]/50 transition-all"
            >
              Clinic Onboarding
            </button>

            <button
              onClick={() => setView('admin')}
              className="w-full sm:w-auto px-6 py-3.5 rounded-[2px] bg-[#0b2b20] text-[#D8FCE8] border border-[#164634] font-bold text-xs uppercase tracking-wider hover:border-[#B5F5D1]/50 transition-all"
            >
              Admin Telemetry
            </button>
          </div>

          {/* FULL-SCREEN EDITORIAL MISSION IMAGE SLIDE (ASHA2) */}
          <section
            ref={asha2Ref}
            className="relative w-full min-h-screen min-h-[100svh] overflow-hidden flex items-center select-none will-change-transform transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{
              opacity: asha2Visible ? 1 : 0,
              transform: asha2Visible
                ? 'translateY(0) scale(1)'
                : 'translateY(100px) scale(1.03)',
            }}
          >
            {/* Full-Bleed ASHA2 Background Photograph */}
            <img
              src="/assets/images/asha2.jpg"
              alt="Frontline Clinical Healthcare Workflow"
              className="absolute inset-0 w-full h-full object-cover object-center pointer-events-none"
              onError={(e) => {
                e.target.style.display = 'none';
                const fallback = e.target.parentElement.querySelector('.fallback-mission-bg');
                if (fallback) fallback.style.display = 'block';
              }}
            />

            {/* Fallback dark green background */}
            <div className="fallback-mission-bg hidden absolute inset-0 bg-[#072118]" />

            {/* Subtle Dark Gradient Overlay (Maintains high photograph clarity and sharp text contrast) */}
            <div className="absolute inset-0 bg-gradient-to-r from-[#072118]/85 via-[#072118]/50 to-[#072118]/25 sm:from-[#072118]/85 sm:via-[#072118]/50 sm:to-[#072118]/20 pointer-events-none" />

            {/* Seamless Top & Bottom Vignettes */}
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#072118] to-transparent pointer-events-none" />
            <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#072118] to-transparent pointer-events-none" />

            {/* Mission Text Overlay: Left Aligned, Vertically Centered */}
            <div className="relative z-10 w-full max-w-7xl mx-auto px-6 sm:px-12 md:px-16 flex flex-col justify-center py-20">
              <div className="max-w-2xl lg:max-w-3xl">
                <span className="text-xs sm:text-sm font-mono text-[#B5F5D1] tracking-[0.25em] uppercase block mb-4 sm:mb-6 font-semibold">
                  THE MISSION // FRONTLINE ACCELERATION
                </span>
                <h2 className="text-2xl sm:text-4xl lg:text-5xl font-bold text-[#D8FCE8] leading-tight sm:leading-snug tracking-tight mb-6 sm:mb-8 drop-shadow-sm">
                  Designed for frontline healthcare workers who operate between regional dialects and handwritten medical prescriptions.
                </h2>
                <p className="text-sm sm:text-base lg:text-lg text-[#A3D9BE] leading-relaxed max-w-2xl font-normal drop-shadow-sm">
                  Arogyalekh instantly captures consultation dialogue, synthesizes doctor handwriting via vision models, and generates safety-guarded clinical JSON without taking time away from the patient.
                </p>
              </div>
            </div>
          </section>

          {/* ======================================================== */}
          {/* SECTION 3: SCROLL-PINNED EDITORIAL PIPELINE STACK */}
          {/* FROM FIELD NOTES TO STRUCTURED RECORDS */}
          {/* ======================================================== */}
          <div ref={processScrollRef} className="relative w-full h-[320vh] sm:h-[350vh]">
            <section className="sticky top-0 h-screen w-full overflow-hidden flex flex-col justify-between py-6 sm:py-10 px-4 sm:px-10 bg-[#072118] border-t border-[#164634]/60">
              
              {/* SECTION HEADER & PROGRESS INDICATOR */}
              <div className="w-full max-w-6xl mx-auto flex flex-col md:flex-row md:items-end justify-between gap-4 sm:gap-6 z-20">
                <div className="max-w-2xl">
                  <span className="text-xs font-mono text-[#B5F5D1] tracking-[0.25em] uppercase block mb-2 font-semibold">
                    PIPELINE // VERIFIED CLINICAL TRANSFORMATION
                  </span>
                  <h2 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-[#D8FCE8] leading-tight">
                    FROM FIELD NOTES<br className="hidden sm:inline" /> TO STRUCTURED RECORDS.
                  </h2>
                  <p className="text-xs sm:text-sm text-[#A3D9BE] mt-2 font-normal leading-relaxed">
                    Arogyalekh transforms frontline healthcare information into structured, reviewable clinical records.
                  </p>
                </div>

                {/* Progress Indicator (01 - 05) */}
                <div className="flex items-center gap-1.5 sm:gap-2.5 bg-[#0b2b20] px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-[2px] border border-[#164634] select-none self-start md:self-auto">
                  <span className="text-[10px] font-mono text-[#648E77] uppercase tracking-wider mr-1 hidden sm:inline">
                    Phase:
                  </span>
                  {['01', '02', '03', '04', '05'].map((step, idx) => {
                    const stepNum = idx + 1;
                    const isActive = activeProcessStep === stepNum;
                    return (
                      <span
                        key={step}
                        className={`text-xs font-mono px-2 py-0.5 rounded-[1px] transition-all duration-300 ${
                          isActive
                            ? 'bg-[#B5F5D1] text-[#072118] font-bold shadow-[0_0_12px_rgba(181,245,209,0.35)]'
                            : 'text-[#648E77] hover:text-[#D8FCE8]'
                        }`}
                      >
                        {step}
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* CARD STACK STAGE (EDITORIAL OVERLAPPING COMPOSITION) */}
              <div className="relative w-full max-w-5xl mx-auto h-[440px] sm:h-[480px] flex items-center justify-center my-auto overflow-visible select-none">
                
                {/* CARD 01: CAPTURE */}
                <div
                  className="absolute w-[92%] sm:w-[350px] md:w-[370px] will-change-transform text-left cursor-pointer"
                  onMouseEnter={() => setHoveredProcessCard(1)}
                  onMouseLeave={() => setHoveredProcessCard(null)}
                  style={{
                    zIndex: hoveredProcessCard === 1 ? 60 : 10,
                    ...getCardAnimStyle(processProgress, 0.02, 0.24, -240, -18, -2),
                  }}
                >
                  <div
                    className="w-full h-full p-5 sm:p-6 rounded-[2px] bg-[#0b2b20] border border-[#164634] shadow-xl transition-all duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      transform:
                        hoveredProcessCard === 1 && isDesktop
                          ? 'translateY(-12px) scale(1.015)'
                          : 'translateY(0) scale(1)',
                      boxShadow:
                        hoveredProcessCard === 1 && isDesktop
                          ? '0 24px 50px -10px rgba(0,0,0,0.8), 0 0 25px rgba(181,245,209,0.15)'
                          : undefined,
                      borderColor:
                        hoveredProcessCard === 1 && isDesktop
                          ? 'rgba(181,245,209,0.5)'
                          : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2.5 border-b border-[#164634] pb-2">
                      <span className="text-xs font-mono font-bold tracking-widest text-[#B5F5D1]">
                        01 / CAPTURE
                      </span>
                      <span className="text-[10px] font-mono text-[#648E77] uppercase">Frontline Input</span>
                    </div>
                    
                    {/* Micro Editorial Visual Thumbnail */}
                    <div className="h-16 w-full rounded-[1px] overflow-hidden mb-3 border border-[#164634] relative">
                      <img
                        src="/assets/images/asha1.jpg"
                        alt="Frontline Ingestion"
                        className="w-full h-full object-cover object-center filter grayscale-[30%] contrast-[105%]"
                      />
                      <div className="absolute inset-0 bg-[#072118]/40" />
                      <span className="absolute bottom-1 right-1.5 text-[9px] font-mono text-[#B5F5D1] bg-[#072118]/80 px-1 py-0.5 rounded-[1px]">
                        ASHA FIELD UNIT
                      </span>
                    </div>

                    <h3 className="text-base sm:text-lg font-bold text-[#D8FCE8] mb-1.5">Multimodal Digital Input</h3>
                    <p className="text-xs text-[#A3D9BE] leading-relaxed mb-3">
                      Voice, text or handwritten notes become digital input.
                    </p>
                    <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                      <span className="px-2 py-0.5 bg-[#072118] border border-[#164634] rounded-[1px] text-[#B5F5D1]">
                        🎙 Regional Voice
                      </span>
                      <span className="px-2 py-0.5 bg-[#072118] border border-[#164634] rounded-[1px] text-[#A3D9BE]">
                        📄 Rx Handwriting
                      </span>
                    </div>
                  </div>
                </div>

                {/* CARD 02: STRUCTURE */}
                <div
                  className="absolute w-[92%] sm:w-[350px] md:w-[370px] will-change-transform text-left cursor-pointer"
                  onMouseEnter={() => setHoveredProcessCard(2)}
                  onMouseLeave={() => setHoveredProcessCard(null)}
                  style={{
                    zIndex: hoveredProcessCard === 2 ? 60 : 20,
                    ...getCardAnimStyle(processProgress, 0.18, 0.42, -120, 20, 1),
                  }}
                >
                  <div
                    className="w-full h-full p-5 sm:p-6 rounded-[2px] bg-[#0b2b20] border border-[#164634] shadow-2xl transition-all duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      transform:
                        hoveredProcessCard === 2 && isDesktop
                          ? 'translateY(-12px) scale(1.015)'
                          : 'translateY(0) scale(1)',
                      boxShadow:
                        hoveredProcessCard === 2 && isDesktop
                          ? '0 24px 50px -10px rgba(0,0,0,0.8), 0 0 25px rgba(181,245,209,0.15)'
                          : undefined,
                      borderColor:
                        hoveredProcessCard === 2 && isDesktop
                          ? 'rgba(181,245,209,0.5)'
                          : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2.5 border-b border-[#164634] pb-2">
                      <span className="text-xs font-mono font-bold tracking-widest text-[#B5F5D1]">
                        02 / STRUCTURE
                      </span>
                      <span className="text-[10px] font-mono text-[#648E77] uppercase">AI Extraction</span>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-[#D8FCE8] mb-1.5">Clinical Entity Extraction</h3>
                    <p className="text-xs text-[#A3D9BE] leading-relaxed mb-3">
                      AI extracts relevant clinical information into structured fields.
                    </p>
                    <div className="space-y-1.5 text-[11px] font-mono">
                      <div className="flex justify-between bg-[#072118] px-2.5 py-1 rounded-[1px] border border-[#164634]">
                        <span className="text-[#648E77]">Chief Complaint:</span>
                        <span className="text-[#D8FCE8] font-medium">Acute Pyrexia (3d)</span>
                      </div>
                      <div className="flex justify-between bg-[#072118] px-2.5 py-1 rounded-[1px] border border-[#164634]">
                        <span className="text-[#648E77]">Rx Entities:</span>
                        <span className="text-[#D8FCE8] font-medium">Paracetamol 650mg TDS</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CARD 03: VERIFY (STRONGEST VISUAL CONCEPT IN SECTION) */}
                <div
                  className="absolute w-[94%] sm:w-[390px] md:w-[410px] will-change-transform text-left cursor-pointer"
                  onMouseEnter={() => setHoveredProcessCard(3)}
                  onMouseLeave={() => setHoveredProcessCard(null)}
                  style={{
                    zIndex: hoveredProcessCard === 3 ? 60 : 30,
                    ...getCardAnimStyle(processProgress, 0.36, 0.60, 0, -10, -1),
                  }}
                >
                  <div
                    className="w-full h-full p-5 sm:p-6 rounded-[2px] bg-[#08291d] border-2 border-[#B5F5D1]/60 shadow-[0_12px_45px_rgba(7,33,24,0.85),0_0_30px_rgba(181,245,209,0.18)] transition-all duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      transform:
                        hoveredProcessCard === 3 && isDesktop
                          ? 'translateY(-12px) scale(1.015)'
                          : 'translateY(0) scale(1)',
                      boxShadow:
                        hoveredProcessCard === 3 && isDesktop
                          ? '0 28px 60px -10px rgba(0,0,0,0.9), 0 0 40px rgba(181,245,209,0.32)'
                          : undefined,
                      borderColor:
                        hoveredProcessCard === 3 && isDesktop
                          ? '#B5F5D1'
                          : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between mb-3 border-b border-[#164634] pb-2">
                      <span className="text-xs font-mono font-bold tracking-widest text-[#B5F5D1] flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#B5F5D1] animate-pulse"></span>
                        03 / VERIFY
                      </span>
                      <span className="text-[10px] font-mono text-[#B5F5D1] font-semibold uppercase">
                        Clinical Safety Triage
                      </span>
                    </div>
                    <h3 className="text-lg sm:text-xl font-bold text-[#D8FCE8] mb-1">Tri-State Separation</h3>
                    <p className="text-xs text-[#A3D9BE] leading-relaxed mb-3">
                      Information is separated into:
                    </p>
                    
                    {/* Tri-State Visual Pillar */}
                    <div className="space-y-2 text-xs font-mono">
                      <div className="p-2 rounded-[1px] bg-emerald-950/70 border border-emerald-500/50 flex items-center justify-between text-emerald-300">
                        <span className="font-bold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                          CONFIRMED
                        </span>
                        <span className="text-[10px] text-emerald-400/80">98% Rx match verified</span>
                      </div>

                      <div className="p-2 rounded-[1px] bg-amber-950/60 border border-amber-500/50 flex items-center justify-between text-amber-300">
                        <span className="font-bold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                          UNCERTAIN
                        </span>
                        <span className="text-[10px] text-amber-400/80">Doctor handwriting flagged</span>
                      </div>

                      <div className="p-2 rounded-[1px] bg-rose-950/60 border border-rose-500/50 flex items-center justify-between text-rose-300">
                        <span className="font-bold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-rose-400"></span>
                          MISSING
                        </span>
                        <span className="text-[10px] text-rose-400/80">Dosage frequency required</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* CARD 04: REVIEW */}
                <div
                  className="absolute w-[92%] sm:w-[350px] md:w-[370px] will-change-transform text-left cursor-pointer"
                  onMouseEnter={() => setHoveredProcessCard(4)}
                  onMouseLeave={() => setHoveredProcessCard(null)}
                  style={{
                    zIndex: hoveredProcessCard === 4 ? 60 : 40,
                    ...getCardAnimStyle(processProgress, 0.54, 0.78, 120, 24, 1.5),
                  }}
                >
                  <div
                    className="w-full h-full p-5 sm:p-6 rounded-[2px] bg-[#0b2b20] border border-[#164634] shadow-2xl transition-all duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      transform:
                        hoveredProcessCard === 4 && isDesktop
                          ? 'translateY(-12px) scale(1.015)'
                          : 'translateY(0) scale(1)',
                      boxShadow:
                        hoveredProcessCard === 4 && isDesktop
                          ? '0 24px 50px -10px rgba(0,0,0,0.8), 0 0 25px rgba(181,245,209,0.15)'
                          : undefined,
                      borderColor:
                        hoveredProcessCard === 4 && isDesktop
                          ? 'rgba(181,245,209,0.5)'
                          : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2.5 border-b border-[#164634] pb-2">
                      <span className="text-xs font-mono font-bold tracking-widest text-[#B5F5D1]">
                        04 / REVIEW
                      </span>
                      <span className="text-[10px] font-mono text-[#648E77] uppercase">Frontline Human</span>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-[#D8FCE8] mb-1.5">Healthcare Worker Review</h3>
                    <p className="text-xs text-[#A3D9BE] leading-relaxed mb-3">
                      The healthcare worker reviews and edits the AI-generated information before submission.
                    </p>
                    <div className="p-2 bg-[#072118] border border-[#164634] rounded-[1px] flex items-center justify-between text-[11px] font-mono">
                      <span className="text-[#648E77]">Frontline Reviewer:</span>
                      <span className="text-[#B5F5D1] font-bold">ASHA Worker Signed ✓</span>
                    </div>
                  </div>
                </div>

                {/* CARD 05: RECORD */}
                <div
                  className="absolute w-[92%] sm:w-[350px] md:w-[370px] will-change-transform text-left cursor-pointer"
                  onMouseEnter={() => setHoveredProcessCard(5)}
                  onMouseLeave={() => setHoveredProcessCard(null)}
                  style={{
                    zIndex: hoveredProcessCard === 5 ? 60 : 50,
                    ...getCardAnimStyle(processProgress, 0.72, 0.94, 240, -14, 0),
                  }}
                >
                  <div
                    className="w-full h-full p-5 sm:p-6 rounded-[2px] bg-[#0b2b20] border border-[#164634] shadow-2xl transition-all duration-350 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      transform:
                        hoveredProcessCard === 5 && isDesktop
                          ? 'translateY(-12px) scale(1.015)'
                          : 'translateY(0) scale(1)',
                      boxShadow:
                        hoveredProcessCard === 5 && isDesktop
                          ? '0 24px 50px -10px rgba(0,0,0,0.8), 0 0 25px rgba(181,245,209,0.15)'
                          : undefined,
                      borderColor:
                        hoveredProcessCard === 5 && isDesktop
                          ? 'rgba(181,245,209,0.5)'
                          : undefined,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2.5 border-b border-[#164634] pb-2">
                      <span className="text-xs font-mono font-bold tracking-widest text-[#B5F5D1]">
                        05 / RECORD
                      </span>
                      <span className="text-[10px] font-mono text-[#648E77] uppercase">Final Artifact</span>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-[#D8FCE8] mb-1.5">Structured Clinical Record</h3>
                    <p className="text-xs text-[#A3D9BE] leading-relaxed mb-3">
                      The approved information becomes a structured clinical record.
                    </p>
                    <div className="p-2 bg-[#072118] border border-emerald-500/40 rounded-[1px] text-[11px] font-mono flex items-center justify-between text-emerald-300">
                      <span className="font-bold">EHR Synced</span>
                      <span className="text-[10px] text-[#648E77]">HL7 FHIR JSON Schema</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* BOTTOM LABELS / INDEX LINE */}
              <div className="w-full max-w-6xl mx-auto pt-3 border-t border-[#164634]/60 flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-[#648E77]">
                <div className="flex flex-wrap items-center gap-3 sm:gap-6">
                  {[
                    { n: '1', label: 'Capture' },
                    { n: '2', label: 'Structure' },
                    { n: '3', label: 'Verify' },
                    { n: '4', label: 'Review' },
                    { n: '5', label: 'Record' },
                  ].map((item, idx) => {
                    const stepNum = idx + 1;
                    const isActive = activeProcessStep === stepNum;
                    return (
                      <span
                        key={item.n}
                        className={`transition-colors duration-200 ${
                          isActive ? 'text-[#B5F5D1] font-bold' : 'hover:text-[#D8FCE8]'
                        }`}
                      >
                        {item.n}. {item.label}
                      </span>
                    );
                  })}
                </div>
                <div className="text-[10px] text-[#648E77] tracking-widest uppercase hidden md:block">
                  Scroll To Sequence ↕
                </div>
              </div>

            </section>
          </div>

          {/* ======================================================== */}
          {/* SECTION 04: EXACT SCROLL-DRIVEN FLY-THROUGH (FIELD TO RECORD) */}
          {/* ======================================================== */}
          <section className="arogyalekh-field-record" id="field-record" ref={fieldRecordSectionRef}>

            <div className="field-record-header">
              <div>
                <span>Chapter 04</span>
                <span>Field to Record</span>
              </div>

              <p>
                From frontline conversations and handwritten notes
                to structured, reviewable healthcare records.
              </p>
            </div>

            <div className="field-record-space">
              <div className="field-record-stage">

                {/* CENTRAL TITLE */}
                <div className="field-record-title">
                  <span>Field</span>
                  <strong>to Record</strong>
                </div>

                {/* IMAGE 01 */}
                <figure className="field-image field-image-one">
                  <img
                    src="/assets/images/asha1.jpg"
                    alt="Arogyalekh frontline healthcare"
                  />
                  <figcaption>
                    01 / FIELD CAPTURE
                  </figcaption>
                </figure>

                {/* IMAGE 02 */}
                <figure className="field-image field-image-two">
                  <img
                    src="/assets/images/asha2.jpg"
                    alt="Arogyalekh healthcare documentation"
                  />
                  <figcaption>
                    02 / PATIENT CONTEXT
                  </figcaption>
                </figure>

                {/* IMAGE 03 */}
                <figure className="field-image field-image-three">
                  <img
                    src="/assets/images/asha3.jpg"
                    alt="Arogyalekh voice input"
                  />
                  <figcaption>
                    03 / VOICE INPUT
                  </figcaption>
                </figure>

                {/* IMAGE 04 */}
                <figure className="field-image field-image-four">
                  <img
                    src="/assets/images/asha4.jpg"
                    alt="Arogyalekh visual evidence"
                  />
                  <figcaption>
                    04 / VISUAL EVIDENCE
                  </figcaption>
                </figure>

                {/* IMAGE 05 */}
                <figure className="field-image field-image-five">
                  <img
                    src="/assets/images/asha5.jpg"
                    alt="Arogyalekh structured clinical information"
                  />
                  <figcaption>
                    05 / STRUCTURED DATA
                  </figcaption>
                </figure>

                {/* IMAGE 06 */}
                <figure className="field-image field-image-six">
                  <img
                    src="/assets/images/asha6.jpg"
                    alt="Arogyalekh verification"
                  />
                  <figcaption>
                    06 / VERIFICATION
                  </figcaption>
                </figure>

                {/* IMAGE 07 */}
                <figure className="field-image field-image-seven">
                  <img
                    src="/assets/images/asha7.jpg"
                    alt="Arogyalekh human review"
                  />
                  <figcaption>
                    07 / HUMAN REVIEW
                  </figcaption>
                </figure>

                {/* IMAGE 08 */}
                <figure className="field-image field-image-eight">
                  <img
                    src="/assets/images/asha8.jpg"
                    alt="Arogyalekh final clinical record"
                  />
                  <figcaption>
                    08 / FINAL RECORD
                  </figcaption>
                </figure>

                {/* CENTER COPY */}
                <div className="field-record-center-copy">
                  <span>AROGYALEKH / 04</span>
                  <p>
                    Real-world frontline information,
                    transformed into structured documentation.
                  </p>
                </div>

                {/* SCROLL INDICATOR */}
                <div className="field-record-scroll">
                  (scroll down)
                </div>

              </div>
            </div>

          </section>

          {/* ======================================================== */}
          {/* SECTION 5: EDITORIAL CAPABILITIES GRID */}
          {/* ======================================================== */}
          <section className="max-w-5xl mx-auto px-6 py-24 border-t border-[#164634]/60">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div>
                <span className="text-xs font-mono text-[#648E77] block mb-2">01 // INGESTION</span>
                <h3 className="text-xl font-bold text-[#D8FCE8] mb-3">Multimodal Vision</h3>
                <p className="text-xs text-[#648E77] leading-relaxed">
                  Direct OCR and clinical reasoning across complex handwritten notes and dosage schedules.
                </p>
              </div>

              <div>
                <span className="text-xs font-mono text-[#648E77] block mb-2">02 // DIALECT ENGINE</span>
                <h3 className="text-xl font-bold text-[#D8FCE8] mb-3">Voice to Structured Data</h3>
                <p className="text-xs text-[#648E77] leading-relaxed">
                  Continuous frontline speech transcription normalized from Hinglish into standard medical terminology.
                </p>
              </div>

              <div>
                <span className="text-xs font-mono text-[#648E77] block mb-2">03 // CLINICAL SAFETY</span>
                <h3 className="text-xl font-bold text-[#D8FCE8] mb-3">Identity Guards</h3>
                <p className="text-xs text-[#648E77] leading-relaxed">
                  Automatic cross-verification preventing prescription mismatches prior to pharmacy dispensation.
                </p>
              </div>
            </div>
          </section>
        </main>

        {/* Global Minimal Footer with Replay Intro Trigger */}
        <footer className="border-t border-[#164634]/80 py-8 px-6 sm:px-10">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs font-mono text-[#648E77]">
            <div>AROGYALEKH // CLINICAL ARCHITECTURE PROTOCOL v2.4</div>
            <div className="flex items-center gap-6">
              <button
                onClick={() => {
                  setIntroStage(0);
                  setTimeout(() => setIntroStage(1), 450);
                  setTimeout(() => setIntroStage(2), 1250);
                  setTimeout(() => setIntroStage(3), 2600);
                  setTimeout(() => setIntroStage(4), 3400);
                }}
                className="hover:text-[#B5F5D1] transition-colors"
              >
                ↻ Replay Opening
              </button>
              <span onClick={() => setView('login')} className="hover:text-[#D8FCE8] cursor-pointer">Staff Portal</span>
              <span onClick={() => setView('settings')} className="hover:text-[#D8FCE8] cursor-pointer">System Settings</span>
            </div>
          </div>
        </footer>
      </div>
    );
  }
  // ==========================================
  // VIEW: DASHBOARD (FRONTLINE WORKER PORTAL)
  // ==========================================
  if (view === 'dashboard') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <OfflineBanner />
        <Header />
        <FullScreenMenu />
        <Toast />

        <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 md:px-10 py-6 sm:py-8 flex flex-col animate-reveal-slow">
          
          {/* Dashboard Header area */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
            <div>
              <span className="text-xs font-mono text-[#648E77] block mb-1 uppercase tracking-widest">Arogyalekh Operations</span>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#D8FCE8]">Active Registry</h1>
            </div>
            
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="relative group">
                <input
                  type="text"
                  placeholder="Search ID, Name, Location..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full sm:w-64 bg-[#0b2b20] text-sm text-[#D8FCE8] border border-[#164634] rounded-[2px] px-3.5 py-2.5 outline-none focus:border-[#B5F5D1]/50 focus:bg-[#0f382a] transition-all placeholder-[#648E77]"
                />
                <svg className="absolute right-3 top-3 w-4 h-4 text-[#648E77] group-focus-within:text-[#B5F5D1] transition-colors pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <button
                onClick={() => setView('add_patient')}
                className="bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] px-4 py-2.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-all active:scale-95 shadow-sm whitespace-nowrap flex items-center justify-center gap-2"
              >
                <span>+ New Registration</span>
              </button>
            </div>
          </div>

          {/* Quick Stats Panel (Matching Exact UI) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8">
            <div className="bg-[#0b2b20] border border-[#164634] p-4 sm:p-5 rounded-[2px] flex flex-col justify-between hover:border-[#B5F5D1]/30 transition-colors">
              <span className="text-[10px] sm:text-xs font-mono text-[#648E77] uppercase tracking-wider mb-2">Total Patients</span>
              <span className="text-2xl sm:text-3xl font-bold text-[#D8FCE8]">{patients.length}</span>
            </div>
            <div className="bg-[#0b2b20] border border-[#164634] p-4 sm:p-5 rounded-[2px] flex flex-col justify-between hover:border-[#B5F5D1]/30 transition-colors">
              <span className="text-[10px] sm:text-xs font-mono text-[#648E77] uppercase tracking-wider mb-2">Active Cases</span>
              <span className="text-2xl sm:text-3xl font-bold text-[#D8FCE8]">{cases.length}</span>
            </div>
            <div className="bg-[#0b2b20] border border-[#164634] p-4 sm:p-5 rounded-[2px] flex flex-col justify-between hover:border-[#B5F5D1]/30 transition-colors">
              <span className="text-[10px] sm:text-xs font-mono text-[#648E77] uppercase tracking-wider mb-2">Network Status</span>
              <span className="text-sm sm:text-base font-bold text-[#B5F5D1] flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}></span>
                {isOnline ? "Online & Synced" : "Offline (Local)"}
              </span>
            </div>
            <div className="bg-[#0b2b20] border border-[#164634] p-4 sm:p-5 rounded-[2px] flex flex-col justify-between hover:border-[#B5F5D1]/30 transition-colors">
              <span className="text-[10px] sm:text-xs font-mono text-[#648E77] uppercase tracking-wider mb-2">Pending Sync</span>
              <span className="text-2xl sm:text-3xl font-bold text-amber-200">{syncQueue.length}</span>
            </div>
          </div>

          {/* Pending-review counter (spec names this empty state explicitly) */}
          <div className="mb-8 p-4 bg-[#0b2b20] border border-[#164634] rounded-[2px] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <span className="block text-[10px] font-mono text-[#648E77] uppercase tracking-wider mb-1">Pending Reviews</span>
              <span className="text-sm text-[#D8FCE8]">
                {pendingReviewCases.length === 0
                  ? 'No pending reviews.'
                  : `${pendingReviewCases.length} case(s) awaiting clinical review.`}
              </span>
            </div>
            {pendingReviewCases.length > 0 && (
              <ul className="text-[10px] font-mono text-amber-200 space-y-0.5">
                {pendingReviewCases.slice(0, 3).map((item) => (
                  <li key={item.id}>#{String(item.id).padStart(4, '0')} — {item.reason}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Patient Roster / Error / Empty States */}
          {loadingData ? (
            <div className="flex-grow flex flex-col items-center justify-center p-12 bg-[#0b2b20]/50 border border-[#164634] rounded-[2px]">
              <div className="w-8 h-8 border-2 border-[#164634] border-t-[#B5F5D1] rounded-full animate-spin mb-4"></div>
              <span className="text-xs font-mono text-[#648E77] uppercase tracking-widest">Loading Registry...</span>
            </div>
          ) : dataError ? (
            <div className="flex-grow flex flex-col items-center justify-center p-12 bg-rose-950/20 border border-rose-900/50 rounded-[2px]">
              <svg className="w-10 h-10 text-rose-500/50 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm text-rose-200 mb-2">{dataError}</span>
              <button onClick={fetchPatients} className="text-xs font-mono text-rose-300 hover:text-white underline underline-offset-4 mt-2">Retry Connection</button>
            </div>
          ) : filteredPatients.length === 0 ? (
            <div className="flex-grow flex flex-col items-center justify-center p-12 bg-[#0b2b20]/30 border border-[#164634]/50 rounded-[2px]">
              <span className="text-4xl mb-4 opacity-50">📂</span>
              <span className="text-sm font-medium text-[#A3D9BE] mb-1">No patients found.</span>
              <span className="text-xs font-mono text-[#648E77]">Register a new patient to begin documentation.</span>
            </div>
          ) : (
            <div className="bg-[#0b2b20] border border-[#164634] rounded-[2px] overflow-hidden shadow-lg">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#072118] border-b border-[#164634]">
                      <th className="px-5 py-4 text-[10px] font-mono text-[#648E77] uppercase tracking-widest">ID</th>
                      <th className="px-5 py-4 text-[10px] font-mono text-[#648E77] uppercase tracking-widest">Name</th>
                      <th className="px-5 py-4 text-[10px] font-mono text-[#648E77] uppercase tracking-widest">Details</th>
                      <th className="px-5 py-4 text-[10px] font-mono text-[#648E77] uppercase tracking-widest">Location</th>
                      <th className="px-5 py-4 text-[10px] font-mono text-[#648E77] uppercase tracking-widest text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#164634]/50">
                    {filteredPatients.map((p) => (
                      <tr 
                        key={p.id} 
                        className="hover:bg-[#0f382a]/80 transition-colors cursor-pointer group"
                        onClick={() => handleSelectPatient(p)}
                      >
                        <td className="px-5 py-4 whitespace-nowrap text-xs font-mono text-[#648E77] group-hover:text-[#B5F5D1]">
                          #{p.id.toString().padStart(4, '0')}
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap font-medium text-[#D8FCE8] text-sm group-hover:text-white">
                          {p.name}
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap text-xs text-[#A3D9BE]">
                          {p.age}y • {p.gender}
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap text-xs text-[#648E77]">
                          {p.location}
                        </td>
                        <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-mono">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectPatient(p);
                            }}
                            className="text-[#B5F5D1] hover:text-white opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-wider"
                          >
                            Open Profile →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: ADD PATIENT (MULTI-STEP REGISTRATION)
  // ==========================================
  if (view === 'add_patient') {
    if (!requireAccess('create_patient')) {
      return (
        <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-center items-center font-sans">
          <Header />
          <FullScreenMenu />
          <Toast />
          <div className="text-center px-6">
            <h1 className="text-lg font-bold text-rose-300 mb-2">Not permitted to register patients</h1>
            <p className="text-xs font-mono text-[#648E77] mb-6">
              {roleLabel(currentRole)} cannot create patient records. This attempt has been
              recorded in the audit log.
            </p>
            <button
              onClick={() => setView('dashboard')}
              className="text-xs font-mono text-[#B5F5D1] hover:text-white uppercase underline underline-offset-4 tracking-wider"
            >
              Return to Registry
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <OfflineBanner />
        <Header />
        <FullScreenMenu />
        <Toast />

        <main className="flex-grow max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-12 flex flex-col animate-reveal-slow">
          <button 
            onClick={() => setView('dashboard')}
            className="self-start mb-6 text-[10px] font-mono text-[#648E77] hover:text-[#B5F5D1] uppercase tracking-widest transition-colors flex items-center gap-1.5"
          >
            <span>← Back to Registry</span>
          </button>

          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight text-[#D8FCE8] mb-2">New Patient Registration</h1>
            <p className="text-sm text-[#A3D9BE]">Enter details to create a new clinical profile.</p>
          </div>

          {/* Stepper */}
          <div className="flex items-center mb-8 text-xs font-mono">
            <div className={`flex items-center gap-2 ${patientRegStep >= 1 ? 'text-[#B5F5D1]' : 'text-[#648E77]'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center border ${patientRegStep >= 1 ? 'border-[#B5F5D1] bg-[#B5F5D1]/10' : 'border-[#648E77]'}`}>1</span>
              <span className="uppercase tracking-wider hidden sm:inline">Basic Info</span>
            </div>
            <div className={`h-px w-8 sm:w-16 mx-2 sm:mx-4 ${patientRegStep >= 2 ? 'bg-[#B5F5D1]/50' : 'bg-[#164634]'}`}></div>
            <div className={`flex items-center gap-2 ${patientRegStep >= 2 ? 'text-[#B5F5D1]' : 'text-[#648E77]'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center border ${patientRegStep >= 2 ? 'border-[#B5F5D1] bg-[#B5F5D1]/10' : 'border-[#648E77]'}`}>2</span>
              <span className="uppercase tracking-wider hidden sm:inline">Medical History</span>
            </div>
            <div className={`h-px w-8 sm:w-16 mx-2 sm:mx-4 ${patientRegStep >= 3 ? 'bg-[#B5F5D1]/50' : 'bg-[#164634]'}`}></div>
            <div className={`flex items-center gap-2 ${patientRegStep >= 3 ? 'text-[#B5F5D1]' : 'text-[#648E77]'}`}>
              <span className={`w-5 h-5 rounded-full flex items-center justify-center border ${patientRegStep >= 3 ? 'border-[#B5F5D1] bg-[#B5F5D1]/10' : 'border-[#648E77]'}`}>3</span>
              <span className="uppercase tracking-wider hidden sm:inline">Confirm</span>
            </div>
          </div>

          <form onSubmit={handleRegisterPatient} className="bg-[#0b2b20] border border-[#164634] p-6 sm:p-8 rounded-[2px] shadow-2xl flex flex-col gap-6 relative">
            
            {patientRegStep === 1 && (
              <div className="animate-reveal-slow space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Full Name *</label>
                    <input 
                      type="text" 
                      required
                      value={newPatientName} 
                      onChange={(e) => setNewPatientName(e.target.value)}
                      className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                      placeholder="e.g. Ramesh Kumar"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Phone Number</label>
                    <input 
                      type="tel" 
                      value={newPatientPhone} 
                      onChange={(e) => setNewPatientPhone(e.target.value)}
                      className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                      placeholder="+91"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-5">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Age *</label>
                    <input 
                      type="number" 
                      required min="0" max="150"
                      value={newPatientAge} 
                      onChange={(e) => setNewPatientAge(e.target.value)}
                      className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                      placeholder="Years"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Gender *</label>
                    <div className="relative">
                      <select 
                        value={newPatientGender} 
                        onChange={(e) => setNewPatientGender(e.target.value)}
                        className="w-full appearance-none bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors cursor-pointer"
                      >
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                        <option value="Other">Other</option>
                      </select>
                      <svg className="absolute right-3 top-3.5 w-4 h-4 text-[#648E77] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
                    <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Blood Group</label>
                    <div className="relative">
                      <select 
                        value={newPatientBloodGroup} 
                        onChange={(e) => setNewPatientBloodGroup(e.target.value)}
                        className="w-full appearance-none bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors cursor-pointer"
                      >
                        <option value="">Unknown</option>
                        <option value="A+">A+</option><option value="A-">A-</option>
                        <option value="B+">B+</option><option value="B-">B-</option>
                        <option value="AB+">AB+</option><option value="AB-">AB-</option>
                        <option value="O+">O+</option><option value="O-">O-</option>
                      </select>
                      <svg className="absolute right-3 top-3.5 w-4 h-4 text-[#648E77] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Village / Location *</label>
                  <input 
                    type="text" 
                    required
                    value={newPatientLocation} 
                    onChange={(e) => setNewPatientLocation(e.target.value)}
                    className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                    placeholder="e.g. Ward 4, Rampur"
                  />
                </div>

                <button 
                  type="button" 
                  onClick={() => setPatientRegStep(2)}
                  className="w-full mt-2 bg-[#164634] hover:bg-[#1f6148] text-[#D8FCE8] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors"
                >
                  Continue →
                </button>
              </div>
            )}

            {patientRegStep === 2 && (
              <div className="animate-reveal-slow space-y-5">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Known Allergies</label>
                  <input 
                    type="text" 
                    value={newPatientAllergies} 
                    onChange={(e) => setNewPatientAllergies(e.target.value)}
                    className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                    placeholder="e.g. Penicillin, Peanuts (or leave blank)"
                  />
                </div>
                
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Emergency Contact</label>
                  <input 
                    type="text" 
                    value={newPatientEmergencyContact} 
                    onChange={(e) => setNewPatientEmergencyContact(e.target.value)}
                    className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                    placeholder="Name & Number"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">ABHA ID / Gov Health ID (Optional)</label>
                  <input 
                    type="text" 
                    value={newPatientAbhaId} 
                    onChange={(e) => setNewPatientAbhaId(e.target.value)}
                    className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none transition-colors"
                    placeholder="XX-XXXX-XXXX-XXXX"
                  />
                </div>

                <div className="flex gap-4 mt-2">
                  <button 
                    type="button" 
                    onClick={() => setPatientRegStep(1)}
                    className="w-1/3 bg-transparent border border-[#164634] hover:border-[#648E77] text-[#648E77] hover:text-[#D8FCE8] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors"
                  >
                    ← Back
                  </button>
                  <button 
                    type="button" 
                    onClick={() => setPatientRegStep(3)}
                    className="w-2/3 bg-[#164634] hover:bg-[#1f6148] text-[#D8FCE8] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors"
                  >
                    Review Details →
                  </button>
                </div>
              </div>
            )}

            {patientRegStep === 3 && (
              <div className="animate-reveal-slow space-y-6">
                <div className="bg-[#072118] border border-[#164634] p-5 rounded-[2px] space-y-3">
                  <h3 className="text-xs font-mono text-[#B5F5D1] uppercase tracking-widest border-b border-[#164634] pb-2 mb-3">Profile Summary</h3>
                  <div className="grid grid-cols-2 gap-y-3 text-sm">
                    <div>
                      <span className="block text-[10px] font-mono text-[#648E77] uppercase">Name</span>
                      <span className="text-[#D8FCE8] font-medium">{newPatientName || "-"}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono text-[#648E77] uppercase">Age / Gender</span>
                      <span className="text-[#D8FCE8] font-medium">{newPatientAge || "-"} / {newPatientGender}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono text-[#648E77] uppercase">Location</span>
                      <span className="text-[#D8FCE8] font-medium">{newPatientLocation || "-"}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono text-[#648E77] uppercase">Blood Group</span>
                      <span className="text-[#D8FCE8] font-medium">{newPatientBloodGroup || "Unspecified"}</span>
                    </div>
                    <div className="col-span-2">
                      <span className="block text-[10px] font-mono text-[#648E77] uppercase">Allergies</span>
                      <span className="text-[#D8FCE8] font-medium">{newPatientAllergies || "None documented"}</span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-4">
                  <button 
                    type="button" 
                    disabled={isSubmittingPatient}
                    onClick={() => setPatientRegStep(2)}
                    className="w-1/3 bg-transparent border border-[#164634] hover:border-[#648E77] text-[#648E77] hover:text-[#D8FCE8] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button 
                    type="submit" 
                    disabled={isSubmittingPatient}
                    className="w-2/3 bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-all active:scale-95 disabled:opacity-70 flex items-center justify-center gap-2"
                  >
                    {isSubmittingPatient ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-[#072118] border-t-transparent rounded-full animate-spin"></div>
                        <span>Registering...</span>
                      </>
                    ) : (
                      <>
                        <span>✓ Confirm & Register</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </form>
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: PATIENT PROFILE & TIMELINE
  // ==========================================
  if (view === 'patient') {
    if (!selectedPatient) {
      setView('dashboard');
      return null;
    }

    // Spec: "Access to patient information must be controlled according to the user's
    // role and permissions." The refusal is recorded as an unauthorised access attempt.
    if (!requireAccess('view_patients')) {
      return (
        <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-center items-center font-sans">
          <Header />
          <FullScreenMenu />
          <Toast />
          <div className="text-center px-6">
            <h1 className="text-lg font-bold text-rose-300 mb-2">Patient records are restricted</h1>
            <p className="text-xs font-mono text-[#648E77] mb-6">
              {roleLabel(currentRole)} does not have permission to view patient information.
              This attempt has been recorded in the audit log.
            </p>
            <button
              onClick={() => setView('dashboard')}
              className="text-xs font-mono text-[#B5F5D1] hover:text-white uppercase underline underline-offset-4 tracking-wider"
            >
              Return to Registry
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <OfflineBanner />
        <Header />
        <FullScreenMenu />
        <Toast />

        <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 md:px-10 py-6 sm:py-8 animate-reveal-slow flex flex-col md:flex-row gap-6 lg:gap-10 items-start">
          
          {/* LEFT COL: Patient Summary Card */}
          <div className="w-full md:w-1/3 shrink-0 flex flex-col gap-4 sticky top-28">
            <button 
              onClick={() => setView('dashboard')}
              className="self-start text-[10px] font-mono text-[#648E77] hover:text-[#B5F5D1] uppercase tracking-widest transition-colors flex items-center gap-1.5"
            >
              <span>← Back to Registry</span>
            </button>
            
            <div className="bg-[#0b2b20] border border-[#164634] rounded-[2px] overflow-hidden shadow-xl mt-2">
              <div className="p-6 border-b border-[#164634] bg-gradient-to-b from-[#0f382a]/50 to-transparent">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-12 h-12 rounded-[2px] bg-[#164634] flex items-center justify-center text-xl font-bold text-[#D8FCE8]">
                    {selectedPatient.name.charAt(0)}
                  </div>
                  <span className="text-[10px] font-mono text-[#B5F5D1] bg-[#164634] px-2 py-1 rounded-[1px]">
                    ID: #{selectedPatient.id.toString().padStart(4, '0')}
                  </span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#D8FCE8] leading-tight mb-1">
                  {selectedPatient.name}
                </h1>
                <p className="text-sm text-[#A3D9BE] flex items-center gap-2">
                  <span>{selectedPatient.age}y</span>
                  <span className="w-1 h-1 bg-[#648E77] rounded-full"></span>
                  <span>{selectedPatient.gender}</span>
                  <span className="w-1 h-1 bg-[#648E77] rounded-full"></span>
                  <span>{selectedPatient.location}</span>
                </p>
              </div>
              
              {/* Quick Medical Facts */}
              <div className="p-6 space-y-4">
                <div className="flex items-start justify-between">
                  <span className="text-xs font-mono text-[#648E77] uppercase">Blood Group</span>
                  <span className="text-sm font-medium text-[#D8FCE8]">
                    {displayClinicalValue(selectedPatient, 'blood_group')}
                  </span>
                </div>
                <div className="flex items-start justify-between border-t border-[#164634]/50 pt-4">
                  <span className="text-xs font-mono text-[#648E77] uppercase">Allergies</span>
                  <span className={`text-sm font-medium ${selectedPatient.allergies ? 'text-rose-300' : 'text-[#648E77]'}`}>
                    {displayClinicalValue(selectedPatient, 'allergies')}
                  </span>
                </div>
                <div className="flex items-start justify-between border-t border-[#164634]/50 pt-4">
                  <span className="text-xs font-mono text-[#648E77] uppercase">Last Visit</span>
                  <span className="text-sm font-medium text-[#D8FCE8]">
                    {cases.length > 0 ? new Date(cases[0].created_at).toLocaleDateString() : "New Patient"}
                  </span>
                </div>
              </div>

              <div className="p-4 bg-[#072118] border-t border-[#164634] flex flex-col gap-2">
                <button
                  onClick={() => setView('capture')}
                  className="w-full bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-3 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-all shadow-sm flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                  New Consultation
                </button>
                <button
                  onClick={() => handleDeletePatient(selectedPatient.id)}
                  className="w-full text-xs font-mono text-rose-500/70 hover:text-rose-400 py-2 transition-colors underline underline-offset-4"
                >
                  Delete Patient Record
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT COL: Clinical Timeline */}
          <div className="w-full md:w-2/3 flex flex-col mt-8 md:mt-10">

            {/* Requires attention (spec: pending follow-ups, unresolved issues surfaced here) */}
            {profileAttention.length > 0 && (
              <div className="mb-6 p-4 border border-amber-500/40 bg-amber-950/20 rounded-[2px]">
                <h3 className="text-[10px] font-mono text-amber-300 uppercase mb-3">Requires Attention</h3>
                <ul className="space-y-1.5">
                  {profileAttention.map((item, idx) => (
                    <li key={idx} className="flex items-baseline gap-2 text-xs text-amber-100">
                      <span className="text-[9px] font-mono uppercase text-amber-400 shrink-0">{item.label}</span>
                      <span className="truncate">{item.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Provenance (spec: distinguish worker / AI / human-corrected / doctor information) */}
            {caseProvenance && (
              <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { key: 'worker', label: 'Worker entered' },
                  { key: 'ai', label: 'AI extracted' },
                  { key: 'human', label: 'Human corrected' },
                  { key: 'doctor', label: 'Doctor added' },
                ].map(({ key, label }) => (
                  <div key={key} className="bg-[#0b2b20] border border-[#164634] p-3 rounded-[1px]">
                    <span className="block text-[9px] font-mono text-[#648E77] uppercase mb-1">{label}</span>
                    <span className="text-lg font-bold text-[#D8FCE8]">{caseProvenance[key] || 0}</span>
                  </div>
                ))}
              </div>
            )}

            <h2 className="text-sm font-mono text-[#648E77] uppercase tracking-widest border-b border-[#164634] pb-3 mb-6">
              Clinical Encounter History
            </h2>

            {loadingData ? (
              <div className="flex justify-center p-12">
                <div className="w-6 h-6 border-2 border-[#164634] border-t-[#B5F5D1] rounded-full animate-spin"></div>
              </div>
            ) : cases.length === 0 ? (
              <div className="bg-[#0b2b20]/30 border border-[#164634]/50 rounded-[2px] p-10 flex flex-col items-center justify-center text-center">
                <span className="text-3xl mb-3 opacity-50">🩺</span>
                <span className="text-sm font-medium text-[#A3D9BE] mb-1">No previous cases.</span>
                <span className="text-xs text-[#648E77] max-w-xs">Start a new consultation to begin capturing this patient's medical history.</span>
              </div>
            ) : (
              <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-[#164634] before:via-[#164634] before:to-transparent">
                {cases.map((c) => {
                  const details = c.details || {};
                  const isRoutine = details.priority !== 'Urgent';
                  const pColor = isRoutine ? 'text-emerald-400' : 'text-amber-400';
                  
                  return (
                    <div key={c.id} className="relative flex items-start justify-between md:justify-normal md:odd:flex-row-reverse group">
                      
                      {/* Timeline Node */}
                      <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-[#072118] bg-[#0b2b20] absolute left-0 md:left-1/2 -translate-x-1/2 z-10 shrink-0 group-hover:bg-[#164634] transition-colors">
                        <span className={`w-2.5 h-2.5 rounded-full ${isRoutine ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                      </div>

                      {/* Card */}
                      <div className="w-[calc(100%-3rem)] md:w-[calc(50%-2.5rem)] ml-auto md:ml-0 bg-[#0b2b20] border border-[#164634] p-5 rounded-[2px] hover:border-[#B5F5D1]/30 transition-all shadow-md group-hover:-translate-y-1">
                        
                        <div className="flex justify-between items-start mb-2">
                          <span className="text-[10px] font-mono text-[#648E77] bg-[#072118] px-2 py-0.5 rounded-[1px]">
                            {new Date(c.created_at).toLocaleDateString()}
                          </span>
                          <span className={`text-[10px] font-mono uppercase tracking-widest ${pColor}`}>
                            {details.priority || 'Routine'}
                          </span>
                        </div>

                        <h3 className="text-base font-bold text-[#D8FCE8] mb-1">
                          {details.diagnosis || c.summary || "General Consultation"}
                        </h3>
                        <p className="text-xs text-[#A3D9BE] leading-relaxed mb-4 line-clamp-2">
                          {details.doctor_note || "No additional doctor notes provided."}
                        </p>

                        {/* Prescriptions Snippet — attributed to the doctor, never to the AI */}
                        {details.prescriptions && details.prescriptions.length > 0 && (
                          <div className="bg-[#072118] rounded-[1px] p-3 text-[11px] font-mono space-y-1.5 border border-[#164634]/50 mb-4">
                            <span className="text-[#648E77] uppercase block mb-1">Prescribed:</span>
                            {details.prescriptions.map((rx, i) => (
                              <div key={i} className="flex justify-between text-[#D8FCE8] gap-3">
                                <span className="truncate">{rx.drug}</span>
                                <span className="text-[#A3D9BE] shrink-0">{rx.dose}</span>
                              </div>
                            ))}
                            <div className="text-[9px] text-[#648E77] border-t border-[#164634]/60 pt-1.5 mt-1.5">
                              {details.prescriptions_author
                                ? `Prescribed by ${details.prescriptions_author}${details.prescriptions_author_role ? ` (${details.prescriptions_author_role})` : ''}`
                                : 'No identified prescriber on record — treated as a draft, not a doctor prescription.'}
                            </div>
                          </div>
                        )}

                        {/* Doctor suggestions (spec: optional; most cases need no clinical review) */}
                        {doctorSuggestionState(details.doctor_suggestions, currentRole).visible && (
                          <div className="bg-[#072118] rounded-[1px] p-3 text-[11px] font-mono border border-[#164634]/50 mb-4">
                            <span className="text-[#648E77] uppercase block mb-1.5">Doctor suggestions:</span>
                            {(details.doctor_suggestions || []).length === 0 ? (
                              <span className="text-[#648E77] italic">
                                {doctorSuggestionState(details.doctor_suggestions, currentRole).emptyMessage}
                              </span>
                            ) : (
                              <ul className="space-y-1">
                                {details.doctor_suggestions.map((suggestion, i) => (
                                  <li key={i} className="text-[#D8FCE8]">
                                    {suggestion.text}
                                    <span className="text-[#648E77]"> — {suggestion.author}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}

                        {/* Case timeline (spec: chronological record of how the report was produced) */}
                        {(!Array.isArray(details.timeline) || details.timeline.length === 0) && (
                          <div className="mb-4 text-[10px] font-mono text-[#648E77] italic">
                            No events recorded for this case yet.
                          </div>
                        )}
                        {Array.isArray(details.timeline) && details.timeline.length > 0 && (
                          <div className="mb-4">
                            <button
                              type="button"
                              onClick={() => setExpandedTimelineCase(expandedTimelineCase === c.id ? null : c.id)}
                              className="text-[10px] font-mono uppercase tracking-wider text-[#B5F5D1] hover:text-white transition-colors"
                            >
                              {expandedTimelineCase === c.id ? '− Hide timeline' : `+ Case timeline (${details.timeline.length})`}
                            </button>
                            {expandedTimelineCase === c.id && (
                              <ol className="mt-3 space-y-2 border-l border-[#164634] pl-4">
                                {details.timeline.map((event, i) => (
                                  <li key={i} className="text-[10px] font-mono text-[#A3D9BE] leading-relaxed">
                                    {describeTimelineEvent(event)}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </div>
                        )}

                        <div className="flex justify-end gap-4 border-t border-[#164634] pt-3">
                          {can(currentRole, 'create_doctor_suggestion') && (
                            <button
                              onClick={() => {
                                const text = window.prompt("Doctor suggestion / follow-up instruction (recorded against your identity):", "");
                                if (!text || !text.trim()) return;
                                const attributed = attributeToAuthor(currentRole, authEmail || "Dr. A. Sharma", {
                                  text: text.trim(),
                                  case_id: c.id,
                                  created_at: new Date().toISOString(),
                                });
                                if (!attributed.ok) return showToast(attributed.reason, "error");
                                const updated = cases.map((entry) => entry.id === c.id
                                  ? { ...entry, details: { ...entry.details, doctor_suggestions: [...(entry.details?.doctor_suggestions || []), attributed.record] } }
                                  : entry);
                                setCases(updated);
                                addAuditEvent("DOCTOR_SUGGESTION_ADDED", `Case ${c.id}: ${text.trim().slice(0, 40)}`, "info", [], { caseId: c.id, patientId: c.patient_id });
                                appendCaseEvent(c.id, makeEvent(EVENT_TYPES.DOCTOR_SUGGESTION, {
                                  actor: authEmail || "Dr. A. Sharma",
                                  timestamp: new Date().toISOString(),
                                  caseId: c.id,
                                  patientId: c.patient_id,
                                  details: text.trim().slice(0, 60),
                                }));
                                showToast("Doctor suggestion recorded against your identity.", "success");
                              }}
                              className="text-[10px] font-mono text-[#B5F5D1] hover:text-white uppercase tracking-wider"
                            >
                              + Doctor Suggestion
                            </button>
                          )}
                          <button
                            onClick={() => deleteCase(c.id)}
                            className="text-[10px] font-mono text-rose-500/70 hover:text-rose-400 uppercase tracking-wider"
                          >
                            Delete Record
                          </button>
                        </div>

                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: NEW CASE WORKFLOW (CAPTURE -> REVIEW -> PRESCRIBE)
  // ==========================================
  if (view === 'capture') {
    if (!selectedPatient) {
      setView('dashboard');
      return null;
    }

    // Documenting an encounter is a clinical write: gate it and log the refusal.
    if (!requireAccess('create_case')) {
      return (
        <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-center items-center font-sans">
          <Header />
          <FullScreenMenu />
          <Toast />
          <div className="text-center px-6">
            <h1 className="text-lg font-bold text-rose-300 mb-2">Not permitted to document cases</h1>
            <p className="text-xs font-mono text-[#648E77] mb-6">
              {roleLabel(currentRole)} cannot create a new case. This attempt has been recorded
              in the audit log.
            </p>
            <button
              onClick={() => setView('dashboard')}
              className="text-xs font-mono text-[#B5F5D1] hover:text-white uppercase underline underline-offset-4 tracking-wider"
            >
              Return to Registry
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <OfflineBanner />
        <Header />
        <FullScreenMenu />
        <Toast />

        <main className="flex-grow w-full flex flex-col animate-reveal-slow">
          
          {/* Top Context Bar */}
          <div className="bg-[#0b2b20] border-b border-[#164634] py-3 px-4 sm:px-8 flex justify-between items-center sticky top-20 z-30 shadow-sm">
            <div className="flex items-center gap-4">
              <button 
                onClick={() => setView('patient')}
                className="text-[#648E77] hover:text-[#D8FCE8]"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
              </button>
              <div>
                <span className="text-[10px] font-mono text-[#648E77] uppercase block leading-none mb-1">Active Consultation</span>
                <span className="text-sm font-bold text-[#D8FCE8]">{selectedPatient.name}</span>
              </div>
            </div>
            
            {/* Step Indicator */}
            <div className="hidden sm:flex items-center gap-2 text-[10px] font-mono text-[#648E77] uppercase tracking-widest">
              <span className={caseStep >= 1 ? 'text-[#B5F5D1] font-bold' : ''}>1. Input</span>
              <span className="w-4 h-px bg-[#164634]"></span>
              <span className={caseStep >= 2 ? 'text-[#B5F5D1] font-bold' : ''}>2. Review</span>
              <span className="w-4 h-px bg-[#164634]"></span>
              <span className={caseStep >= 3 ? 'text-[#B5F5D1] font-bold' : ''}>3. Rx</span>
            </div>
          </div>

          <div className="flex-grow max-w-4xl w-full mx-auto p-4 sm:p-8 flex flex-col">
            
            {/* STEP 1: CAPTURE INPUT */}
            {caseStep === 1 && (
              <div className="animate-reveal-slow flex flex-col gap-6 h-full">
                <div className="mb-2">
                  <h1 className="text-2xl font-bold tracking-tight text-[#D8FCE8] mb-1">Clinical Capture</h1>
                  <p className="text-sm text-[#A3D9BE]">Record patient dialogue or upload handwritten notes.</p>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Observation Notes / Dialogue</label>
                  <textarea
                    className="w-full h-40 bg-[#072118] text-[#D8FCE8] border border-[#164634] rounded-[2px] p-4 text-sm font-mono focus:border-[#B5F5D1] outline-none transition-colors resize-none placeholder-[#164634]"
                    placeholder="Enter clinical observations, chief complaints, or click mic to record regional dialogue..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                  />
                  <div className="flex justify-between items-center px-1">
                    <button
                      onClick={startVoiceRecording}
                      className={`flex items-center gap-2 text-xs font-mono uppercase tracking-wider px-3 py-1.5 rounded-[2px] transition-all border ${
                        isRecording 
                          ? 'bg-rose-950/50 border-rose-500/50 text-rose-400 animate-pulse' 
                          : 'bg-[#072118] border-[#164634] text-[#B5F5D1] hover:bg-[#0b2b20]'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-rose-500' : 'bg-[#B5F5D1]'}`}></span>
                      {isRecording ? "Recording..." : "Start Mic"}
                    </button>
                    <span className="text-[10px] font-mono text-[#648E77]">Supports En/Hi Mix</span>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Visual Evidence (Optional)</label>
                  <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-[#164634] border-dashed rounded-[2px] cursor-pointer bg-[#072118] hover:bg-[#0b2b20] transition-colors relative overflow-hidden group">
                    {imagePreview ? (
                      <>
                        <img src={imagePreview} alt="Preview" className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity" />
                        <span className="relative z-10 text-xs font-bold text-white bg-black/50 px-3 py-1 rounded-[2px]">Change Image</span>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center pt-5 pb-6">
                        <svg className="w-6 h-6 mb-2 text-[#648E77]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                        <p className="text-xs text-[#A3D9BE]"><span className="font-semibold">Click to upload</span> Rx or test report</p>
                        <p className="text-[10px] font-mono text-[#648E77] mt-1">PNG, JPG, PDF</p>
                      </div>
                    )}
                    <input type="file" className="hidden" accept="image/*" onChange={handleImageChange} />
                  </label>
                </div>

                {aiError && (
                  <div className="p-4 border border-rose-500/40 bg-rose-950/20 rounded-[2px]">
                    <h4 className="text-[10px] font-mono text-rose-300 uppercase mb-1.5">AI processing failed</h4>
                    <p className="text-xs text-rose-200 mb-3">
                      {aiError} Your notes and image are still here — nothing was lost.
                    </p>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => extractCase()}
                        className="bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 px-3 py-1.5 rounded-[1px] font-bold text-[10px] uppercase tracking-wider transition-colors"
                      >
                        Retry AI processing
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiError("")}
                        className="text-[10px] font-mono uppercase tracking-wider text-[#648E77] hover:text-[#D8FCE8] transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-auto pt-6 border-t border-[#164634]">
                  <button
                    onClick={extractCase}
                    disabled={loadingAI || (!inputText && !imageFile)}
                    className="w-full bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-4 rounded-[2px] font-bold text-sm uppercase tracking-wider transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 flex justify-center items-center gap-3 shadow-lg"
                  >
                    {loadingAI ? (
                      <>
                        <div className="w-4 h-4 border-2 border-[#072118] border-t-transparent rounded-full animate-spin"></div>
                        <span>Processing with AI...</span>
                      </>
                    ) : (
                      <span>Synthesize Clinical Data →</span>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: AI REVIEW & EDIT */}
            {caseStep === 2 && editedReport && (
              <div className="animate-reveal-slow flex flex-col gap-6">
                <div className="mb-2">
                  <h1 className="text-2xl font-bold tracking-tight text-[#D8FCE8] mb-1">Verify Extraction</h1>
                  <p className="text-sm text-[#A3D9BE]">Review and correct the AI-structured data before proceeding. AI drafts → evidence verifies → human approves.</p>
                </div>

                {reviewModel && (
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
                    {Object.entries(statusCounts(reviewModel.facts))
                      .filter(([, n]) => n > 0)
                      .map(([status, n]) => (
                        <span key={status} className="px-2 py-1 rounded-[1px] border border-[#164634] text-[#A3D9BE]">
                          {statusMeta(status).label}: {n}
                        </span>
                      ))}
                    <span className={`px-2 py-1 rounded-[1px] border ${unsupportedFacts.length > 0 ? 'border-rose-500/40 text-rose-300' : 'border-[#164634] text-[#648E77]'}`}>
                      Pending review: {pendingReviewItems(reviewModel).length}
                      {unsupportedFacts.length > 0 ? ` • ${unsupportedFacts.length} unsupported claim(s)` : ''}
                    </span>
                  </div>
                )}

                {/* Extracted Summary */}
                <div className="bg-[#0b2b20] border border-[#164634] p-5 rounded-[2px] shadow-md">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest block mb-2">Generated Summary</label>
                  <textarea
                    className="w-full bg-[#072118] text-[#D8FCE8] text-sm leading-relaxed p-3 border border-[#164634] rounded-[1px] outline-none focus:border-[#B5F5D1] resize-none h-24"
                    value={editedReport.summary || ""}
                    onChange={(e) => setEditedReport({...editedReport, summary: e.target.value})}
                  />
                </div>

                {/* Original source, shown alongside the structured output.
                    Spec: display the voice transcript, uploaded note or entered text next
                    to the information extracted from it, so the reviewer can compare. */}
                <div className="bg-[#0b2b20] border border-[#164634] p-5 rounded-[2px] shadow-md">
                  <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest block mb-2">
                    Original Source (read-only)</label>
                  <div className="space-y-3 max-h-64 overflow-y-auto custom-scrollbar pr-1">
                    {captureTextSource && (
                      <div className="bg-[#072118] border border-[#164634] rounded-[1px] p-3">
                        <span className="block text-[9px] font-mono text-[#648E77] uppercase mb-1.5">Entered notes</span>
                        <p className="text-xs font-mono text-[#A3D9BE] whitespace-pre-wrap leading-relaxed">{captureTextSource}</p>
                      </div>
                    )}
                    {imagePreview && (
                      <div className="bg-[#072118] border border-[#164634] rounded-[1px] p-3">
                        <span className="block text-[9px] font-mono text-[#648E77] uppercase mb-1.5">Uploaded photograph</span>
                        <img src={imagePreview} alt="Original uploaded note" className="w-full max-h-48 object-contain rounded-[1px] bg-black/30" />
                      </div>
                    )}
                    {!captureTextSource && !imagePreview && (
                      <p className="text-xs font-mono text-[#648E77] italic">
                        No source is retained for this encounter, so the extracted values cannot be
                        compared against their origin.
                      </p>
                    )}
                  </div>
                </div>

                {/* Structured Entities */}
                <div className="space-y-4">
                  <h3 className="text-xs font-mono text-[#648E77] uppercase tracking-widest border-b border-[#164634] pb-2">Extracted Entities</h3>
                  
                  {unsupportedFacts.length > 0 && (
                    // Spec: an AI claim that cannot be traced to the source must be flagged,
                    // not silently accepted.
                    <div className="mb-4 p-4 border border-rose-500/40 bg-rose-950/20 rounded-[2px]">
                      <h4 className="text-[10px] font-mono text-rose-300 uppercase mb-2">
                        Unsupported claims — not found in the source
                      </h4>
                      <ul className="space-y-1 text-xs text-rose-200">
                        {unsupportedFacts.map((fact, i) => (
                          <li key={i}>
                            <span className="font-mono uppercase text-[10px] text-rose-300">{String(fact.field).replace(/_/g, ' ')}</span>
                            {' — '}{formatFactValue(fact.value)}
                            <span className="text-[10px] text-rose-400/80"> (quoted text does not appear in the source)</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {reviewModel && reviewModel.facts && reviewModel.facts.length > 0 ? (
                    <div className="flex flex-col gap-3">
                      {reviewModel.facts.map((fact, idx) => {
                        const meta = statusMeta(fact.status);
                        const tone = {
                          emerald: 'border-emerald-500/30',
                          amber: 'border-amber-500/40',
                          rose: 'border-rose-500/40',
                          mint: 'border-[#B5F5D1]/50',
                        }[meta.tone] || 'border-[#164634]';
                        const badge = {
                          emerald: 'bg-emerald-950/50 text-emerald-400 border-emerald-500/30',
                          amber: 'bg-amber-950/50 text-amber-300 border-amber-500/30',
                          rose: 'bg-rose-950/50 text-rose-300 border-rose-500/30',
                          mint: 'bg-[#164634] text-[#B5F5D1] border-[#B5F5D1]/30',
                        }[meta.tone] || 'bg-[#164634] text-[#A3D9BE] border-[#164634]';
                        const evidence = fact.evidence || [];
                        return (
                          <div key={idx} className={`bg-[#072118] border ${tone} p-3 rounded-[2px] flex flex-col gap-1.5 focus-within:border-[#B5F5D1]/70 transition-colors`}>
                            <div className="flex items-center justify-between gap-2">
                              <input
                                className="bg-transparent text-[10px] font-mono text-[#B5F5D1] uppercase outline-none w-full"
                                value={fact.field}
                                aria-label={`Extracted field name ${idx + 1}`}
                                onChange={(e) => {
                                  const updated = reviewModel.facts.map((f, i) => (i === idx ? { ...f, field: e.target.value } : f));
                                  syncReviewToReport({ ...reviewModel, facts: updated });
                                }}
                              />
                              <span className={`shrink-0 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-[1px] border ${badge}`}>
                                {meta.label}
                              </span>
                            </div>

                            <input
                              className="bg-transparent text-sm text-[#D8FCE8] outline-none w-full font-medium"
                              value={formatVal(fact.value)}
                              aria-label={`Extracted value ${idx + 1}`}
                              onChange={(e) => handleFactCorrection(idx, e.target.value)}
                            />

                            <div className="flex items-center justify-between gap-2 mt-0.5">
                              <button
                                type="button"
                                onClick={() => setEvidenceFactIndex(evidenceFactIndex === idx ? null : idx)}
                                className="text-[9px] font-mono uppercase tracking-wider text-[#648E77] hover:text-[#B5F5D1] transition-colors"
                              >
                                {evidence.length > 0 ? `Evidence (${evidence.length})` : 'No evidence'}
                              </button>
                              <div className="flex items-center gap-3">
                                <span className="text-[9px] font-mono uppercase text-[#648E77]">
                                  {fact.source === 'worker' ? 'Worker entered' : fact.source === 'ai' ? 'AI extracted' : fact.source}
                                </span>
                                {isUnsupported(fact) && (
                                  <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-[1px] border border-rose-500/40 text-rose-300">
                                    Unsupported
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const updated = rejectFact(reviewModel.facts, idx, {
                                      actor: authEmail || "Field Worker",
                                      timestamp: new Date().toISOString(),
                                    });
                                    addAuditEvent("AI_OUTPUT_REJECTED", `${fact.field}: "${formatFactValue(fact.value)}" rejected`, "warn", [{ field: fact.field, from: formatFactValue(fact.value), to: "(rejected)" }], { patientId: selectedPatient?.id });
                                    setReviewEvents((prev) => [...prev, makeEvent(EVENT_TYPES.AI_OUTPUT_REJECTED, {
                                      actor: authEmail || "Field Worker",
                                      timestamp: new Date().toISOString(),
                                      patientId: selectedPatient?.id,
                                      details: `${String(fact.field).replace(/_/g, ' ')}: "${formatFactValue(fact.value)}" rejected`,
                                    })]);
                                    syncReviewToReport({ ...reviewModel, facts: updated });
                                  }}
                                  className="text-[9px] font-mono uppercase tracking-wider text-rose-400/70 hover:text-rose-300 transition-colors"
                                >
                                  Reject
                                </button>
                              </div>
                            </div>

                            {evidenceFactIndex === idx && (
                              <div className="mt-1 bg-[#0b2b20] border border-[#164634] rounded-[1px] p-2 space-y-1">
                                {evidence.length > 0 ? (
                                  evidence.map((ev, evIdx) => (
                                    <div key={evIdx} className="text-[10px] font-mono text-[#A3D9BE] leading-relaxed">
                                      {evidenceText(ev)}
                                    </div>
                                  ))
                                ) : (
                                  <div className="text-[10px] font-mono text-[#648E77] italic">
                                    No evidence attached to this fact.
                                  </div>
                                )}
                                {fact.original_value !== null && fact.original_value !== undefined && (
                                  <div className="text-[10px] font-mono text-amber-300 border-t border-[#164634] pt-1">
                                    AI original: {formatFactValue(fact.original_value)}
                                    {fact.corrections && fact.corrections.length > 0
                                      ? ` • ${fact.corrections.length} correction(s) retained in history`
                                      : ''}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-[#648E77] italic">No high-confidence entities extracted.</p>
                  )}

                  {editedReport.missing && editedReport.missing.length > 0 && (
                    <div className="mt-4 p-4 border border-rose-500/30 bg-rose-950/20 rounded-[2px]">
                      <h4 className="text-[10px] font-mono text-rose-400 uppercase mb-3 flex items-center gap-2">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        Missing Critical Information
                      </h4>
                      <ul className="space-y-1 text-xs text-rose-200 list-disc list-inside">
                        {editedReport.missing.map((item, idx) => (
                          <li key={idx}>{formatMissingItem(item)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* Spec: the worker can add missing information, not only edit what the AI found. */}
                  <div className="mt-4 p-4 border border-[#164634] bg-[#072118] rounded-[2px]">
                    <h4 className="text-[10px] font-mono text-[#B5F5D1] uppercase mb-3">Add Missing Information</h4>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        className="flex-1 bg-[#0b2b20] border border-[#164634] text-[#D8FCE8] text-xs px-3 py-2 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Field (e.g. blood_pressure)"
                        value={newFactField}
                        onChange={(e) => setNewFactField(e.target.value)}
                      />
                      <input
                        className="flex-1 bg-[#0b2b20] border border-[#164634] text-[#D8FCE8] text-xs px-3 py-2 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Value (e.g. 120/80)"
                        value={newFactValue}
                        onChange={(e) => setNewFactValue(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const field = newFactField.trim();
                          const value = newFactValue.trim();
                          if (!field || !value) return showToast("Enter both a field and a value.", "error");
                          const added = {
                            field,
                            value,
                            status: 'human_corrected',
                            source: 'worker',
                            evidence: [{ kind: 'worker_note', ref: authEmail || "Field Worker", quote: 'Added during review', label: 'human review' }],
                            original_value: null,
                            corrections: [{ from: null, to: value, actor: authEmail || "Field Worker", timestamp: new Date().toISOString() }],
                          };
                          setReviewEvents((prev) => [...prev, makeEvent(EVENT_TYPES.HUMAN_CORRECTION, {
                            actor: authEmail || "Field Worker",
                            timestamp: new Date().toISOString(),
                            patientId: selectedPatient?.id,
                            details: `added ${field}: ${value}`,
                          })]);
                          syncReviewToReport({ ...reviewModel, facts: [...reviewModel.facts, added] });
                          addAuditEvent("FIELD_ADDED", `${field} = "${value}" (added by worker)`, "warn", [{ field, from: '', to: value }], { patientId: selectedPatient?.id });
                          setNewFactField("");
                          setNewFactValue("");
                        }}
                        className="bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] px-4 py-2 rounded-[1px] font-bold text-[10px] uppercase tracking-wider transition-colors"
                      >
                        Add Fact
                      </button>
                    </div>
                  </div>

                  {reviewModel && reviewModel.conflicts && reviewModel.conflicts.length > 0 && (
                    <div className="mt-4 p-4 border border-amber-500/40 bg-amber-950/20 rounded-[2px]">
                      <h4 className="text-[10px] font-mono text-amber-300 uppercase mb-3 flex items-center gap-2">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                        Conflicting Values — Human Decision Required
                      </h4>
                      {reviewModel.conflicts.map((conflict, conflictIdx) => (
                        <div key={conflictIdx} className="mb-3 last:mb-0">
                          <div className="text-[10px] font-mono text-amber-300 uppercase mb-1">
                            {String(conflict.field || '').replace(/_/g, ' ')}
                          </div>
                          {conflict.reason && (
                            <div className="text-[10px] text-[#A3D9BE] mb-2">{conflict.reason}</div>
                          )}
                          {conflict.requires_resolution !== false ? (
                            <div className="flex flex-wrap gap-2">
                              {(conflict.options || []).map((option, optionIdx) => (
                                <button
                                  key={optionIdx}
                                  type="button"
                                  onClick={() => handleConflictResolution(conflict.field, option.value)}
                                  className="text-xs font-mono bg-[#072118] border border-[#164634] hover:border-[#B5F5D1] text-[#D8FCE8] px-3 py-1.5 rounded-[2px] transition-colors"
                                >
                                  {formatFactValue(option.value)}
                                  {option.sources && option.sources.length > 0 && (
                                    <span className="text-[#648E77] ml-1">({option.sources.join(', ')})</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="text-[10px] font-mono text-emerald-400">
                              Resolved by human: {formatFactValue(conflict.resolution?.value)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {reviewModel && reviewModel.clarificationQuestions && reviewModel.clarificationQuestions.length > 0 && (
                    <div className="mt-4 p-4 border border-[#164634] bg-[#072118] rounded-[2px]">
                      <h4 className="text-[10px] font-mono text-[#B5F5D1] uppercase mb-3">Suggested Clarification Questions</h4>
                      <ul className="space-y-1 text-xs text-[#A3D9BE] list-disc list-inside">
                        {reviewModel.clarificationQuestions.map((question, questionIdx) => (
                          <li key={questionIdx}>{question.question}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="mt-6 flex gap-4 pt-6 border-t border-[#164634]">
                  <button
                    onClick={() => setCaseStep(1)}
                    className="w-1/3 bg-transparent border border-[#164634] text-[#648E77] hover:text-[#D8FCE8] py-3 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={() => {
                      const qa = runQaGate(2);
                      if (qa && qa.blocking.length > 0) {
                        // Stay on the verification step: the blocking items are listed in the
                        // existing 'Missing Critical Information' panel above this button.
                        return;
                      }
                      setCaseStep(3);
                    }}
                    className="w-2/3 bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-3 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-all shadow-md"
                  >
                    Proceed to Rx →
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: PRESCRIPTION & FINAL APPROVAL */}
            {caseStep === 3 && (
              <div className="animate-reveal-slow flex flex-col gap-6">
                <div className="mb-2">
                  <h1 className="text-2xl font-bold tracking-tight text-[#D8FCE8] mb-1">Diagnosis & Treatment</h1>
                  <p className="text-sm text-[#A3D9BE]">Finalize diagnosis and approve suggested prescriptions.</p>
                </div>

                {/* Spec: only authorised users may create prescriptions, AND the worker must
                    understand why an action is unavailable rather than only not seeing it.
                    Gated on authoring, not on canPrescribe: every role that can reach this step
                    may already accept medication, so a canPrescribe check would never fire. */}
                {!canAuthorPrescriptionRecord && (
                  <div className="p-4 border border-amber-500/40 bg-amber-950/20 rounded-[2px]">
                    <h4 className="text-[10px] font-mono text-amber-300 uppercase mb-1.5">Authoring a prescription requires a doctor</h4>
                    <p className="text-xs text-amber-100">
                      {roleLabel(currentRole)} may accept medication that a doctor has already authorised, but cannot
                      author a new prescription. Any item accepted in this step is recorded as your entry, not as a
                      doctor prescription. Ask a doctor to author one where clinical intervention is needed.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Left: Metadata */}
                  <div className="space-y-5">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Primary Diagnosis</label>
                      <input 
                        type="text" 
                        value={selectedDiagnosis} 
                        onChange={(e) => setSelectedDiagnosis(e.target.value)}
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-4 py-3 rounded-[2px] focus:border-[#B5F5D1] outline-none"
                        placeholder="e.g. Acute Viral Pharyngitis"
                      />
                    </div>
                    
                    <div className="flex gap-4">
                      <div className="flex-1 flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Category</label>
                        <select 
                          value={caseCategory} 
                          onChange={(e) => setCaseCategory(e.target.value)}
                          className="w-full bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-3 py-2.5 rounded-[2px] outline-none"
                        >
                          <option>OPD</option><option>Emergency</option><option>Follow-up</option>
                        </select>
                      </div>
                      <div className="flex-1 flex flex-col gap-1.5">
                        <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Priority</label>
                        <select 
                          value={casePriority} 
                          onChange={(e) => setCasePriority(e.target.value)}
                          className="w-full bg-[#072118] border border-[#164634] text-[#D8FCE8] text-sm px-3 py-2.5 rounded-[2px] outline-none"
                        >
                          <option>Routine</option><option>Urgent</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest ml-1">Additional Notes</label>
                      <textarea 
                        value={doctorNote} 
                        onChange={(e) => setDoctorNote(e.target.value)}
                        className="w-full h-24 bg-[#072118] text-[#D8FCE8] text-sm p-3 border border-[#164634] rounded-[2px] outline-none focus:border-[#B5F5D1] resize-none"
                        placeholder="Dietary advice, rest instructions, etc."
                      />
                    </div>
                  </div>

                  {/* Right: Prescriptions */}
                  <div className="bg-[#0b2b20] border border-[#164634] rounded-[2px] p-5 flex flex-col">
                    {/* Spec: a prescription must carry medication, dosage, date, patient,
                        case and the identity of the authorised person who created it, and
                        must never look AI-generated. Only an authorised user may author one. */}
                    {canAuthorPrescriptionRecord && (
                      <div className="mb-5 pb-4 border-b border-[#164634]">
                        <h4 className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest mb-2">
                          Authorise a Prescription (doctor)
                        </h4>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <input
                            className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                            placeholder="Medication"
                            value={rxDrug}
                            onChange={(e) => setRxDrug(e.target.value)}
                          />
                          <input
                            className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                            placeholder="Dosage / instructions"
                            value={rxDose}
                            onChange={(e) => setRxDose(e.target.value)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (!requireAccess('create_prescription')) {
                              recordDeniedAccess('create_prescription', 'authorise a prescription', { patientId: selectedPatient?.id });
                              return;
                            }
                            const drug = rxDrug.trim();
                            const dose = rxDose.trim();
                            if (!drug) return showToast("Enter a medication.", "error");
                            const attributed = attributeToAuthor(currentRole, authEmail || "Dr. A. Sharma", {
                              drug,
                              dose,
                              route: 'Oral',
                              prescribed_at: new Date().toISOString(),
                              patient_id: selectedPatient?.id ?? "",
                              case_patient_id: selectedPatient?.id ?? "",
                              status: 'active',
                              history: [{ at: new Date().toISOString(), by: authEmail || "Dr. A. Sharma", change: 'created' }],
                            });
                            if (!attributed.ok) return showToast(attributed.reason, "error");
                            setAuthorisedPrescriptions((prev) => [...prev, attributed.record]);
                            setReviewEvents((prev) => [...prev, makeEvent(EVENT_TYPES.PRESCRIPTION_CREATED, {
                              actor: authEmail || "Dr. A. Sharma",
                              timestamp: new Date().toISOString(),
                              patientId: selectedPatient?.id,
                              details: `authorised ${drug} ${dose}`,
                            })]);
                            addAuditEvent("PRESCRIPTION_AUTHORISED", `${drug} ${dose} by ${attributed.record.author}`, "success", [{ field: 'prescription', from: '', to: `${drug} ${dose}` }], { patientId: selectedPatient?.id });
                            setRxDrug("");
                            setRxDose("");
                          }}
                          className="w-full bg-[#164634] hover:bg-[#1b5642] text-[#D8FCE8] py-2 rounded-[1px] font-bold text-[10px] uppercase tracking-wider transition-colors"
                        >
                          Sign as {roleLabel(currentRole)}
                        </button>
                      </div>
                    )}

                    {authorisedPrescriptions.length > 0 && (
                      <div className="mb-5 pb-4 border-b border-[#164634]">
                        <h4 className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest mb-2">
                          Authorised Prescriptions
                        </h4>
                        <div className="space-y-2">
                          {authorisedPrescriptions.map((rx, i) => (
                            <div key={i} className="bg-[#072118] border border-[#164634] rounded-[1px] p-2.5 text-[11px] font-mono">
                              <div className="flex justify-between text-[#D8FCE8]">
                                <span className="font-bold">{rx.drug}</span>
                                <span className="text-[#A3D9BE]">{rx.dose}</span>
                              </div>
                              <div className="text-[9px] text-[#648E77] mt-1">
                                {rx.author} ({roleLabel(rx.author_role)}) · {rx.prescribed_at ? new Date(rx.prescribed_at).toLocaleString() : ''} · patient #{rx.patient_id}
                              </div>
                              <div className="text-[9px] text-[#648E77]">
                                status {rx.status} · not AI-generated {String(rx.generated_by_ai === false)}
                                {rx.history?.length ? ` · ${rx.history.length} history entr${rx.history.length === 1 ? 'y' : 'ies'}` : ''}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <h3 className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest mb-1 flex items-center gap-2">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" /></svg>
                      Protocol Draft Medications
                    </h3>
                    {/* Spec: these must never appear as though AI prescribed them. */}
                    <p className="text-[9px] font-mono text-[#648E77] mb-4 leading-relaxed">
                      Drafted from the standard protocol above. Accepting an item records it as your entry, not the AI's; it becomes an authorised doctor prescription only when a doctor signs it.
                    </p>

                    {!canAuthorPrescriptionRecord && (
                      <p className="text-[10px] font-mono text-amber-300/90 mb-3">
                        {roleLabel(currentRole)} may accept doctor-authorised medication but may not author a
                        prescription.
                      </p>
                    )}
                    
                    <div className="space-y-3 flex-grow overflow-y-auto">
                      {prescriptionSuggestions.map((s, idx) => (
                        <div key={idx} className={`border p-3 rounded-[2px] transition-colors flex items-start gap-3 cursor-pointer ${s.accepted ? 'border-[#B5F5D1] bg-[#072118]' : 'border-[#164634] bg-[#072118]/50 hover:border-[#648E77]'}`}
                             onClick={() => {
                               if (!canPrescribe(currentRole)) {
                                 showToast(`${roleLabel(currentRole)} may not author a prescription.`, "error");
                                 return;
                               }
                               const newArr = [...prescriptionSuggestions];
                               newArr[idx].accepted = !newArr[idx].accepted;
                               setPrescriptionSuggestions(newArr);
                               const verb = newArr[idx].accepted ? 'accepted' : 'unaccepted';
                               addAuditEvent("PRESCRIPTION_ITEM", `${verb}: ${newArr[idx].drug} (draft, awaiting doctor authorisation)`, "info", [], { patientId: selectedPatient?.id });
                               if (newArr[idx].accepted) {
                                 setReviewEvents((prev) => [...prev, makeEvent(EVENT_TYPES.PRESCRIPTION_CREATED, {
                                   actor: authEmail || "Field Worker",
                                   timestamp: new Date().toISOString(),
                                   patientId: selectedPatient?.id,
                                   details: `${newArr[idx].drug} ${newArr[idx].dose}`,
                                 })]);
                               }
                             }}>
                          <div className={`mt-0.5 w-4 h-4 shrink-0 border flex items-center justify-center rounded-[1px] ${s.accepted ? 'bg-[#B5F5D1] border-[#B5F5D1] text-[#072118]' : 'border-[#648E77] text-transparent'}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                          </div>
                          <div>
                            <div className="text-sm font-bold text-[#D8FCE8]">{s.drug}</div>
                            <div className="text-xs text-[#A3D9BE] mt-0.5">{s.dose} • {s.route}</div>
                          </div>
                        </div>
                      ))}
                      {prescriptionSuggestions.length === 0 && (
                        <p className="text-xs text-[#648E77] italic">No standard protocol identified for this summary.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex gap-4 pt-6 border-t border-[#164634]">
                  <button
                    onClick={() => setCaseStep(2)}
                    className="w-1/3 bg-transparent border border-[#164634] text-[#648E77] hover:text-[#D8FCE8] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-colors"
                  >
                    ← Edit
                  </button>
                  <button
                    onClick={handleApprove}
                    className="w-2/3 bg-[#B5F5D1] hover:bg-[#c8fae0] text-[#072118] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider transition-all shadow-md active:scale-[0.98] flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Sign & Save Record
                  </button>
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: LOGIN (PRESERVED)
  // ==========================================
  if (view === 'login') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-center items-center selection:bg-[#B5F5D1] selection:text-[#072118]">
        <OfflineBanner />
        <Toast />
        <div className="w-full max-w-sm px-6">
          <div className="mb-8 text-center">
            <div className="w-12 h-12 mx-auto rounded-[2px] bg-[#B5F5D1] text-[#072118] flex items-center justify-center font-bold text-lg mb-4">
              AL
            </div>
            <h1 className="text-2xl font-bold tracking-widest">AROGYALEKH</h1>
            <p className="text-xs font-mono text-[#648E77] mt-2">STAFF AUTHENTICATION</p>
          </div>
          <div className="bg-[#0b2b20] p-6 sm:p-8 rounded-[2px] border border-[#164634] shadow-2xl">
            <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setView('dashboard'); addAuditEvent("USER_LOGIN", authEmail, "info"); }}>
              <input
                type="email"
                placeholder="Staff Email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                className="bg-[#072118] border border-[#164634] text-[#D8FCE8] px-4 py-3 text-sm focus:border-[#B5F5D1] outline-none rounded-[1px]"
                required
              />
              <input
                type="password"
                placeholder="Password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                className="bg-[#072118] border border-[#164634] text-[#D8FCE8] px-4 py-3 text-sm focus:border-[#B5F5D1] outline-none rounded-[1px]"
                required
              />
              <button type="submit" className="bg-[#B5F5D1] text-[#072118] py-3 mt-2 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:bg-[#c8fae0]">
                {isSignUp ? "Register Staff" : "Secure Sign In"}
              </button>
            </form>
            <div className="mt-6 text-center">
              <button onClick={() => setIsSignUp(!isSignUp)} className="text-[10px] font-mono text-[#648E77] uppercase hover:text-[#B5F5D1]">
                {isSignUp ? "Existing Staff? Sign In" : "New Staff? Request Access"}
              </button>
            </div>
          </div>
          <div className="mt-8 text-center">
            <button onClick={() => setView('landing')} className="text-[10px] font-mono text-[#648E77] uppercase hover:text-[#D8FCE8]">
              ← Return Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // VIEW: ONBOARDING (PRESERVED)
  // ==========================================
  if (view === 'onboarding') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <Header />
        <FullScreenMenu />
        <main className="flex-grow flex items-center justify-center p-4 sm:p-6 animate-reveal-slow">
          <div className="w-full max-w-2xl bg-[#0b2b20] border border-[#164634] p-8 sm:p-12 rounded-[2px] shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-[#164634]">
              <div className="h-full bg-[#B5F5D1] transition-all duration-500" style={{ width: `${(onboardingStep / 3) * 100}%` }}></div>
            </div>
            
            <span className="text-[10px] font-mono text-[#B5F5D1] uppercase tracking-widest mb-6 block">Clinic Setup — Step 0{onboardingStep} / 03</span>
            
            {onboardingStep === 1 && (
              <div className="animate-reveal-slow">
                <h1 className="text-3xl font-bold mb-2">Clinic Details</h1>
                <p className="text-sm text-[#A3D9BE] mb-8">Establish your facility identifier.</p>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-mono text-[#648E77] uppercase mb-1 block">Facility Name</label>
                    <input type="text" value={clinicName} onChange={(e) => setClinicName(e.target.value)} className="w-full bg-[#072118] border border-[#164634] text-white p-3 rounded-[1px] outline-none focus:border-[#B5F5D1] text-sm" />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono text-[#648E77] uppercase mb-1 block">Govt Code / PHC Code</label>
                    <input type="text" value={phcCode} onChange={(e) => setPhcCode(e.target.value)} className="w-full bg-[#072118] border border-[#164634] text-white p-3 rounded-[1px] outline-none focus:border-[#B5F5D1] text-sm" />
                  </div>
                </div>
                <button onClick={() => setOnboardingStep(2)} className="mt-8 w-full bg-[#B5F5D1] text-[#072118] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:bg-[#c8fae0]">Next Step →</button>
              </div>
            )}
            
            {onboardingStep === 2 && (
              <div className="animate-reveal-slow">
                <h1 className="text-3xl font-bold mb-2">Regional Dialect</h1>
                <p className="text-sm text-[#A3D9BE] mb-8">Select primary voice models for frontline NLP.</p>
                <div className="space-y-3">
                  {['Hinglish & Regional Dialects (en-IN)', 'Pure Hindi (hi-IN)', 'Bengali (bn-IN)', 'Marathi (mr-IN)'].map((opt) => (
                    <div 
                      key={opt}
                      onClick={() => setPrimaryDialect(opt)}
                      className={`p-4 border rounded-[2px] cursor-pointer text-sm font-medium transition-colors ${primaryDialect === opt ? 'border-[#B5F5D1] bg-[#072118] text-white' : 'border-[#164634] text-[#A3D9BE] hover:border-[#648E77]'}`}
                    >
                      {opt}
                    </div>
                  ))}
                </div>
                <div className="mt-8 flex gap-4">
                  <button onClick={() => setOnboardingStep(1)} className="w-1/3 bg-transparent border border-[#164634] text-[#648E77] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:text-white">Back</button>
                  <button onClick={() => setOnboardingStep(3)} className="w-2/3 bg-[#B5F5D1] text-[#072118] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:bg-[#c8fae0]">Next Step →</button>
                </div>
              </div>
            )}

            {onboardingStep === 3 && (
              <div className="animate-reveal-slow">
                <h1 className="text-3xl font-bold mb-2">Initialization Complete</h1>
                <p className="text-sm text-[#A3D9BE] mb-8">Review your parameters.</p>
                <div className="bg-[#072118] p-5 border border-[#164634] rounded-[1px] space-y-4 text-sm font-mono text-[#A3D9BE]">
                  <div><span className="text-[#648E77] block text-[10px] uppercase">Facility</span> <span className="text-white">{clinicName}</span></div>
                  <div><span className="text-[#648E77] block text-[10px] uppercase">Code</span> <span className="text-white">{phcCode}</span></div>
                  <div><span className="text-[#648E77] block text-[10px] uppercase">NLP Profile</span> <span className="text-white">{primaryDialect}</span></div>
                </div>
                <div className="mt-8 flex gap-4">
                  <button onClick={() => setOnboardingStep(2)} className="w-1/3 bg-transparent border border-[#164634] text-[#648E77] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:text-white">Back</button>
                  <button onClick={() => { setView('dashboard'); addAuditEvent("CLINIC_SETUP", clinicName, "success"); }} className="w-2/3 bg-[#B5F5D1] text-[#072118] py-3.5 rounded-[2px] font-bold text-xs uppercase tracking-wider hover:bg-[#c8fae0]">Launch Console</button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: ADMIN TELEMETRY (ENHANCED AUDIT LOG)
  // ==========================================
  if (view === 'admin') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <Header />
        <FullScreenMenu />
        
        <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-10 py-8 animate-reveal-slow flex flex-col md:flex-row gap-8">
          
          <div className="w-full md:w-64 shrink-0">
            <h1 className="text-2xl font-bold tracking-tight mb-8">Admin Telemetry</h1>
            <nav className="space-y-2 text-sm font-mono uppercase tracking-wider">
              <button 
                onClick={() => setAdminTab('team')}
                className={`w-full text-left px-4 py-3 rounded-[2px] transition-colors ${adminTab === 'team' ? 'bg-[#0b2b20] border-l-2 border-[#B5F5D1] text-white' : 'text-[#648E77] hover:bg-[#0b2b20]/50'}`}
              >
                Team Access
              </button>
              <button 
                onClick={() => setAdminTab('audit')}
                className={`w-full text-left px-4 py-3 rounded-[2px] transition-colors ${adminTab === 'audit' ? 'bg-[#0b2b20] border-l-2 border-[#B5F5D1] text-white' : 'text-[#648E77] hover:bg-[#0b2b20]/50'}`}
              >
                Security Audit Log
              </button>
              <button 
                onClick={() => setAdminTab('system')}
                className={`w-full text-left px-4 py-3 rounded-[2px] transition-colors ${adminTab === 'system' ? 'bg-[#0b2b20] border-l-2 border-[#B5F5D1] text-white' : 'text-[#648E77] hover:bg-[#0b2b20]/50'}`}
              >
                System Status
              </button>
            </nav>

            {/* Signed-in role (spec: patient access, prescriptions and the audit log are role-gated) */}
            <div className="mt-8 pt-6 border-t border-[#164634]">
              <span className="block text-[10px] font-mono text-[#648E77] uppercase mb-2">Signed in as</span>
              <div className="space-y-2">
                {Object.values(ROLES).map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => {
                      setCurrentRole(role);
                      addAuditEvent("ROLE_SWITCHED", `Now acting as ${ROLE_LABELS[role]}`, "info");
                    }}
                    className={`w-full text-left px-3 py-2 rounded-[2px] text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                      currentRole === role ? 'bg-[#164634] text-[#D8FCE8] border-[#B5F5D1]/50' : 'bg-transparent text-[#648E77] border-[#164634] hover:text-[#D8FCE8]'
                    }`}
                  >
                    {ROLE_LABELS[role]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-grow bg-[#0b2b20] border border-[#164634] rounded-[2px] p-6 sm:p-10 shadow-xl overflow-hidden flex flex-col max-h-[80vh]">
            {adminTab === 'team' && (
              <div>
                <h2 className="text-lg font-bold mb-1">Active Personnel</h2>
                <p className="text-xs text-[#A3D9BE] mb-6">Manage frontline workers and doctors.</p>
                <div className="space-y-3">
                  <div className="flex justify-between items-center p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <div>
                      <span className="block text-sm font-medium text-white">Dr. A. Sharma</span>
                      <span className="text-xs font-mono text-[#648E77]">Chief Medical Officer</span>
                    </div>
                    <span className="text-[10px] font-mono bg-emerald-950/50 text-emerald-400 px-2 py-1 rounded-[1px] border border-emerald-500/30">Active</span>
                  </div>
                  <div className="flex justify-between items-center p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <div>
                      <span className="block text-sm font-medium text-white">Sita Devi</span>
                      <span className="text-xs font-mono text-[#648E77]">ASHA Field Worker</span>
                    </div>
                    <span className="text-[10px] font-mono bg-emerald-950/50 text-emerald-400 px-2 py-1 rounded-[1px] border border-emerald-500/30">Active</span>
                  </div>
                </div>
              </div>
            )}
            
            {adminTab === 'audit' && (
              <div className="flex flex-col h-full overflow-hidden">
                {!canViewAuditLog(currentRole) ? (
                  // Spec: the audit log is for authorised administrators.
                  <div className="text-center text-sm font-mono text-rose-300 py-10">
                    Access denied. The audit log is restricted to administrators.
                    <div className="text-[#648E77] mt-2 text-xs">Signed in as {roleLabel(currentRole)}.</div>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-end mb-4">
                      <div>
                        <h2 className="text-lg font-bold mb-1">Live Audit Log</h2>
                        <p className="text-xs text-[#A3D9BE]">Who → did what → to which patient/case → when.</p>
                      </div>
                      <div className="text-right">
                        <span className="block text-[10px] font-mono text-[#648E77] uppercase border border-[#164634] px-2 py-1 rounded-[1px]">
                          {filteredAuditLog.length} / {auditLog.length} events
                        </span>
                        <span className={`block mt-1 text-[10px] font-mono uppercase ${auditIntegrity.valid ? 'text-emerald-400' : 'text-rose-300'}`}>
                          {auditIntegrity.valid ? 'Chain intact' : `Tampered at #${auditIntegrity.brokenAt}`}
                        </span>
                      </div>
                    </div>

                    {/* Filters: actor, role, patient, case, action, date range */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                      <input
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Actor"
                        value={auditFilters.actor}
                        onChange={(e) => setAuditFilters({ ...auditFilters, actor: e.target.value })}
                      />
                      <select
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none"
                        value={auditFilters.role}
                        onChange={(e) => setAuditFilters({ ...auditFilters, role: e.target.value })}
                      >
                        <option value="">All roles</option>
                        {auditFacets.roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                      </select>
                      <input
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Patient ID"
                        value={auditFilters.patientId}
                        onChange={(e) => setAuditFilters({ ...auditFilters, patientId: e.target.value })}
                      />
                      <input
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Case ID"
                        value={auditFilters.caseId}
                        onChange={(e) => setAuditFilters({ ...auditFilters, caseId: e.target.value })}
                      />
                      <input
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Action (e.g. HUMAN_CORRECTION)"
                        value={auditFilters.action}
                        onChange={(e) => setAuditFilters({ ...auditFilters, action: e.target.value })}
                      />
                      <input
                        type="datetime-local"
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none"
                        value={auditFilters.from}
                        onChange={(e) => setAuditFilters({ ...auditFilters, from: e.target.value })}
                      />
                      <input
                        type="datetime-local"
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none"
                        value={auditFilters.to}
                        onChange={(e) => setAuditFilters({ ...auditFilters, to: e.target.value })}
                      />
                      <input
                        className="bg-[#072118] border border-[#164634] text-[#D8FCE8] text-xs px-2 py-1.5 rounded-[1px] outline-none focus:border-[#B5F5D1]"
                        placeholder="Search"
                        value={auditFilters.search}
                        onChange={(e) => setAuditFilters({ ...auditFilters, search: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => setAuditFilters({ actor: "", role: "", patientId: "", caseId: "", action: "", from: "", to: "", search: "" })}
                        className="text-[10px] font-mono uppercase tracking-wider text-[#B5F5D1] hover:text-white border border-[#164634] rounded-[1px] px-2 py-1.5 transition-colors"
                      >
                        Clear filters
                      </button>
                    </div>

                    <div className="flex-grow overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                      {filteredAuditLog.length === 0 ? (
                        <div className="text-center text-sm font-mono text-[#648E77] py-10 opacity-70">
                          {auditLog.length === 0
                            ? 'No events recorded in this session.'
                            : 'No audit events found for this filter.'}
                        </div>
                      ) : (
                        filteredAuditLog.map((log, index) => {
                          const lcolors = {
                            info: 'text-blue-400',
                            warn: 'text-amber-400',
                            error: 'text-rose-400',
                            success: 'text-emerald-400'
                          };
                          const expanded = auditExpandedId === index;
                          const hasChanges = Array.isArray(log.changes) && log.changes.length > 0;
                          return (
                            <div key={log.hash || index} className="bg-[#072118] border-l-2 border-[#164634] hover:border-[#648E77] transition-colors rounded-r-[1px] text-xs font-mono">
                              <button
                                type="button"
                                onClick={() => setAuditExpandedId(expanded ? null : index)}
                                className="w-full text-left p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className={`uppercase font-bold w-16 shrink-0 ${lcolors[log.level] || lcolors.info}`}>{log.level}</span>
                                  <div className="min-w-0">
                                    <span className="text-[#D8FCE8]">{log.action}</span>
                                    {log.details && <span className="text-[#648E77] hidden sm:inline ml-2">— {log.details}</span>}
                                    {hasChanges && <span className="text-amber-300 ml-2">({log.changes.length} change{log.changes.length === 1 ? '' : 's'})</span>}
                                  </div>
                                </div>
                                <div className="text-[#648E77] shrink-0 text-right">
                                  <span className="block">{log.actor}{log.role ? ` · ${log.role}` : ''}</span>
                                  <span>{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''}</span>
                                </div>
                              </button>

                              {expanded && (
                                <div className="px-3 pb-3 space-y-2 border-t border-[#164634]/60 pt-2">
                                  <div className="text-[10px] text-[#648E77]">{describeEvent(log)}</div>
                                  <div className="flex flex-wrap gap-3 text-[10px] font-mono text-[#648E77]">
                                    <span>patient: {log.patientId !== '' && log.patientId !== undefined ? `#${log.patientId}` : 'not applicable'}</span>
                                    <span>case: {log.caseId !== '' && log.caseId !== undefined ? `#${log.caseId}` : 'not applicable'}</span>
                                  </div>
                                  {hasChanges ? (
                                    <div className="space-y-1">
                                      {log.changes.map((change, changeIdx) => (
                                        <div key={changeIdx} className="flex items-center gap-2 text-[10px]">
                                          <span className="text-[#B5F5D1] uppercase">{change.field}</span>
                                          <span className="text-rose-300 line-through">{change.from || '(empty)'}</span>
                                          <span className="text-[#648E77]">→</span>
                                          <span className="text-emerald-300">{change.to || '(empty)'}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="text-[10px] text-[#648E77]">No field values changed in this event.</div>
                                  )}
                                  <div className="text-[9px] text-[#164634] break-all">
                                    hash {log.hash} · prev {log.prevHash}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {adminTab === 'system' && (
              <div>
                <h2 className="text-lg font-bold mb-1">System Health</h2>
                <p className="text-xs text-[#A3D9BE] mb-6">Database, AI API, and storage connections.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <span className="text-[10px] font-mono text-[#648E77] uppercase block mb-2">Supabase DB</span>
                    <span className="text-emerald-400 font-bold text-sm flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Operational</span>
                  </div>
                  <div className="p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <span className="text-[10px] font-mono text-[#648E77] uppercase block mb-2">Local Python AI API</span>
                    <span className="text-amber-400 font-bold text-sm flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>Idle (Waiting)</span>
                  </div>
                  <div className="p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <span className="text-[10px] font-mono text-[#648E77] uppercase block mb-2">Local Storage Usage</span>
                    <span className="text-[#D8FCE8] font-bold text-sm">2.4 MB</span>
                  </div>
                  <div className="p-4 bg-[#072118] border border-[#164634] rounded-[1px]">
                    <span className="text-[10px] font-mono text-[#648E77] uppercase block mb-2">Network Layer</span>
                    <span className="text-emerald-400 font-bold text-sm flex items-center gap-2">{isOnline ? 'Active' : 'Offline'}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ==========================================
  // VIEW: SETTINGS
  // ==========================================
  if (view === 'settings') {
    return (
      <div className="min-h-screen bg-[#072118] text-[#D8FCE8] flex flex-col justify-center items-center font-sans selection:bg-[#B5F5D1] selection:text-[#072118]">
        <Header />
        <FullScreenMenu />
        <div className="text-center animate-reveal-slow">
          <svg className="w-12 h-12 text-[#164634] mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          <h1 className="text-2xl font-bold tracking-widest text-[#648E77] mb-2">SYSTEM SETTINGS</h1>
          <p className="text-xs font-mono text-[#164634] uppercase tracking-wider mb-6">Restricted Access Module</p>
          <button onClick={() => setView('landing')} className="text-xs font-mono text-[#B5F5D1] hover:text-white uppercase underline underline-offset-4 tracking-wider">
            Return to Base
          </button>
        </div>
      </div>
    );
  }

  // Fallback
  return null;
}

