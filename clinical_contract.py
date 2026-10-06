"""Clinical fact contract for AROGYALEKH.

This module implements the *data* half of the Clinical Workflow / QA spec:

* every extracted fact carries a lifecycle status
  (``confirmed`` | ``uncertain`` | ``missing`` | ``conflict`` | ``human_corrected``),
* evidence is attached to the fact it supports (transcript span, voice timestamp,
  image region, or the worker's own typed note),
* contradictions between sources are **detected deterministically and never
  auto-resolved** — the fact is marked ``conflict`` and both values are preserved
  for the human reviewer,
* missing information produces targeted clarification / re-interview questions,
* human corrections are preserved as history instead of overwriting the original
  AI output.

It is deliberately dependency-free (standard library only) so it can be unit
tested without FastAPI, OpenAI or a database, and so the rules cannot drift
between the API and the tests. All functions are pure: timestamps are passed in
rather than read from the clock.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Sequence

# ---------------------------------------------------------------------------
# Status vocabulary
# ---------------------------------------------------------------------------

STATUS_CONFIRMED = "confirmed"
STATUS_UNCERTAIN = "uncertain"
STATUS_MISSING = "missing"
STATUS_CONFLICT = "conflict"
STATUS_HUMAN_CORRECTED = "human_corrected"

ALL_STATUSES = (
    STATUS_CONFIRMED,
    STATUS_UNCERTAIN,
    STATUS_MISSING,
    STATUS_CONFLICT,
    STATUS_HUMAN_CORRECTED,
)

EVIDENCE_KINDS = ("text_span", "transcript", "audio_timestamp", "image_region", "worker_note")

# Severity used for "must not sign until resolved" gating.
SEVERITY_HIGH = "high"
SEVERITY_MEDIUM = "medium"
SEVERITY_LOW = "low"

# ---------------------------------------------------------------------------
# Field canonicalisation
# ---------------------------------------------------------------------------

# Small, explicit synonym map so the same clinical concept extracted under
# different names still collides (which is what makes conflict detection work).
FIELD_SYNONYMS: Dict[str, str] = {
    "bp": "blood_pressure",
    "bloodpressure": "blood_pressure",
    "systolic": "blood_pressure",
    "diastolic": "blood_pressure",
    "temp": "temperature",
    "fever": "temperature",
    "pyrexia": "temperature",
    "pulse": "pulse",
    "heartrate": "pulse",
    "hr": "pulse",
    "spo2": "oxygen_saturation",
    "oxygen": "oxygen_saturation",
    "saturation": "oxygen_saturation",
    "weight": "weight",
    "wt": "weight",
    "bloodsugar": "blood_sugar",
    "sugar": "blood_sugar",
    "grbs": "blood_sugar",
    "glucose": "blood_sugar",
    "medication": "medication",
    "medications": "medication",
    "medicine": "medication",
    "drug": "medication",
    "rx": "medication",
    "prescription": "medication",
    "allergy": "drug_allergies",
    "allergies": "drug_allergies",
    "drugallergy": "drug_allergies",
    "patientname": "patient_name",
    "name": "patient_name",
    "diagnosis": "diagnosis",
    "impression": "diagnosis",
    "chiefcomplaint": "chief_complaint",
    "complaint": "chief_complaint",
    "symptoms": "chief_complaint",
    "rr": "respiratory_rate",
    "respiratoryrate": "respiratory_rate",
    "resp": "respiratory_rate",
}

# Clinical detail a signed encounter is expected to state. Absence becomes a
# clarification question, not a hard failure (a field worker may not be able to
# measure everything at a rural sub-centre).
EXPECTED_FIELDS: Dict[str, Dict[str, str]] = {
    "temperature": {"importance": SEVERITY_MEDIUM, "question": "What was the patient's recorded temperature?"},
    "blood_pressure": {"importance": SEVERITY_MEDIUM, "question": "What was the patient's blood pressure?"},
    "pulse": {"importance": SEVERITY_MEDIUM, "question": "What was the patient's pulse rate?"},
    "respiratory_rate": {"importance": SEVERITY_LOW, "question": "What was the patient's respiratory rate?"},
    "oxygen_saturation": {"importance": SEVERITY_MEDIUM, "question": "What was the patient's SpO2 reading?"},
    "weight": {"importance": SEVERITY_LOW, "question": "What is the patient's weight?"},
    "drug_allergies": {
        "importance": SEVERITY_HIGH,
        "question": "Does the patient have any known drug allergies? This must be asked before prescribing.",
    },
    "diagnosis": {"importance": SEVERITY_HIGH, "question": "What is the working diagnosis for this visit?"},
}


def canonical_field(name: Any) -> str:
    """Map a raw field name onto a stable canonical key."""
    if name is None:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "", str(name).lower())
    if not slug:
        return ""
    return FIELD_SYNONYMS.get(slug, re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_"))


def normalize_value(value: Any) -> str:
    """Normalise a fact value so that cosmetic differences are not conflicts.

    ``101 F`` / ``101.0Â°F`` / ``101f`` all normalise to ``101f`` so a genuine
    contradiction is required before a conflict is declared.
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return " | ".join(sorted(filter(None, (normalize_value(v) for v in value))))
    if isinstance(value, dict):
        inner = value.get("value", value)
        if inner is value:
            return json_stable(value)
        return normalize_value(inner)
    text = str(value).strip().lower()
    text = text.replace("°", "").replace("º", "")
    text = re.sub(r"\s+", " ", text)
    # Unify numeric formatting: 101.0 -> 101, .5 -> 0.5
    def _trim(match: "re.Match[str]") -> str:
        number = match.group(0)
        if "." in number:
            number = number.rstrip("0").rstrip(".")
        return number or "0"

    text = re.sub(r"\d+\.\d+|\d+", _trim, text)
    text = text.replace(" ", "")
    return text


def json_stable(value: Any) -> str:
    """Small JSON dumper that does not need the json module's ordering knobs."""
    import json

    try:
        return json.dumps(value, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(value)


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


def make_evidence(
    kind: str,
    *,
    ref: str = "",
    quote: str = "",
    timestamp: Optional[float] = None,
    region: Optional[Sequence[float]] = None,
    label: str = "",
) -> Dict[str, Any]:
    """Build one evidence record.

    ``kind`` must be one of :data:`EVIDENCE_KINDS`; anything else is coerced to
    ``text_span`` so a malformed model response cannot invent a new evidence type.
    """
    normalized_kind = kind if kind in EVIDENCE_KINDS else "text_span"
    evidence: Dict[str, Any] = {"kind": normalized_kind}
    if ref:
        evidence["ref"] = str(ref)
    if quote:
        evidence["quote"] = str(quote)
    if timestamp is not None:
        try:
            evidence["timestamp"] = float(timestamp)
        except (TypeError, ValueError):
            pass
    if region is not None:
        try:
            evidence["region"] = [float(v) for v in list(region)[:4]]
        except (TypeError, ValueError):
            pass
    if label:
        evidence["label"] = str(label)
    return evidence


def text_span_evidence(source_text: str, quote: str, *, ref: str = "") -> Optional[Dict[str, Any]]:
    """Locate ``quote`` inside ``source_text`` and return span evidence.

    Returns ``None`` when the quote cannot be found, which is how an
    unsupported / potentially fabricated claim is detected: the model asserted
    something that does not appear in the source it was given.
    """
    if not source_text or not quote:
        return None
    needle = str(quote).strip()
    if not needle:
        return None
    haystack_lower = source_text.lower()
    index = haystack_lower.find(needle.lower())
    if index < 0:
        return None
    return make_evidence(
        "text_span",
        ref=ref,
        quote=source_text[index : index + len(needle)],
        label=f"chars {index}-{index + len(needle)}",
    )


def dedupe_evidence(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Drop duplicate evidence records while preserving order."""
    seen = set()
    result: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        key = json_stable(item)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# Facts
# ---------------------------------------------------------------------------


def make_fact(
    field: Any,
    value: Any = None,
    *,
    status: str = STATUS_CONFIRMED,
    confidence: Optional[float] = None,
    evidence: Optional[Iterable[Dict[str, Any]]] = None,
    source: str = "ai",
    source_ref: str = "",
    importance: str = "",
    reason: str = "",
    original_value: Any = None,
    corrections: Optional[Iterable[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Build one fact in the spec's shape.

    ``source`` names where the value came from (``ai`` / ``voice`` / ``image`` /
    ``worker``) and ``source_ref`` identifies the specific artefact (a filename or
    audio id). Conflict detection needs both: two different values belonging to
    the *same* source and artefact are a repeat, not a contradiction.
    """
    safe_status = status if status in ALL_STATUSES else STATUS_CONFIRMED
    fact: Dict[str, Any] = {
        "field": canonical_field(field) or str(field or "").strip(),
        "value": value,
        "status": safe_status,
        "evidence": dedupe_evidence(evidence or []),
        "source": str(source or "ai"),
    }
    if source_ref:
        fact["source_ref"] = str(source_ref)
    if confidence is not None:
        try:
            fact["confidence"] = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            pass
    if importance:
        fact["importance"] = importance
    if reason:
        fact["reason"] = str(reason)
    if original_value is not None:
        fact["original_value"] = original_value
    if corrections:
        fact["corrections"] = [dict(c) for c in corrections]
    return fact


def apply_human_correction(
    fact: Dict[str, Any],
    new_value: Any,
    *,
    actor: str = "worker",
    timestamp: str = "",
    reason: str = "",
) -> Dict[str, Any]:
    """Return a copy of ``fact`` with the human correction recorded as history.

    The original AI value is preserved (``original_value`` on first correction,
    appended to ``corrections`` thereafter), so the audit trail can always
    reconstruct what the AI said versus what the human decided.
    """
    corrected = dict(fact or {})
    previous = corrected.get("value")
    history = list(corrected.get("corrections") or [])

    if corrected.get("status") == STATUS_HUMAN_CORRECTED:
        original = corrected.get("original_value")
    else:
        original = previous

    history.append(
        {
            "from": previous,
            "to": new_value,
            "actor": actor,
            "timestamp": timestamp,
            "reason": reason,
        }
    )

    corrected["value"] = new_value
    corrected["status"] = STATUS_HUMAN_CORRECTED
    corrected["original_value"] = original
    corrected["corrections"] = history
    corrected["source"] = "worker"
    # A human correction is the strongest evidence available for that value.
    corrected["evidence"] = dedupe_evidence(
        list(corrected.get("evidence") or [])
        + [make_evidence("worker_note", ref=actor, quote=reason or "Corrected during review", label="human review")]
    )
    return corrected


# ---------------------------------------------------------------------------
# Conflict detection
# ---------------------------------------------------------------------------


def attribute_sources(
    facts: Sequence[Dict[str, Any]],
    sources: Sequence[Dict[str, Any]],
    *,
    default_source: str = "ai",
) -> List[Dict[str, Any]]:
    """Assign a ``source``/``source_ref`` to each fact by locating its evidence quote.

    The capture pipeline feeds several inputs (typed notes, a voice transcript, a
    photograph of a handwritten note) into one extraction call. To detect
    contradictions *between* those inputs we still need to know which input each
    extracted fact came from. Rather than paying for one model call per source,
    each fact's own evidence quote is looked up in every source text: the first
    source containing the quote is the source the fact came from. Facts whose
    quote matches nothing are attributed to ``default_source`` (typically the
    image or the model itself).

    ``sources`` entries look like ``{"kind": "voice", "ref": "audio-1", "text": "..."}``.
    """
    prepared = []
    for source in sources or []:
        if not isinstance(source, dict):
            continue
        text = source.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        prepared.append(
            {
                "kind": str(source.get("kind") or "text"),
                "ref": str(source.get("ref") or source.get("kind") or "text"),
                "text_lower": text.lower(),
            }
        )

    attributed: List[Dict[str, Any]] = []
    for fact in facts or []:
        copy = dict(fact)
        quotes = [
            ev.get("quote")
            for ev in (copy.get("evidence") or [])
            if isinstance(ev, dict) and ev.get("quote")
        ]
        matched = None
        for quote in quotes:
            needle = str(quote).strip().lower()
            if not needle:
                continue
            for source in prepared:
                if needle in source["text_lower"]:
                    matched = source
                    break
            if matched:
                break
        if matched:
            copy["source"] = matched["kind"]
            copy["source_ref"] = matched["ref"]
        elif not copy.get("source"):
            copy["source"] = default_source
        attributed.append(copy)
    return attributed


def detect_conflicts(per_source_facts: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Find facts whose value differs between sources.

    ``per_source_facts`` is a flat list of facts, each carrying a ``source``
    (and optionally ``source_ref``/``evidence``). Facts are grouped by canonical
    field; any group holding two or more distinct normalised values is reported
    as a conflict **with every value preserved**. This function never selects a
    winner — that decision belongs to the human reviewer.
    """
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []

    for fact in per_source_facts or []:
        if not isinstance(fact, dict):
            continue
        field = canonical_field(fact.get("field"))
        if not field:
            continue
        value = fact.get("value")
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if field not in grouped:
            grouped[field] = []
            order.append(field)
        grouped[field].append(fact)

    conflicts: List[Dict[str, Any]] = []
    for field in order:
        facts = grouped[field]
        by_value: Dict[str, List[Dict[str, Any]]] = {}
        value_order: List[str] = []
        for fact in facts:
            key = normalize_value(fact.get("value"))
            if not key:
                continue
            if key not in by_value:
                by_value[key] = []
                value_order.append(key)
            by_value[key].append(fact)

        if len(value_order) < 2:
            continue

        # Same source repeating itself is not a contradiction.
        distinct_sources = {
            (str(f.get("source") or "ai"), str(f.get("source_ref") or ""))
            for group in by_value.values()
            for f in group
        }
        if len(distinct_sources) < 2:
            continue

        options = []
        for key in value_order:
            group = by_value[key]
            representative = group[0]
            options.append(
                {
                    "value": representative.get("value"),
                    "normalized": key,
                    "sources": sorted({str(f.get("source") or "ai") for f in group}),
                    "evidence": dedupe_evidence(
                        ev for f in group for ev in (f.get("evidence") or [])
                    ),
                }
            )

        conflicts.append(
            {
                "field": field,
                "status": STATUS_CONFLICT,
                "importance": SEVERITY_HIGH,
                "requires_resolution": True,
                "reason": (
                    f"Sources disagree on '{field}': "
                    + " vs ".join(str(option["value"]) for option in options)
                    + ". A human must choose or record the correct value."
                ),
                "options": options,
            }
        )

    return conflicts


def apply_conflicts(facts: Sequence[Dict[str, Any]], conflicts: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Mark every fact of a conflicted field as ``conflict`` (keeping both values)."""
    conflicted_fields = {c.get("field") for c in conflicts or []}
    if not conflicted_fields:
        return [dict(f) for f in facts or []]
    marked = []
    for fact in facts or []:
        copy = dict(fact)
        if canonical_field(copy.get("field")) in conflicted_fields:
            copy["status"] = STATUS_CONFLICT
        marked.append(copy)
    return marked


# ---------------------------------------------------------------------------
# Clarification / re-interview questions
# ---------------------------------------------------------------------------


def build_clarification_questions(
    missing: Sequence[Any],
    *,
    conflicts: Sequence[Dict[str, Any]] = (),
    max_questions: int = 8,
) -> List[Dict[str, Any]]:
    """Turn missing/conflicting information into targeted follow-up questions."""
    questions: List[Dict[str, Any]] = []

    for conflict in conflicts or []:
        options = conflict.get("options") or []
        rendered = " / ".join(str(option.get("value")) for option in options)
        questions.append(
            {
                "field": conflict.get("field"),
                "kind": "conflict",
                "importance": SEVERITY_HIGH,
                "question": (
                    f"Two sources disagree about {str(conflict.get('field')).replace('_', ' ')} "
                    f"({rendered}). Which value is correct?"
                ),
            }
        )

    for entry in missing or []:
        if isinstance(entry, str):
            field = canonical_field(entry)
            importance = SEVERITY_MEDIUM
            reason = ""
        elif isinstance(entry, dict):
            field = canonical_field(entry.get("field"))
            importance = str(entry.get("importance") or SEVERITY_MEDIUM).lower()
            reason = str(entry.get("reason") or "")
        else:
            continue

        if not field:
            continue

        template = EXPECTED_FIELDS.get(field)
        if template:
            question = template["question"]
            importance = template["importance"]
        else:
            label = field.replace("_", " ")
            question = f"{label.capitalize()} was not documented. Please record it or confirm it is not applicable."

        questions.append(
            {
                "field": field,
                "kind": "missing",
                "importance": importance,
                "question": question,
                "reason": reason,
            }
        )

    for field, template in EXPECTED_FIELDS.items():
        if template["importance"] != SEVERITY_HIGH:
            continue
        if any(question.get("field") == field for question in questions):
            continue
        if any(canonical_field(entry.get("field") if isinstance(entry, dict) else entry) == field for entry in missing or []):
            continue
        questions.append(
            {
                "field": field,
                "kind": "prerequisite",
                "importance": SEVERITY_HIGH,
                "question": template["question"],
            }
        )

    # Highest importance first, then stable order.
    rank = {SEVERITY_HIGH: 0, SEVERITY_MEDIUM: 1, SEVERITY_LOW: 2}
    questions.sort(key=lambda q: rank.get(str(q.get("importance")), 1))
    return questions[:max_questions]


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def _clean_str_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, (list, tuple)):
        out: List[str] = []
        for item in value:
            text = str(item.get("value") if isinstance(item, dict) and "value" in item else item).strip()
            if text:
                out.append(text)
        return out
    return [str(value)]


def assemble_report(
    model_payload: Optional[Dict[str, Any]],
    *,
    per_source_facts: Sequence[Dict[str, Any]] = (),
    source_text: str = "",
    expected_patient_name: str = "",
    source_refs: Optional[Sequence[Dict[str, Any]]] = None,
    generated_at: str = "",
    attach_span_evidence: bool = True,
) -> Dict[str, Any]:
    """Normalise a model payload into the full clinical contract.

    The returned dict keeps the legacy keys the current UI already reads
    (``summary``, ``confirmed``, ``uncertain``, ``missing``, ``follow_ups``) so
    the endpoint stays backward compatible, and adds the spec's richer keys
    (``facts``, ``conflicts``, ``clarification_questions``, ``sources``).
    """
    payload = model_payload if isinstance(model_payload, dict) else {}

    confirmed_raw = payload.get("confirmed") if isinstance(payload.get("confirmed"), list) else []
    uncertain_raw = payload.get("uncertain") if isinstance(payload.get("uncertain"), list) else []
    missing_raw = payload.get("missing") if isinstance(payload.get("missing"), list) else []

    facts: List[Dict[str, Any]] = []

    for item in confirmed_raw:
        if isinstance(item, dict):
            field = item.get("field")
            value = item.get("value")
            quote = str(item.get("source_quote") or item.get("quote") or "")
            confidence = item.get("confidence")
            importance = item.get("importance") or ""
            item_source = str(item.get("source") or "ai")
            item_source_ref = str(item.get("source_ref") or "")
        else:
            field, value, quote, confidence, importance = item, item, "", None, ""
            item_source, item_source_ref = "ai", ""
        # A model that returns null/garbage entries must not create unnamed facts.
        if not canonical_field(field):
            continue
        evidence = []
        if quote:
            if attach_span_evidence and source_text:
                span = text_span_evidence(source_text, quote, ref=source_refs[0].get("ref", "") if source_refs else "")
                if span:
                    evidence.append(span)
                else:
                    # Model asserted a quote that is not in the source: keep it but
                    # mark it as unverified evidence rather than trusting it.
                    evidence.append(make_evidence("text_span", quote=quote, label="unverified quote"))
            else:
                evidence.append(make_evidence("text_span", quote=quote))
        item_evidence = item.get("evidence") if isinstance(item, dict) else None
        if isinstance(item_evidence, list):
            evidence.extend(ev for ev in item_evidence if isinstance(ev, dict))
        facts.append(
            make_fact(
                field,
                value,
                status=STATUS_CONFIRMED,
                confidence=confidence if isinstance(confidence, (int, float)) else None,
                evidence=evidence,
                source=item_source,
                source_ref=item_source_ref,
                importance=str(importance).lower() if importance else "",
            )
        )

    for item in uncertain_raw:
        if isinstance(item, dict):
            field = item.get("field")
            value = item.get("value")
            quote = str(item.get("source_quote") or item.get("quote") or "")
            confidence = item.get("confidence")
            item_source = str(item.get("source") or "ai")
            item_source_ref = str(item.get("source_ref") or "")
        else:
            field, value, quote, confidence = item, item, "", None
            item_source, item_source_ref = "ai", ""
        if not canonical_field(field):
            continue
        evidence = [make_evidence("text_span", quote=quote, label="uncertain")] if quote else []
        if attach_span_evidence and source_text and quote:
            span = text_span_evidence(source_text, quote)
            if span:
                evidence = [span]
        facts.append(
            make_fact(
                field,
                value,
                status=STATUS_UNCERTAIN,
                confidence=confidence if isinstance(confidence, (int, float)) else None,
                evidence=evidence,
                source=item_source,
                source_ref=item_source_ref,
            )
        )

    # Facts contributed directly by capture sources (voice transcripts, image regions).
    for raw in per_source_facts or []:
        if isinstance(raw, dict):
            if not canonical_field(raw.get("field")):
                continue
            facts.append(make_fact(**{k: v for k, v in raw.items() if k in {
                "field", "value", "status", "confidence", "evidence",
                "source", "source_ref", "importance", "reason",
            }}))

    conflicts = detect_conflicts(facts)
    facts = apply_conflicts(facts, conflicts)

    # Legacy-shaped views, derived from the fact list where possible.
    confirmed = [
        {
            "field": fact["field"],
            "value": fact["value"],
            "status": fact["status"],
            "source_quote": next((ev.get("quote", "") for ev in fact.get("evidence") or [] if ev.get("quote")), ""),
            "evidence": fact.get("evidence") or [],
            "source": fact.get("source", "ai"),
        }
        for fact in facts
        if fact.get("status") in (STATUS_CONFIRMED, STATUS_HUMAN_CORRECTED)
    ]

    uncertain = [
        {
            "field": fact["field"],
            "value": fact["value"],
            "status": STATUS_UNCERTAIN,
            "source_quote": next((ev.get("quote", "") for ev in fact.get("evidence") or [] if ev.get("quote")), ""),
            "evidence": fact.get("evidence") or [],
            "source": fact.get("source", "ai"),
        }
        for fact in facts
        if fact.get("status") == STATUS_UNCERTAIN
    ]

    missing: List[Dict[str, Any]] = []
    documented = {fact.get("field") for fact in facts if fact.get("status") != STATUS_MISSING}

    for entry in missing_raw:
        if isinstance(entry, dict):
            field = entry.get("field")
            importance = str(entry.get("importance") or SEVERITY_MEDIUM).lower()
            reason = str(entry.get("reason") or "")
        else:
            field = entry
            importance = SEVERITY_MEDIUM
            reason = ""
        canonical = canonical_field(field)
        if canonical and canonical in documented:
            continue
        missing.append({"field": field, "importance": importance, "reason": reason, "status": STATUS_MISSING})

    for conflict in conflicts:
        missing.append(
            {
                "field": conflict["field"],
                "importance": SEVERITY_HIGH,
                "reason": conflict["reason"],
                "status": STATUS_CONFLICT,
            }
        )

    # Patient identity guard — the existing safety behaviour, preserved.
    identity_block = None
    if expected_patient_name:
        expected_norm = normalize_value(expected_patient_name)
        name_facts = [fact for fact in facts if canonical_field(fact.get("field")) == "patient_name"]
        for fact in name_facts:
            got = normalize_value(fact.get("value"))
            if not got:
                continue
            if got == expected_norm or got in expected_norm or expected_norm in got:
                continue
            identity_block = f'Patient Identity Mismatch: document shows "{fact.get("value")}", active record is "{expected_patient_name}".'
            missing.append(
                {
                    "field": "Patient Identity Mismatch",
                    "importance": SEVERITY_HIGH,
                    "reason": (
                        "The name on the document does not match the active patient record. "
                        "DO NOT proceed with treatment based on this document."
                    ),
                    "status": STATUS_CONFLICT,
                }
            )
            break

    clarification = build_clarification_questions(missing, conflicts=conflicts)

    report: Dict[str, Any] = {
        "summary": str(payload.get("summary") or "").strip(),
        "facts": facts,
        "confirmed": confirmed,
        "uncertain": uncertain,
        "missing": missing,
        "conflicts": conflicts,
        "clarification_questions": clarification,
        "follow_ups": _clean_str_list(payload.get("follow_ups")),
        "sources": [dict(ref) for ref in (source_refs or [])],
        "identity_block": identity_block,
        "generated_at": generated_at,
    }
    return report


def pipeline_dry_run() -> Dict[str, Any]:
    """Offline self-check used by tests: proves the pipeline works end to end
    without needing a network call, an API key or FastAPI installed."""
    payload = {
        "summary": "Fever for three days with a mild cough.",
        "confirmed": [
            {"field": "temperature", "value": "101 F", "source_quote": "bukhar 101"},
            {"field": "diagnosis", "value": "Acute Febrile Illness", "source_quote": "fever three days"},
        ],
        "uncertain": [{"field": "drug_allergies", "value": "illegible"}],
        "missing": [{"field": "blood_pressure", "importance": "medium", "reason": "not recorded"}],
        "follow_ups": ["Review after 3 days"],
    }
    sources = [
        {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar 101 aur khansi"},
        {"kind": "text", "ref": "notes", "text": "fever three days, mild cough"},
    ]
    return assemble_from_sources(payload, sources=sources, expected_patient_name="Ramesh Sharma")


def assemble_from_sources(
    model_payload: Optional[Dict[str, Any]],
    *,
    sources: Sequence[Dict[str, Any]] = (),
    expected_patient_name: str = "",
    voice_transcript: str = "",
    image_ref: str = "",
    generated_at: str = "",
) -> Dict[str, Any]:
    """Full pipeline: model payload + capture sources -> validated clinical contract.

    This is what the API should call after extraction. Keeping it here (rather than
    in the request handler) means the merge rules are unit tested without FastAPI,
    an API key or a network call.
    """
    source_list = [dict(s) for s in (sources or []) if isinstance(s, dict)]

    if voice_transcript and not any(s.get("kind") == "voice" for s in source_list):
        source_list.append({"kind": "voice", "ref": "audio-1", "text": voice_transcript})
    if image_ref and not any(s.get("kind") == "image" for s in source_list):
        source_list.append({"kind": "image", "ref": image_ref})

    source_refs = [
        {"kind": str(s.get("kind") or "text"), "ref": str(s.get("ref") or s.get("kind") or "text")}
        for s in source_list
    ]

    # Text inputs that evidence spans can be located inside, longest first so the
    # most specific (usually the typed note) wins a tie.
    text_sources = sorted(
        [s for s in source_list if isinstance(s.get("text"), str) and s["text"].strip()],
        key=lambda s: len(s.get("text") or ""),
        reverse=True,
    )

    first_text_ref = source_refs[0]["ref"] if source_refs else ""

    report = assemble_report(
        model_payload,
        source_text=text_sources[0]["text"] if text_sources else "",
        expected_patient_name=expected_patient_name,
        source_refs=source_refs,
        generated_at=generated_at,
        attach_span_evidence=True,
    )

    # Recompute conflicts now that each fact knows which input it came from:
    # before attribution, two facts from one merged prompt could not be compared.
    attributed = attribute_sources(report["facts"], text_sources, default_source="ai")
    conflicts = detect_conflicts(attributed)
    attributed = apply_conflicts(attributed, conflicts)

    documented = {f.get("field") for f in attributed if f.get("status") != STATUS_MISSING}
    missing = []
    for entry in report.get("missing") or []:
        field = canonical_field(entry.get("field") if isinstance(entry, dict) else entry)
        if field and field in documented and entry.get("status") != STATUS_CONFLICT:
            continue
        missing.append(entry)
    for conflict in conflicts:
        if not any(canonical_field(m.get("field")) == conflict["field"] for m in missing):
            missing.append(
                {
                    "field": conflict["field"],
                    "importance": SEVERITY_HIGH,
                    "reason": conflict["reason"],
                    "status": STATUS_CONFLICT,
                }
            )

    confirmed = [
        {
            "field": f["field"],
            "value": f["value"],
            "status": f["status"],
            "source_quote": next((ev.get("quote", "") for ev in f.get("evidence") or [] if ev.get("quote")), ""),
            "evidence": f.get("evidence") or [],
            "source": f.get("source", "ai"),
        }
        for f in attributed
        if f.get("status") in (STATUS_CONFIRMED, STATUS_HUMAN_CORRECTED)
    ]
    uncertain = [
        {
            "field": f["field"],
            "value": f["value"],
            "status": STATUS_UNCERTAIN,
            "source_quote": next((ev.get("quote", "") for ev in f.get("evidence") or [] if ev.get("quote")), ""),
            "evidence": f.get("evidence") or [],
            "source": f.get("source", "ai"),
        }
        for f in attributed
        if f.get("status") == STATUS_UNCERTAIN
    ]

    report.update(
        {
            "facts": attributed,
            "conflicts": conflicts,
            "confirmed": confirmed,
            "uncertain": uncertain,
            "missing": missing,
            "clarification_questions": build_clarification_questions(missing, conflicts=conflicts),
            "sources": source_refs,
        }
    )
    return report


def validate_report(report: Any) -> List[str]:
    """Schema guard used by tests and by the API before returning a report."""
    problems: List[str] = []
    if not isinstance(report, dict):
        return ["report is not an object"]

    for key in ("summary", "facts", "confirmed", "uncertain", "missing", "conflicts", "clarification_questions", "follow_ups", "sources"):
        if key not in report:
            problems.append(f"missing key: {key}")

    for index, fact in enumerate(report.get("facts") or []):
        if not isinstance(fact, dict):
            problems.append(f"facts[{index}] is not an object")
            continue
        if fact.get("status") not in ALL_STATUSES:
            problems.append(f"facts[{index}] has invalid status: {fact.get('status')!r}")
        if not canonical_field(fact.get("field")):
            problems.append(f"facts[{index}] has no usable field name")
        if not isinstance(fact.get("evidence"), list):
            problems.append(f"facts[{index}].evidence is not a list")
        if fact.get("status") == STATUS_HUMAN_CORRECTED and fact.get("original_value") is None and not fact.get("corrections"):
            problems.append(f"facts[{index}] is human_corrected but keeps no history")

    for index, conflict in enumerate(report.get("conflicts") or []):
        if not isinstance(conflict, dict):
            problems.append(f"conflicts[{index}] is not an object")
            continue
        options = conflict.get("options")
        if not isinstance(options, list) or len(options) < 2:
            problems.append(f"conflicts[{index}] does not preserve both values")
        if conflict.get("fixed_value") is not None:
            problems.append(f"conflicts[{index}] was auto-resolved, which the spec forbids")

    return problems
