#!/usr/bin/env python3
"""Local inbox for the paper pilot results. Python standard library only."""

import argparse
import csv
import importlib.util
import json
import mimetypes
import re
import subprocess
import urllib.error
import urllib.request
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

spec = importlib.util.spec_from_file_location("visualize_run", OUTPUT / "visualize_run.py")
visualize_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visualize_run)


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
              "results": None, "limitations": []}
    attempt = latest_attempt(paper_id)
    if not attempt:
        detail["status"] = "source_unavailable" if row["status"] == "unavailable" else "waiting"
        return detail
    folder, state, data = attempt
    detail["attempt"] = folder.name
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
    def send_body(self, status, body, content_type):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/papers":
            return self.send_body(200, json.dumps(paper_list()), "application/json; charset=utf-8")
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
