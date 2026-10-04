import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from load_pilot import HERE, load_2d_screening


def digest(data):
    return hashlib.sha256(data).hexdigest()


class CustomImportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=HERE / "pilot-output")
        self.folder = Path(self.temp.name)
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript((HERE / "schema.sql").read_text())
        self.conn.execute("""INSERT INTO paper(id,title,source_status)
            VALUES('W123','Test paper','downloaded')""")

    def tearDown(self):
        self.conn.close()
        self.temp.cleanup()

    def manifest(self, status="completed"):
        artifacts = {}
        if status != "skipped":
            for name, contents in {
                "submitted.experiment.json": b'{"kind":"custom_2d_steady"}\n',
                "input.flp": b"core0 0.005 0.005 0 0\n",
                "input.ptrace": b"core0\n8\n",
                "temperatures.steady": b"core0 345\n",
            }.items():
                (self.folder / name).write_bytes(contents)
                artifacts[name] = {"sha256": digest(contents), "bytes": len(contents)}
            (self.folder / "studio-result.json").write_text('{"status":"completed"}\n')
            (self.folder / "solver.log").write_text("solver ok\n")
        (self.folder / "submitted.config").write_text("-model_type block\n")
        value = {
            "paper_id": "W123", "paper_title": "Test paper", "run_type": "custom",
            "pdf_sha256": "pdfhash", "manifest_sha256": "manifesthash",
            "graph_sha256": "graphhash", "generated_at": "2026-10-03T12:00:00Z",
            "extraction": {"scenario": {"description": "steady"}},
            "adversarial": {"approved": True},
            "independent_review": {"reviewer": "second reader"},
            "feasibility": {"decision": "candidate_2d_snapshot",
                            "simulation_allowed": True,
                            "input_gate_pass": True,
                            "independently_verified": True,
                            "evidence_sha256": "evidencehash"},
            "simulation": {"status": status, "studio_run_id": "a" * 32 if status != "skipped" else None,
                           "input_sha256": "inputhash" if status != "skipped" else None,
                           "artifacts": artifacts},
            "assessment": {"verdict": "candidate_2d_snapshot"},
        }
        path = self.folder / "manifest.json"
        path.write_text(json.dumps(value))
        return path

    def test_imports_custom_artifacts_and_view(self):
        manifest = self.manifest()
        run_id = load_2d_screening(self.conn, manifest)
        self.assertEqual(run_id, "a" * 32)
        row = self.conn.execute("""SELECT decision,status,independently_verified,input_sha256
            FROM app_2d_screening_summary WHERE paper_id='W123'""").fetchone()
        self.assertEqual(row, ("candidate_2d_snapshot", "completed", 1, "inputhash"))
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM snapshot_screening_artifact").fetchone()[0], 7)

    def test_rejects_tampered_artifact(self):
        manifest = self.manifest()
        (self.folder / "input.ptrace").write_text("core0\n9\n")
        with self.assertRaisesRegex(ValueError, "integrity mismatch"):
            load_2d_screening(self.conn, manifest)

    def test_caveated_verdict_can_be_imported(self):
        manifest = self.manifest()
        value = json.loads(manifest.read_text())
        value["feasibility"]["decision"] = "illustrative_2d_only"
        value["assessment"]["verdict"] = "illustrative_2d_only"
        manifest.write_text(json.dumps(value))
        load_2d_screening(self.conn, manifest)

    def test_unsuitable_verdict_cannot_be_imported_as_simulated(self):
        manifest = self.manifest()
        value = json.loads(manifest.read_text())
        value["feasibility"]["decision"] = "not_2d_applicable"
        value["assessment"]["verdict"] = "not_2d_applicable"
        manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "bypassed the screening gate"):
            load_2d_screening(self.conn, manifest)


if __name__ == "__main__":
    unittest.main()
