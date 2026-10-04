import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import inbox_server as inbox


class PaperInboxTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.output = self.root / "pilot-output"
        self.output.mkdir()
        self.manifest = self.root / "download_manifest.csv"
        self.manifest.write_text(
            "publication_date,openalex_id,cited_by_count,title,doi,status,filename,source_url,bytes,notes\n"
            "2026-01-02,W1,7,One paper,https://doi.org/10.1/one,downloaded,one.pdf,https://example.org/one.pdf,10,\n"
            "2025-01-02,W2,0,Missing paper,https://doi.org/10.1/two,unavailable,,,,No public PDF\n")
        self.output_patch = patch.object(inbox, "OUTPUT", self.output)
        self.manifest_patch = patch.object(inbox, "MANIFEST", self.manifest)
        self.authors_patch = patch.object(inbox, "authors", return_value=("A. Researcher", "OpenAlex"))
        self.output_patch.start()
        self.manifest_patch.start()
        self.authors_patch.start()

    def tearDown(self):
        self.authors_patch.stop()
        self.manifest_patch.stop()
        self.output_patch.stop()
        self.temp.cleanup()

    def test_latest_failed_attempt_replaces_older_result(self):
        old = self.output / "W1" / "2026-01-01-old"
        old.mkdir(parents=True)
        (old / "manifest.json").write_text(json.dumps({
            "simulation": {"status": "completed"},
            "assessment": {"verdict": "candidate_2d_snapshot"}}))
        newest = self.output / "W1" / "2026-01-03-new"
        newest.mkdir()
        (newest / "stage-error.json").write_text(json.dumps({
            "stage": "extractPaper", "message": "PDF extraction failed"}))
        listing = inbox.paper_list()
        self.assertEqual(len(listing), 2)
        self.assertEqual(listing[0]["status"], "failed")
        self.assertEqual(listing[1]["status"], "source_unavailable")
        detail = inbox.paper_detail("W1")
        self.assertEqual(detail["status"], "failed")
        self.assertIsNone(detail["assessment"])
        self.assertEqual(detail["error"]["stage"], "extractPaper")
        (newest / "stage-error.json").unlink()
        processing = inbox.paper_detail("W1")
        self.assertEqual(processing["status"], "processing")
        self.assertIsNone(processing["assessment"])

    def test_custom_run_uses_floorplan_power_and_steady_files(self):
        folder = self.output / "W1" / "2026-01-04-custom"
        folder.mkdir(parents=True)
        (folder / "input.flp").write_text("core0 0.005 0.005 0 0\n")
        (folder / "input.ptrace").write_text("core0\n8\n")
        (folder / "temperatures.steady").write_text("core0 345\n")
        (folder / "manifest.json").write_text(json.dumps({
            "paper_id": "W1", "paper_title": "One paper", "run_type": "custom",
            "assessment": {"verdict": "conditional_2d_snapshot", "summary": "A useful proxy.",
                           "limitations": ["Boundary differs"]},
            "feasibility": {"decision": "conditional_2d_snapshot"},
            "simulation": {"status": "completed", "rows": [
                {"name": "core0", "kelvin": 345, "celsius": 71.85}]}}))
        detail = inbox.paper_detail("W1")
        self.assertEqual(detail["author"], "A. Researcher")
        self.assertEqual(detail["citations"], 7)
        self.assertEqual(detail["limitations"], ["Boundary differs"])
        self.assertEqual(detail["results"]["rows"][0]["power_w"], 8)
        self.assertIn("core0", inbox.visualization("W1"))
        self.assertIsNone(inbox.paper_detail("W999"))


if __name__ == "__main__":
    unittest.main()
