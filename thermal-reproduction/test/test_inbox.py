import io
import json
import tempfile
import unittest
import zipfile
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

    def input_folder(self):
        folder = self.output / "W1" / "2026-01-04-custom"
        folder.mkdir(parents=True)
        (folder / "manifest.json").write_text(json.dumps({"simulation": {"status": "skipped"}}))
        (folder / "input.flp").write_text("core0 0.005 0.005 0 0\n")
        (folder / "input.ptrace").write_text("core0\n8\n")
        sensitivity = folder / "sensitivity"
        sensitivity.mkdir()
        (sensitivity / "input.flp").write_text("sensitivity 0.001 0.001 0 0\n")
        (sensitivity / "input.ptrace").write_text("sensitivity\n99\n")
        return folder

    def request(self, method, path, payload=None, raw=None, content_type="application/json"):
        handler = object.__new__(inbox.Handler)
        handler.path = path
        body = raw if raw is not None else json.dumps(payload).encode()
        handler.headers = {"Content-Length": str(len(body)), "Content-Type": content_type}
        handler.rfile = io.BytesIO(body)
        responses = []
        handler.send_body = lambda *args: responses.append(args)
        getattr(handler, "do_" + method)()
        return responses[0]

    def test_download_contains_only_the_selected_papers_direct_inputs(self):
        folder = self.input_folder()
        detail = inbox.paper_detail("W1")
        self.assertEqual(detail["inputs"]["files"], ["input.flp", "input.ptrace"])
        status, body, content_type, headers = self.request("GET", detail["inputs"]["download_url"])
        self.assertEqual((status, content_type), (200, "application/zip"))
        self.assertIn('attachment; filename="W1-inputs.zip"', headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.namelist(), ["input.flp", "input.ptrace"])
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (folder / name).read_bytes())

    def test_missing_direct_inputs_never_fall_back_to_sensitivity_or_older_runs(self):
        folder = self.input_folder()
        (folder / "input.flp").unlink()
        (folder / "input.ptrace").unlink()
        old = folder.parent / "2026-01-01-old"
        old.mkdir()
        (old / "input.flp").write_text("old 0.001 0.001 0 0\n")
        inputs = inbox.paper_detail("W1")["inputs"]
        self.assertEqual(inputs, {"files": [], "download_url": None, "compare_url": None})
        status, *_ = self.request("GET", f"/api/papers/W1/inputs?attempt={folder.name}")
        self.assertEqual(status, 404)
        status, *_ = self.request("POST", f"/api/papers/W1/compare-floorplan?attempt={folder.name}",
                                  {"filename": "mine.flp", "content": "mine 0.001 0.001 0 0"})
        self.assertEqual(status, 404)

    def test_comparison_uses_paper_floorplan_and_does_not_save_the_upload(self):
        folder = self.input_folder()
        url = inbox.paper_detail("W1")["inputs"]["compare_url"]
        before = sorted(str(path) for path in folder.rglob("*"))
        status, body, _ = self.request("POST", url, {
            "filename": "my-layout.flp", "content": "core0 0.005 0.005 0.001 0\n"})
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(result["counts"], {"moved": 1})
        self.assertEqual(result["mode"], "overlay")
        self.assertEqual((result["base_blocks"], result["uploaded_blocks"]), (1, 1))
        self.assertIn("my-layout.flp", result["html"])
        self.assertIn("<svg", result["html"])
        self.assertNotIn("sensitivity", result["html"])
        self.assertEqual(before, sorted(str(path) for path in folder.rglob("*")))

    def test_comparison_retains_split_and_unrelated_layout_behavior(self):
        self.input_folder()
        url = inbox.paper_detail("W1")["inputs"]["compare_url"]
        status, body, _ = self.request("POST", url, {"filename": "split.flp", "content":
            "core0_0 0.0025 0.005 0 0\ncore0_1 0.0025 0.005 0.0025 0\n"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["counts"], {"split": 1})
        status, body, _ = self.request("POST", url, {"filename": "other.flp", "content":
            "other 0.001 0.001 0 0\n"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["mode"], "side-by-side")

    def test_invalid_uploads_return_actionable_errors(self):
        self.input_folder()
        url = inbox.paper_detail("W1")["inputs"]["compare_url"]
        cases = [
            ({"filename": "mine.txt", "content": ""}, ".flp extension"),
            ({"filename": "mine.flp", "content": "bad"}, "expected name"),
            ({"filename": "mine.flp", "content": "core 1 1 0 0\ncore 1 1 1 0"}, "duplicate block"),
            ({"filename": "mine.flp", "content": "core nan 1 0 0"}, "finite and positive"),
            ({"filename": "mine.flp", "content": ""}, "no floorplan blocks"),
            ({"filename": "mine.flp", "content": "x" * (inbox.MAX_FLOORPLAN_BYTES + 1)}, "at most 1 MiB"),
            ({"filename": "mine.flp", "content": "\n".join(f"core{i} 1 1 {i} 0" for i in range(1001))}, "at most 1000 blocks"),
        ]
        for payload, message in cases:
            with self.subTest(message=message):
                status, body, _ = self.request("POST", url, payload)
                self.assertEqual(status, 422)
                self.assertIn(message, json.loads(body)["error"])
        self.assertEqual(self.request("POST", url, raw=b"invalid json")[0], 422)
        self.assertEqual(self.request("POST", url, raw=b"x", content_type="text/plain")[0], 415)
        self.assertEqual(self.request("POST", url, raw=b"x" * (2 * inbox.MAX_FLOORPLAN_BYTES + 1))[0], 413)

    def test_a_newer_attempt_does_not_silently_change_the_comparison_or_download(self):
        folder = self.input_folder()
        urls = inbox.paper_detail("W1")["inputs"]
        (folder.parent / "2026-01-05-new").mkdir()
        self.assertEqual(self.request("GET", urls["download_url"])[0], 409)
        status, body, _ = self.request("POST", urls["compare_url"], {
            "filename": "mine.flp", "content": "core0 0.005 0.005 0 0"})
        self.assertEqual(status, 409)
        self.assertIn("Reload", json.loads(body)["error"])


if __name__ == "__main__":
    unittest.main()
