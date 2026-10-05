#!/usr/bin/env python3
"""Local inbox for the paper pilot results. Python standard library only."""

import argparse
import csv
import importlib.util
import io
import json
import mimetypes
import re
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from collections import Counter
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

HERE = Path(__file__).resolve().parent
MANIFEST = HERE.parent / "chip_thermal_management_papers" / "download_manifest.csv"
OUTPUT = HERE / "pilot-output"
STATIC = HERE / "inbox" / "dist"
EV6_FLOORPLAN = HERE.parent / "HotSpot" / "examples" / "example1" / "ev6.flp"
PAPER_ID = re.compile(r"W\d+\Z")
INPUT_FILES = ("input.flp", "input.ptrace")
MAX_FLOORPLAN_BYTES = 1024 * 1024
MAX_FLOORPLAN_BLOCKS = 1000

spec = importlib.util.spec_from_file_location("visualize_run", OUTPUT / "visualize_run.py")
visualize_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visualize_run)

spec = importlib.util.spec_from_file_location("compare_floorplans", OUTPUT / "compare_floorplans.py")
compare_floorplans = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = compare_floorplans
spec.loader.exec_module(compare_floorplans)


class InputUnavailable(ValueError):
    pass


class AttemptChanged(ValueError):
    pass


def paper_input_folder(paper_id, attempt_name=None):
    if paper_id not in papers():
        raise InputUnavailable("Paper not found.")
    attempt = latest_attempt(paper_id)
    if not attempt:
        raise InputUnavailable("This paper has no saved inputs yet.")
    folder = attempt[0]
    if attempt_name != folder.name:
        raise AttemptChanged("A newer attempt is available. Reload the page to use its inputs.")
    return folder


def input_file(folder, name):
    # Use only files directly in the selected run, never its sensitivity directory.
    path = folder / name
    return path if name in INPUT_FILES and path.is_file() and not path.is_symlink() else None


def input_metadata(paper_id, folder):
    files = [name for name in INPUT_FILES if input_file(folder, name)]
    query = "?attempt=" + quote(folder.name, safe="")
    return {"files": files,
            "download_url": f"/api/papers/{paper_id}/inputs{query}" if files else None,
            "compare_url": f"/api/papers/{paper_id}/compare-floorplan{query}"
            if "input.flp" in files else None}


def download_inputs(paper_id, attempt_name):
    folder = paper_input_folder(paper_id, attempt_name)
    paths = [path for name in INPUT_FILES if (path := input_file(folder, name))]
    if not paths:
        raise InputUnavailable("This attempt has no saved input.flp or input.ptrace.")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in paths:
            archive.writestr(path.name, path.read_bytes())
    return buffer.getvalue()


def compare_uploaded_floorplan(paper_id, attempt_name, payload):
    folder = paper_input_folder(paper_id, attempt_name)
    base_path = input_file(folder, "input.flp")
    if not base_path:
        raise InputUnavailable("This attempt has no saved input.flp to compare.")
    if not isinstance(payload, dict):
        raise ValueError("Choose a .flp file to compare.")
    filename, content = payload.get("filename"), payload.get("content")
    if not isinstance(filename, str) or not filename.lower().endswith(".flp"):
        raise ValueError("Choose a floorplan file with the .flp extension.")
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FLOORPLAN_BYTES:
        raise ValueError("The uploaded floorplan must be at most 1 MiB.")
    if base_path.stat().st_size > MAX_FLOORPLAN_BYTES:
        raise ValueError("The paper floorplan is too large to compare (maximum 1 MiB).")
    # Parse in memory; the uploaded filename is a display label, never a disk path.
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1][:200]
    base = compare_floorplans.parse_floorplan(base_path.read_text(encoding="utf-8"), "input.flp")
    uploaded = compare_floorplans.parse_floorplan(content, filename)
    if max(len(base), len(uploaded)) > MAX_FLOORPLAN_BLOCKS:
        raise ValueError("Floorplans must contain at most 1000 blocks to compare.")
    changes, mode = compare_floorplans.compare(base, uploaded)
    return {"mode": mode, "counts": dict(Counter(change["kind"] for change in changes)),
            "base_blocks": len(base), "uploaded_blocks": len(uploaded),
            "html": compare_floorplans.render(base, uploaded, changes, mode,
                                              Path("input.flp"), Path(filename), color_scheme="light")}


def papers():
    with MANIFEST.open(newline="", encoding="utf-8-sig") as source:
        return {row["openalex_id"]: row for row in csv.DictReader(source)}


@lru_cache(maxsize=128)
def read_manifest(path, modified_ns, size):
    return json.loads(Path(path).read_text())


def latest_attempt(paper_id):
    root = OUTPUT / paper_id
    if not PAPER_ID.fullmatch(paper_id) or not root.is_dir():
        return None
    folders = [item for item in root.iterdir() if item.is_dir()]
    if not folders:
        return None
    folder = max(folders, key=lambda item: item.name)
    manifest = folder / "manifest.json"
    if manifest.is_file():
        try:
            stat = manifest.stat()
            return folder, "completed", read_manifest(str(manifest), stat.st_mtime_ns, stat.st_size)
        except (OSError, json.JSONDecodeError):
            return folder, "processing", None
    error = folder / "stage-error.json"
    if error.is_file():
        try:
            return folder, "failed", json.loads(error.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    return folder, "processing", None


def paper_state(row):
    attempt = latest_attempt(row["openalex_id"])
    if attempt:
        _, state, data = attempt
        if state == "completed":
            return {"status": data.get("simulation", {}).get("status", "assessed"),
                    "verdict": data.get("assessment", {}).get("verdict"),
                    "updated_at": data.get("generated_at")}
        return {"status": state, "verdict": None, "updated_at": None}
    return {"status": "source_unavailable" if row["status"] == "unavailable" else "waiting",
            "verdict": None, "updated_at": None}


def paper_list():
    result = []
    for row in papers().values():
        result.append({"id": row["openalex_id"], "date": row["publication_date"],
                       "title": row["title"], "citations": int(row["cited_by_count"] or 0),
                       **paper_state(row)})
    return sorted(result, key=lambda item: (item["date"], item["id"]), reverse=True)


@lru_cache(maxsize=128)
def authors(row_id, filename, doi):
    # OpenAlex has the authorship record; PDF metadata is an offline fallback.
    try:
        request = urllib.request.Request(
            f"https://api.openalex.org/works/{row_id}",
            headers={"User-Agent": "thermal-paper-inbox/1.0"})
        with urllib.request.urlopen(request, timeout=3) as response:
            work = json.load(response)
        names = [entry.get("author", {}).get("display_name", "").strip()
                 for entry in work.get("authorships", [])]
        names = [name for name in names if name]
        if names:
            return ", ".join(names), "OpenAlex"
    except (OSError, ValueError, urllib.error.URLError):
        pass
    if doi:
        try:
            identifier = doi.removeprefix("https://doi.org/")
            request = urllib.request.Request(
                "https://api.crossref.org/works/" + quote(identifier, safe=""),
                headers={"User-Agent": "thermal-paper-inbox/1.0"})
            with urllib.request.urlopen(request, timeout=3) as response:
                work = json.load(response)["message"]
            names = [" ".join(part for part in (item.get("given"), item.get("family")) if part)
                     for item in work.get("author", [])]
            names = [name for name in names if name]
            if names:
                return ", ".join(names), "Crossref"
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            pass
    if filename:
        pdf = MANIFEST.parent / filename
        if pdf.is_file() and pdf.name == filename:
            try:
                info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True,
                                      text=True, timeout=5, check=True).stdout
                match = re.search(r"^Author:\s*(.+)$", info, re.MULTILINE)
                value = match.group(1).strip() if match else ""
                if value and len(value) < 180 and value.lower() not in {
                        "ieee", "ijece", "firstname lastname, firstname lastname and firstname lastname"}:
                    return value, "PDF metadata"
            except (OSError, subprocess.SubprocessError):
                pass
    return None, None


def power_trace(folder):
    path = folder / "input.ptrace"
    if not path.is_file():
        return {}
    try:
        lines = [line.split("#", 1)[0].split() for line in path.read_text().splitlines()]
        lines = [parts for parts in lines if parts]
        if len(lines) != 2 or len(lines[0]) != len(lines[1]):
            return {}
        return {name: float(value) for name, value in zip(*lines)}
    except (OSError, ValueError):
        return {}


def paper_detail(paper_id):
    row = papers().get(paper_id)
    if row is None:
        return None
    author, author_source = authors(paper_id, row["filename"], row["doi"])
    detail = {"id": paper_id, "date": row["publication_date"], "title": row["title"],
              "author": author, "author_source": author_source,
              "citations": int(row["cited_by_count"] or 0),
              "paper_url": row["source_url"] or row["doi"] or f"https://openalex.org/{paper_id}",
              "source_status": row["status"], "source_note": row["notes"],
              "status": "waiting", "assessment": None, "feasibility": None,
              "results": None, "limitations": [], "inputs": {"files": []}}
    attempt = latest_attempt(paper_id)
    if not attempt:
        detail["status"] = "source_unavailable" if row["status"] == "unavailable" else "waiting"
        return detail
    folder, state, data = attempt
    detail["attempt"] = folder.name
    detail["inputs"] = input_metadata(paper_id, folder)
    if state == "failed":
        detail["status"] = "failed"
        detail["error"] = {"stage": data.get("stage"), "message": data.get("message")}
        return detail
    if state == "processing":
        detail["status"] = "processing"
        return detail
    assessment = data.get("assessment", {})
    feasibility = data.get("feasibility", {})
    simulation = data.get("simulation", {})
    detail["status"] = simulation.get("status", "assessed")
    detail["assessment"] = {"verdict": assessment.get("verdict"),
                            "summary": assessment.get("summary"),
                            "comparison_valid": assessment.get("comparison_valid")}
    detail["feasibility"] = {"decision": feasibility.get("decision"),
                             "reason": feasibility.get("reason"),
                             "input_gate_pass": feasibility.get("input_gate_pass"),
                             "scientific_gate_pass": feasibility.get("scientific_gate_pass")}
    limitations = assessment.get("limitations") or feasibility.get("blocking_facts") or []
    detail["limitations"] = [str(item) for item in limitations]
    rows = simulation.get("rows") or []
    powers = power_trace(folder)
    detail["results"] = {"status": simulation.get("status"),
                         "reason": simulation.get("reason"),
                         "studio_run_id": simulation.get("studio_run_id"),
                         "run_kind": simulation.get("run_kind") or data.get("run_type"),
                         "rows": [{"name": item.get("name"), "kelvin": item.get("kelvin"),
                                   "celsius": item.get("celsius"),
                                   "power_w": powers.get(item.get("name"))} for item in rows],
                         "power_trace_present": bool(powers),
                         "thermal_trace_present": (folder / "gcc.ttrace").is_file(),
                         "visualization_url": f"/api/papers/{paper_id}/visualization?attempt={folder.name}"
                         if simulation.get("status") == "completed" else None}
    return detail


def visualization(paper_id, attempt_name=None):
    attempt = latest_attempt(paper_id)
    if not attempt or attempt[1] != "completed":
        return None
    folder, _, data = attempt
    if attempt_name and attempt_name != folder.name:
        return None
    if data.get("simulation", {}).get("status") != "completed":
        return None
    floorplan = folder / "input.flp"
    steady = folder / "temperatures.steady"
    trace = None
    if not floorplan.is_file():
        floorplan = EV6_FLOORPLAN
        steady = folder / "gcc.steady"
        trace = folder / "gcc.ttrace"
    if not floorplan.is_file() or not steady.is_file():
        return None
    units = visualize_run.read_floorplan(floorplan)
    names = {unit["name"] for unit in units}
    steady_values = visualize_run.read_steady(steady, names)
    trace_values = visualize_run.read_trace(trace, names) if trace and trace.is_file() else []
    return visualize_run.render_html({"units": units, "steady": steady_values,
                                      "trace": trace_values},
                                     f"{data.get('paper_title', paper_id)} · thermal result")


class Handler(BaseHTTPRequestHandler):
    def send_body(self, status, body, content_type, headers=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/papers":
            return self.send_body(200, json.dumps(paper_list()), "application/json; charset=utf-8")
        match = re.fullmatch(r"/api/papers/(W\d+)/inputs", path)
        if match:
            try:
                data = download_inputs(match.group(1), parse_qs(parsed.query).get("attempt", [None])[0])
            except (InputUnavailable, AttemptChanged, OSError) as error:
                status = 409 if isinstance(error, AttemptChanged) else 404
                return self.send_body(status, str(error), "text/plain; charset=utf-8")
            return self.send_body(200, data, "application/zip", {
                "Content-Disposition": f'attachment; filename="{match.group(1)}-inputs.zip"'})
        match = re.fullmatch(r"/api/papers/(W\d+)(/visualization)?", path)
        if match:
            paper_id = match.group(1)
            if match.group(2):
                try:
                    page = visualization(paper_id, parse_qs(parsed.query).get("attempt", [None])[0])
                except (OSError, ValueError) as error:
                    return self.send_body(422, str(error), "text/plain; charset=utf-8")
                return self.send_body(200, page, "text/html; charset=utf-8") if page else self.send_body(
                    404, "Visualization not available", "text/plain; charset=utf-8")
            detail = paper_detail(paper_id)
            return self.send_body(200, json.dumps(detail), "application/json; charset=utf-8") if detail else self.send_body(
                404, "Paper not found", "text/plain; charset=utf-8")
        if path == "/" or re.fullmatch(r"/assets/[A-Za-z0-9_.-]+", path):
            file = STATIC / ("index.html" if path == "/" else path.lstrip("/"))
            if file.is_file():
                content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
                return self.send_body(200, file.read_bytes(), content_type)
        self.send_body(404, "Not found", "text/plain; charset=utf-8")

    def do_POST(self):
        parsed = urlparse(self.path)
        match = re.fullmatch(r"/api/papers/(W\d+)/compare-floorplan", parsed.path)
        if not match:
            return self.send_body(404, "Not found", "text/plain; charset=utf-8")
        try:
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                return self.send_body(415, json.dumps({"error": "Send a .flp file as JSON."}),
                                      "application/json; charset=utf-8")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * MAX_FLOORPLAN_BYTES:
                return self.send_body(413, json.dumps({"error": "The uploaded floorplan is too large."}),
                                      "application/json; charset=utf-8")
            payload = json.loads(self.rfile.read(length))
            result = compare_uploaded_floorplan(
                match.group(1), parse_qs(parsed.query).get("attempt", [None])[0], payload)
        except (OSError, ValueError) as error:
            status = 409 if isinstance(error, AttemptChanged) else 404 if isinstance(error, InputUnavailable) else 422
            return self.send_body(status, json.dumps({"error": str(error)}), "application/json; charset=utf-8")
        return self.send_body(200, json.dumps(result), "application/json; charset=utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print(f"Paper inbox: http://{args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
