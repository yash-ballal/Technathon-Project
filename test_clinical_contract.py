"""Tests for the clinical fact contract (standard library only).

Run with: python -m unittest test_clinical_contract -v
"""

import unittest

import clinical_contract as cc


def fact(field, value, source="ai", ref="", quote=""):
    evidence = [cc.make_evidence("text_span", quote=quote, ref=ref)] if quote else []
    return cc.make_fact(field, value, evidence=evidence, source=source, source_ref=ref)


class CanonicalFieldTests(unittest.TestCase):
    def test_synonyms_collapse(self):
        self.assertEqual(cc.canonical_field("BP"), "blood_pressure")
        self.assertEqual(cc.canonical_field("blood pressure"), "blood_pressure")
        self.assertEqual(cc.canonical_field("Temp"), "temperature")
        self.assertEqual(cc.canonical_field("fever"), "temperature")
        self.assertEqual(cc.canonical_field("SpO2"), "oxygen_saturation")

    def test_unknown_field_is_slugified_not_dropped(self):
        self.assertEqual(cc.canonical_field("Chief Complaint"), "chief_complaint")
        self.assertEqual(cc.canonical_field("Random Field!"), "random_field")

    def test_empty_names(self):
        self.assertEqual(cc.canonical_field(None), "")
        self.assertEqual(cc.canonical_field("   "), "")


class NormalizeValueTests(unittest.TestCase):
    def test_cosmetic_differences_are_equal(self):
        self.assertEqual(cc.normalize_value("101 F"), cc.normalize_value("101f"))
        self.assertEqual(cc.normalize_value("101.0°F"), cc.normalize_value("101 f"))
        self.assertEqual(cc.normalize_value("  101   F "), cc.normalize_value("101F"))

    def test_different_values_are_not_equal(self):
        self.assertNotEqual(cc.normalize_value("100 F"), cc.normalize_value("101 F"))

    def test_lists_order_insensitive(self):
        self.assertEqual(cc.normalize_value(["b", "a"]), cc.normalize_value(["a", "b"]))


class EvidenceTests(unittest.TestCase):
    def test_span_evidence_found(self):
        ev = cc.text_span_evidence("Patient has fever 101F since 2 days", "fever 101F")
        self.assertIsNotNone(ev)
        self.assertEqual(ev["kind"], "text_span")
        self.assertEqual(ev["quote"], "fever 101F")

    def test_missing_quote_returns_none_so_fabrication_is_detectable(self):
        self.assertIsNone(cc.text_span_evidence("Patient has fever", "chest pain radiating to arm"))

    def test_unknown_evidence_kind_is_coerced(self):
        ev = cc.make_evidence("telepathy", quote="x")
        self.assertEqual(ev["kind"], "text_span")

    def test_evidence_deduped(self):
        ev = cc.make_evidence("text_span", quote="fever")
        self.assertEqual(len(cc.dedupe_evidence([ev, dict(ev)])), 1)


class HumanCorrectionTests(unittest.TestCase):
    def test_correction_preserves_original_ai_value(self):
        original = cc.make_fact("temperature", "100 F", status=cc.STATUS_CONFIRMED)
        corrected = cc.apply_human_correction(original, "101 F", actor="Sita Devi", timestamp="2026-10-06T10:10:00Z")

        self.assertEqual(corrected["value"], "101 F")
        self.assertEqual(corrected["original_value"], "100 F")
        self.assertEqual(corrected["status"], cc.STATUS_HUMAN_CORRECTED)
        self.assertEqual(len(corrected["corrections"]), 1)
        self.assertEqual(corrected["corrections"][0]["from"], "100 F")
        self.assertEqual(corrected["corrections"][0]["to"], "101 F")
        self.assertEqual(corrected["corrections"][0]["actor"], "Sita Devi")
        # The original fact object is not mutated.
        self.assertEqual(original["value"], "100 F")

    def test_second_correction_keeps_first_in_history(self):
        fact = cc.make_fact("temperature", "100 F")
        once = cc.apply_human_correction(fact, "101 F", actor="A", timestamp="t1")
        twice = cc.apply_human_correction(once, "102 F", actor="B", timestamp="t2")

        self.assertEqual(twice["value"], "102 F")
        self.assertEqual(twice["original_value"], "100 F")
        self.assertEqual([c["to"] for c in twice["corrections"]], ["101 F", "102 F"])
        self.assertEqual([c["actor"] for c in twice["corrections"]], ["A", "B"])

    def test_correction_is_worker_attributed_not_ai(self):
        corrected = cc.apply_human_correction(cc.make_fact("pulse", "80"), "84", actor="worker")
        self.assertEqual(corrected["source"], "worker")
        self.assertTrue(any(ev["kind"] == "worker_note" for ev in corrected["evidence"]))


class ConflictDetectionTests(unittest.TestCase):
    def test_two_sources_disagreeing_produces_conflict_with_both_values(self):
        facts = [
            fact("temperature", "100 F", source="voice", ref="audio", quote="one hundred"),
            fact("temperature", "101 F", source="image", ref="rx.jpg"),
        ]
        conflicts = cc.detect_conflicts(facts)

        self.assertEqual(len(conflicts), 1)
        conflict = conflicts[0]
        self.assertEqual(conflict["field"], "temperature")
        self.assertTrue(conflict["requires_resolution"])
        values = {opt["value"] for opt in conflict["options"]}
        self.assertEqual(values, {"100 F", "101 F"})
        self.assertNotIn("fixed_value", conflict)

    def test_same_value_from_two_sources_is_not_a_conflict(self):
        facts = [
            fact("temperature", "101 F", source="voice", ref="audio"),
            fact("temperature", "101.0°F", source="image", ref="rx.jpg"),
        ]
        self.assertEqual(cc.detect_conflicts(facts), [])

    def test_single_source_repeating_itself_is_not_a_conflict(self):
        facts = [
            fact("temperature", "100 F", source="voice", ref="audio"),
            fact("temperature", "101 F", source="voice", ref="audio"),
        ]
        self.assertEqual(cc.detect_conflicts(facts), [])

    def test_alternate_field_names_still_collide(self):
        facts = [
            fact("BP", "120/80", source="voice", ref="a"),
            fact("blood pressure", "150/95", source="image", ref="b"),
        ]
        conflicts = cc.detect_conflicts(facts)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["field"], "blood_pressure")

    def test_empty_values_do_not_conflict(self):
        facts = [
            fact("temperature", "", source="voice", ref="a"),
            fact("temperature", "101 F", source="image", ref="b"),
        ]
        self.assertEqual(cc.detect_conflicts(facts), [])

    def test_apply_conflicts_marks_facts_but_keeps_values(self):
        facts = [
            fact("temperature", "100 F", source="voice", ref="a"),
            fact("temperature", "101 F", source="image", ref="b"),
        ]
        conflicts = cc.detect_conflicts(facts)
        marked = cc.apply_conflicts(facts, conflicts)

        self.assertTrue(all(f["status"] == cc.STATUS_CONFLICT for f in marked))
        self.assertEqual({f["value"] for f in marked}, {"100 F", "101 F"})


class ClarificationTests(unittest.TestCase):
    def test_missing_expected_field_gets_targeted_question(self):
        questions = cc.build_clarification_questions([{"field": "blood_pressure", "importance": "medium"}])
        bp = [q for q in questions if q["field"] == "blood_pressure"]
        self.assertTrue(bp)
        self.assertIn("blood pressure", bp[0]["question"].lower())

    def test_conflict_produces_resolution_question(self):
        facts = [
            fact("temperature", "100 F", source="voice", ref="a"),
            fact("temperature", "101 F", source="image", ref="b"),
        ]
        conflicts = cc.detect_conflicts(facts)
        questions = cc.build_clarification_questions([], conflicts=conflicts)

        conflict_questions = [q for q in questions if q["kind"] == "conflict"]
        self.assertEqual(len(conflict_questions), 1)
        self.assertIn("100 F", conflict_questions[0]["question"])
        self.assertIn("101 F", conflict_questions[0]["question"])
        self.assertEqual(conflict_questions[0]["importance"], cc.SEVERITY_HIGH)

    def test_high_importance_prerequisites_are_always_asked(self):
        questions = cc.build_clarification_questions([])
        fields = {q["field"] for q in questions}
        self.assertIn("drug_allergies", fields)
        self.assertIn("diagnosis", fields)

    def test_high_importance_questions_come_first(self):
        questions = cc.build_clarification_questions([{"field": "weight", "importance": "low"}])
        self.assertEqual(questions[0]["importance"], cc.SEVERITY_HIGH)

    def test_unknown_field_still_gets_a_question(self):
        questions = cc.build_clarification_questions(["occupation history"])
        self.assertTrue(any(q["field"] == "occupation_history" for q in questions))

    def test_question_cap_respected(self):
        missing = [{"field": f"custom_field_{i}"} for i in range(30)]
        questions = cc.build_clarification_questions(missing, max_questions=8)
        self.assertEqual(len(questions), 8)


class AssembleReportTests(unittest.TestCase):
    def payload(self):
        return {
            "summary": "Fever for 3 days.",
            "confirmed": [
                {"field": "temperature", "value": "101 F", "source_quote": "fever 101"},
                {"field": "diagnosis", "value": "Viral Pyrexia", "source_quote": "viral"},
            ],
            "uncertain": [{"field": "drug_allergies", "value": "illegible"}],
            "missing": [{"field": "blood_pressure", "importance": "medium", "reason": "not recorded"}],
            "follow_ups": ["Review after 3 days"],
        }

    def test_legacy_keys_preserved_for_existing_ui(self):
        report = cc.assemble_report(self.payload(), source_text="patient has fever 101 and viral picture")
        for key in ("summary", "confirmed", "uncertain", "missing", "follow_ups"):
            self.assertIn(key, report)
        self.assertEqual(report["confirmed"][0]["field"], "temperature")

    def test_new_contract_keys_present(self):
        report = cc.assemble_report(self.payload())
        for key in ("facts", "conflicts", "clarification_questions", "sources", "identity_block"):
            self.assertIn(key, report)

    def test_every_fact_has_a_status_and_evidence_list(self):
        report = cc.assemble_report(self.payload(), source_text="fever 101 viral")
        self.assertTrue(report["facts"])
        for f in report["facts"]:
            self.assertIn(f["status"], cc.ALL_STATUSES)
            self.assertIsInstance(f["evidence"], list)

    def test_quote_not_in_source_is_kept_but_flagged_unverified(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "temperature", "value": "101 F", "source_quote": "fever 101"}]},
            source_text="the patient came in today",
        )
        evidence = report["facts"][0]["evidence"]
        self.assertTrue(evidence)
        self.assertEqual(evidence[0].get("label"), "unverified quote")

    def test_span_evidence_attached_when_quote_is_real(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "temperature", "value": "101 F", "source_quote": "fever 101"}]},
            source_text="Patient reports fever 101 since Tuesday",
        )
        evidence = report["facts"][0]["evidence"]
        self.assertEqual(evidence[0]["kind"], "text_span")
        self.assertIn("chars", evidence[0].get("label", ""))

    def test_patient_identity_mismatch_flagged_high(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "patient_name", "value": "Sunita Devi"}]},
            expected_patient_name="Ramesh Sharma",
        )
        mismatch = [m for m in report["missing"] if "Identity Mismatch" in str(m["field"])]
        self.assertTrue(mismatch)
        self.assertEqual(mismatch[0]["importance"], cc.SEVERITY_HIGH)
        self.assertIsNotNone(report["identity_block"])

    def test_matching_patient_name_is_not_flagged(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "patient_name", "value": "Ramesh Sharma"}]},
            expected_patient_name="Ramesh Sharma",
        )
        self.assertIsNone(report["identity_block"])

    def test_conflicting_sources_end_up_in_conflicts_and_missing(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "temperature", "value": "101 F", "source_quote": "fever"}]},
            per_source_facts=[
                {"field": "temperature", "value": "100 F", "source": "voice", "evidence": [cc.make_evidence("audio_timestamp", timestamp=12.5)]},
                {"field": "temperature", "value": "101 F", "source": "image", "evidence": [cc.make_evidence("image_region", region=[10, 20, 30, 40])]},
            ],
        )
        self.assertTrue(report["conflicts"])
        self.assertTrue(any(m["status"] == cc.STATUS_CONFLICT for m in report["missing"]))
        self.assertTrue(any(q["kind"] == "conflict" for q in report["clarification_questions"]))

    def test_missing_entry_for_a_documented_fact_is_dropped(self):
        report = cc.assemble_report(
            {
                "confirmed": [{"field": "blood_pressure", "value": "120/80"}],
                "missing": [{"field": "blood_pressure", "importance": "medium"}],
            }
        )
        self.assertEqual([m for m in report["missing"] if m["field"] == "blood_pressure"], [])

    def test_follow_ups_are_plain_strings(self):
        report = cc.assemble_report({"follow_ups": ["Review in 3 days", {"value": "Hydrate"}]})
        self.assertEqual(report["follow_ups"], ["Review in 3 days", "Hydrate"])

    def test_tolerates_broken_model_output(self):
        for bad in (None, {}, {"confirmed": "nope"}, {"confirmed": [None, 42], "missing": None}):
            report = cc.assemble_report(bad)
            self.assertEqual(cc.validate_report(report), [])

    def test_validate_catches_invalid_status(self):
        report = cc.assemble_report(self.payload())
        report["facts"][0]["status"] = "made_up"
        self.assertTrue(any("invalid status" in problem for problem in cc.validate_report(report)))

    def test_validate_catches_auto_resolved_conflict(self):
        report = cc.assemble_report(
            {"confirmed": [{"field": "temperature", "value": "101 F"}]},
            per_source_facts=[
                {"field": "temperature", "value": "100 F", "source": "voice"},
                {"field": "temperature", "value": "101 F", "source": "image"},
            ],
        )
        report["conflicts"][0]["fixed_value"] = "101 F"
        self.assertTrue(any("auto-resolved" in problem for problem in cc.validate_report(report)))

    def test_validate_requires_history_for_human_corrected_fact(self):
        report = cc.assemble_report(self.payload())
        report["facts"][0]["status"] = cc.STATUS_HUMAN_CORRECTED
        self.assertTrue(any("keeps no history" in problem for problem in cc.validate_report(report)))

    def test_validate_requires_both_values_on_conflict(self):
        report = cc.assemble_report(self.payload())
        report["conflicts"] = [{"field": "x", "options": []}]
        self.assertTrue(any("does not preserve both values" in problem for problem in cc.validate_report(report)))


class SourceAttributionTests(unittest.TestCase):
    """Facts must be attributable to the input they actually came from."""

    def make(self, field, quote):
        return cc.make_fact(field, "v", evidence=[cc.make_evidence("text_span", quote=quote)])

    def test_quote_found_in_voice_is_attributed_to_voice(self):
        facts = [self.make("temperature", "bukhar hai")]
        out = cc.attribute_sources(
            facts,
            [
                {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar hai teen din se"},
                {"kind": "text", "ref": "notes", "text": "fever 3 days"},
            ],
        )
        self.assertEqual(out[0]["source"], "voice")
        self.assertEqual(out[0]["source_ref"], "audio-1")

    def test_quote_found_in_typed_notes_is_attributed_to_text(self):
        facts = [self.make("temperature", "fever 3 days")]
        out = cc.attribute_sources(
            facts,
            [
                {"kind": "voice", "ref": "audio-1", "text": "some unrelated transcript"},
                {"kind": "text", "ref": "notes", "text": "patient reports fever 3 days"},
            ],
        )
        self.assertEqual(out[0]["source"], "text")

    def test_unmatched_quote_falls_back_to_default_source(self):
        facts = [self.make("temperature", "hallucinated phrase")]
        out = cc.attribute_sources(facts, [{"kind": "text", "ref": "notes", "text": "nothing here"}])
        self.assertEqual(out[0]["source"], "ai")

    def test_empty_source_text_is_ignored(self):
        facts = [self.make("temperature", "fever")]
        out = cc.attribute_sources(
            facts,
            [{"kind": "voice", "ref": "audio-1", "text": "   "}, {"kind": "text", "ref": "notes", "text": "fever"}],
        )
        self.assertEqual(out[0]["source"], "text")

    def test_attribution_enables_cross_source_conflict_detection(self):
        # Distinct values are what make this a genuine contradiction.
        facts = [
            cc.make_fact("temperature", "100 F", evidence=[cc.make_evidence("text_span", quote="bukhar 100")]),
            cc.make_fact("temperature", "101 F", evidence=[cc.make_evidence("text_span", quote="fever 101")]),
        ]
        attributed = cc.attribute_sources(
            facts,
            [
                {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar 100"},
                {"kind": "text", "ref": "notes", "text": "fever 101 recorded"},
            ],
        )
        self.assertEqual(attributed[0]["source"], "voice")
        self.assertEqual(attributed[1]["source"], "text")
        conflicts = cc.detect_conflicts(attributed)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["field"], "temperature")

    def test_same_value_from_two_sources_attributed_is_not_a_conflict(self):
        facts = [
            cc.make_fact("temperature", "101 F", evidence=[cc.make_evidence("text_span", quote="bukhar 101")]),
            cc.make_fact("temperature", "101.0 F", evidence=[cc.make_evidence("text_span", quote="fever 101.0")]),
        ]
        attributed = cc.attribute_sources(
            facts,
            [
                {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar 101"},
                {"kind": "text", "ref": "notes", "text": "fever 101.0 recorded"},
            ],
        )
        self.assertEqual(cc.detect_conflicts(attributed), [])

    def test_original_facts_are_not_mutated(self):
        facts = [self.make("temperature", "fever")]
        facts[0]["source"] = "ai"
        cc.attribute_sources(facts, [{"kind": "text", "ref": "notes", "text": "fever"}])
        self.assertEqual(facts[0]["source"], "ai")


class AssembleFromSourcesTests(unittest.TestCase):
    """End-to-end pipeline: model payload + capture sources -> clinical contract."""

    def payload(self):
        return {
            "summary": "Fever for three days with a mild cough.",
            "confirmed": [
                {"field": "temperature", "value": "101 F", "source_quote": "bukhar 101"},
                {"field": "diagnosis", "value": "Acute Febrile Illness", "source_quote": "fever three days"},
            ],
            "uncertain": [{"field": "drug_allergies", "value": "illegible"}],
            "missing": [{"field": "blood_pressure", "importance": "medium", "reason": "not recorded"}],
            "follow_ups": ["Review after 3 days"],
        }

    def sources(self):
        return [
            {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar 101 aur khansi"},
            {"kind": "text", "ref": "notes", "text": "fever three days, mild cough"},
        ]

    def test_produces_a_valid_report(self):
        report = cc.assemble_from_sources(self.payload(), sources=self.sources(), expected_patient_name="Ramesh Sharma")
        self.assertEqual(cc.validate_report(report), [])

    def test_each_fact_is_attributed_to_the_input_it_came_from(self):
        report = cc.assemble_from_sources(self.payload(), sources=self.sources())
        by_field = {f["field"]: f for f in report["facts"]}
        # The quote "bukhar 101" only appears in the voice transcript.
        self.assertEqual(by_field["temperature"]["source"], "voice")
        self.assertEqual(by_field["temperature"]["source_ref"], "audio-1")
        # The diagnosis quote only appears in the typed notes.
        self.assertEqual(by_field["diagnosis"]["source"], "text")

    def test_carries_legacy_keys_and_new_keys_together(self):
        report = cc.assemble_from_sources(self.payload(), sources=self.sources())
        for key in ("summary", "confirmed", "uncertain", "missing", "follow_ups"):
            self.assertIn(key, report)
        for key in ("facts", "conflicts", "clarification_questions", "sources"):
            self.assertIn(key, report)

    def test_detects_conflict_between_voice_and_typed_notes(self):
        payload = {
            "summary": "Fever.",
            "confirmed": [
                {"field": "temperature", "value": "100 F", "source_quote": "bukhar 100"},
                {"field": "temperature", "value": "101 F", "source_quote": "fever 101"},
            ],
        }
        report = cc.assemble_from_sources(
            payload,
            sources=[
                {"kind": "voice", "ref": "audio-1", "text": "patient bola bukhar 100"},
                {"kind": "text", "ref": "notes", "text": "fever 101 recorded"},
            ],
        )
        self.assertEqual(len(report["conflicts"]), 1)
        values = {opt["value"] for opt in report["conflicts"][0]["options"]}
        self.assertEqual(values, {"100 F", "101 F"})
        self.assertTrue(any(q["kind"] == "conflict" for q in report["clarification_questions"]))

    def test_conflict_is_marked_without_choosing_a_winner(self):
        report = cc.assemble_from_sources(
            {"confirmed": [
                {"field": "temperature", "value": "100 F", "source_quote": "bukhar 100"},
                {"field": "temperature", "value": "101 F", "source_quote": "fever 101"},
            ]},
            sources=[
                {"kind": "voice", "ref": "a", "text": "bukhar 100"},
                {"kind": "text", "ref": "b", "text": "fever 101"},
            ],
        )
        for conflict in report["conflicts"]:
            self.assertTrue(conflict["requires_resolution"])
            self.assertNotIn("fixed_value", conflict)

    def test_no_spurious_conflict_when_sources_agree(self):
        report = cc.assemble_from_sources(
            {"confirmed": [
                {"field": "temperature", "value": "101 F", "source_quote": "bukhar 101"},
                {"field": "temperature", "value": "101 F", "source_quote": "fever 101"},
            ]},
            sources=[
                {"kind": "voice", "ref": "a", "text": "bukhar 101"},
                {"kind": "text", "ref": "b", "text": "fever 101"},
            ],
        )
        self.assertEqual(report["conflicts"], [])

    def test_voice_transcript_argument_is_registered_as_a_source(self):
        report = cc.assemble_from_sources(
            {"confirmed": [{"field": "temperature", "value": "101 F", "source_quote": "bukhar 101"}]},
            voice_transcript="patient bola bukhar 101",
        )
        self.assertTrue(any(s["kind"] == "voice" for s in report["sources"]))
        self.assertEqual(report["facts"][0]["source"], "voice")

    def test_image_argument_is_registered_as_a_source(self):
        report = cc.assemble_from_sources({"confirmed": []}, image_ref="rx.jpg")
        self.assertTrue(any(s["kind"] == "image" and s["ref"] == "rx.jpg" for s in report["sources"]))

    def test_fabricated_claim_is_flagged_when_quote_is_absent_everywhere(self):
        report = cc.assemble_from_sources(
            {"confirmed": [{"field": "temperature", "value": "104 F", "source_quote": "never said this"}]},
            sources=[{"kind": "text", "ref": "notes", "text": "fever three days"}],
        )
        evidence = report["facts"][0]["evidence"]
        self.assertTrue(any(ev.get("label") == "unverified quote" for ev in evidence))

    def test_missing_expected_field_yields_prerequisite_question(self):
        report = cc.assemble_from_sources({}, sources=[{"kind": "text", "ref": "n", "text": "x"}])
        fields = {q["field"] for q in report["clarification_questions"]}
        self.assertIn("drug_allergies", fields)
        self.assertIn("diagnosis", fields)

    def test_broken_model_output_still_yields_a_valid_report(self):
        for bad in (None, {}, {"confirmed": "nope"}, {"confirmed": [None, 3, []], "missing": None}):
            report = cc.assemble_from_sources(bad, sources=self.sources())
            self.assertEqual(cc.validate_report(report), [])

    def test_dry_run_pipeline_is_valid_and_finds_conflict_free_data(self):
        report = cc.pipeline_dry_run()
        self.assertEqual(cc.validate_report(report), [])
        self.assertTrue(report["facts"])
        self.assertTrue(report["clarification_questions"])

    def test_identity_mismatch_survives_the_pipeline(self):
        report = cc.assemble_from_sources(
            {"confirmed": [{"field": "patient_name", "value": "Sunita Devi"}]},
            sources=self.sources(),
            expected_patient_name="Ramesh Sharma",
        )
        self.assertIsNotNone(report["identity_block"])
        self.assertTrue(any("Identity Mismatch" in str(m["field"]) for m in report["missing"]))

    def test_documented_fact_is_not_listed_as_missing(self):
        report = cc.assemble_from_sources(
            {
                "confirmed": [{"field": "blood_pressure", "value": "120/80"}],
                "missing": [{"field": "blood_pressure", "importance": "medium"}],
            },
            sources=self.sources(),
        )
        self.assertEqual([m for m in report["missing"] if cc.canonical_field(m.get("field")) == "blood_pressure"], [])


if __name__ == "__main__":
    unittest.main()
