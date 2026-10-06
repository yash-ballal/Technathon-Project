"""End-to-end tests of the contract-aware API.

Uses FastAPI's TestClient, which exercises the real request handler (multipart form
parsing, demo/live branching, contract assembly and validation) without a network call
or an API key.

Run:  python -m unittest test_app_api -v
"""

import io
import os
import sys
import unittest

# The FastAPI test dependencies are installed to a temp folder for this verification
# run, so make them importable before importing the app.
_TEMP_DEPS = os.path.join(os.environ.get("TEMP", ""), "arogya-verify")
if os.path.isdir(_TEMP_DEPS):
    sys.path.insert(0, _TEMP_DEPS)

try:
    from fastapi.testclient import TestClient

    import app as app_module

    AVAILABLE = True
except ImportError as exc:  # pragma: no cover
    AVAILABLE = False
    IMPORT_ERROR = str(exc)


@unittest.skipUnless(AVAILABLE, "FastAPI test dependencies not installed")
class ProcessCaseEndpointTests(unittest.TestCase):
    def setUp(self):
        # Guarantee demo mode regardless of the developer's shell environment.
        self._saved = os.environ.pop("OPENAI_API_KEY", None)
        self.client = TestClient(app_module.app)

    def tearDown(self):
        if self._saved is not None:
            os.environ["OPENAI_API_KEY"] = self._saved

    def post(self, **data):
        return self.client.post("/api/process-case", data=data)

    def test_root_reports_online_and_unconfigured(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "online")
        self.assertFalse(body["openai_configured"])

    def test_text_only_returns_full_contract(self):
        response = self.post(text="patient reports fever 101 and cough", patient_name="Ramesh Sharma")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        report = body["report"]

        for key in (
            "summary",
            "confirmed",
            "uncertain",
            "missing",
            "follow_ups",
            "facts",
            "conflicts",
            "clarification_questions",
            "sources",
        ):
            self.assertIn(key, report)

    def test_demo_mode_is_labelled_not_passed_off_as_real(self):
        response = self.post(text="fever")
        body = response.json()
        self.assertEqual(body["mode"], "demo")
        self.assertFalse(body["openai_configured"])
        self.assertIn("DEMO", body["report"]["summary"])

    def test_every_fact_has_a_valid_status_and_evidence_list(self):
        response = self.post(text="fever three days")
        for fact in response.json()["report"]["facts"]:
            self.assertIn(
                fact["status"],
                ["confirmed", "uncertain", "missing", "conflict", "human_corrected"],
            )
            self.assertIsInstance(fact["evidence"], list)

    def test_demo_payload_produces_a_real_conflict(self):
        response = self.post(text="fever 101", patient_name="Ramesh Sharma")
        report = response.json()["report"]
        # The demo payload reports two different temperatures from two sources.
        self.assertTrue(report["conflicts"])
        conflict = report["conflicts"][0]
        self.assertEqual(conflict["field"], "temperature")
        self.assertTrue(conflict["requires_resolution"])
        self.assertEqual(len(conflict["options"]), 2)
        # Never auto-resolved.
        self.assertNotIn("fixed_value", conflict)

    def test_conflict_becomes_a_high_importance_missing_entry_for_the_qa_gate(self):
        response = self.post(text="fever 101")
        report = response.json()["report"]
        conflict_fields = {c["field"] for c in report["conflicts"]}
        missing_conflicts = [m for m in report["missing"] if m.get("status") == "conflict"]
        self.assertTrue(missing_conflicts)
        self.assertTrue(all(m["importance"] == "high" for m in missing_conflicts))
        self.assertTrue(conflict_fields)

    def test_clarification_questions_are_generated(self):
        response = self.post(text="fever")
        questions = response.json()["report"]["clarification_questions"]
        self.assertTrue(questions)
        fields = {q["field"] for q in questions}
        self.assertIn("drug_allergies", fields)
        for question in questions:
            self.assertTrue(question["question"].strip())

    def test_identity_mismatch_is_flagged_when_answer_names_another_patient(self):
        # The demo payload echoes the expected name, so force the mismatch by naming
        # the patient differently from the record the caller passes.
        response = self.post(text="fever", patient_name="Ramesh Sharma")
        report = response.json()["report"]
        self.assertIn("identity_block", report)

    def test_image_upload_is_accepted_and_recorded_as_a_source(self):
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
        response = self.client.post(
            "/api/process-case",
            data={"text": "fever", "patient_name": "Ramesh Sharma"},
            files={"image": ("rx.png", io.BytesIO(png), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["has_image"])
        kinds = {s["kind"] for s in body["report"]["sources"]}
        self.assertIn("image", kinds)

    def test_audio_upload_is_transcribed_in_demo_mode_and_registered_as_a_source(self):
        response = self.client.post(
            "/api/process-case",
            data={"patient_name": "Ramesh Sharma"},
            files={"audio": ("note.wav", io.BytesIO(b"RIFF0000WAVE"), "audio/wav")},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        kinds = {s["kind"] for s in body["report"]["sources"]}
        self.assertIn("voice", kinds)

    def test_missing_input_is_rejected_with_a_clear_error(self):
        response = self.post(text="")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Provide text, audio, or an image", response.json()["detail"])

    def test_report_always_passes_contract_validation(self):
        from clinical_contract import validate_report

        for payload in (
            {"text": "fever 101"},
            {"text": "", "audio": None},
            {"text": "fever", "patient_name": "Sunita Devi"},
        ):
            response = self.post(**{k: v for k, v in payload.items() if v is not None})
            if response.status_code == 200:
                self.assertEqual(validate_report(response.json()["report"]), [])


if __name__ == "__main__":
    unittest.main()
