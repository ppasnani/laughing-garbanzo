"""Freeze the manifest and collect completed custom 2D screening records."""

import argparse
import csv
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LABELS = ("candidate_2d_snapshot", "conditional_2d_snapshot",
          "illustrative_2d_only", "not_2d_applicable", "source_unavailable")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def page_count(path):
    try:
        output = subprocess.run(["pdfinfo", str(path)], check=True, capture_output=True,
                                text=True, timeout=30).stdout
        return int(next(line.split(":", 1)[1].strip() for line in output.splitlines()
                        if line.startswith("Pages:")))
    except FileNotFoundError:
        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise RuntimeError("Install Poppler/pdfinfo or pypdf to count PDF pages") from exc
        return len(PdfReader(str(path)).pages)


def latest_record(paper_id, pdf_hash, manifest_hash, rubric_hash, results_dir):
    candidates = []
    for path in (results_dir / paper_id).glob("*/manifest.json"):
        data = json.loads(path.read_text())
        if (data.get("run_type") == "custom" and data.get("pdf_sha256") == pdf_hash
                and data.get("manifest_sha256") == manifest_hash
                and data.get("rubric_sha256") == rubric_hash):
            candidates.append((data.get("generated_at", ""), data, path))
    if not candidates:
        return None
    _, result, path = max(candidates, key=lambda item: item[0])
    decision = result.get("feasibility", {}).get("decision")
    if decision not in LABELS:
        raise ValueError(f"Unexpected 2D label in {path}: {decision}")
    return result


def build(results_dir):
    manifest = ROOT / "chip_thermal_management_papers/download_manifest.csv"
    protocol = HERE / "2D_SNAPSHOT_SCREENING_PROTOCOL.md"
    raw = manifest.read_bytes()
    rows = list(csv.DictReader(raw.decode("utf-8-sig").splitlines()))
    records = []
    for row in rows:
        record = {key: row[key] for key in ("openalex_id", "title", "doi", "status",
                                             "filename", "source_url", "notes")}
        if row["status"] == "downloaded":
            pdf = ROOT / "chip_thermal_management_papers" / row["filename"]
            if pdf.name != row["filename"]:
                raise ValueError(f"Unsafe manifest path: {row['filename']}")
            data = pdf.read_bytes()
            if not data.startswith(b"%PDF"):
                raise ValueError(f"Invalid PDF: {pdf}")
            record.update(pdf_sha256=sha256(data), pdf_pages=page_count(pdf),
                          pdf_bytes=len(data))
            result = latest_record(row["openalex_id"], record["pdf_sha256"],
                                   sha256(raw), sha256(protocol.read_bytes()), results_dir)
            if result:
                feasibility = result["feasibility"]
                verified = feasibility.get("independently_verified", False)
                record.update(audit_status="screened" if verified else "pending_independent_review",
                              decision=feasibility["decision"] if verified else None,
                              provisional_decision=None if verified else feasibility["decision"],
                              scenario=result["extraction"].get("scenario"),
                              blocking_facts=feasibility.get("blocking_facts", []) +
                              ([] if verified else ["Independent verification pending"]),
                              independently_verified=verified,
                              evidence_sha256=feasibility.get("evidence_sha256"))
            else:
                record.update(audit_status="pending_audit", decision=None,
                              blocking_facts=["No source-complete 2D screening record"])
        elif row["status"] == "unavailable":
            record.update(audit_status="screened", decision="source_unavailable",
                          blocking_facts=[row["notes"] or "Readable full text unavailable"])
        else:
            raise ValueError(f"Unexpected manifest status: {row['status']}")
        records.append(record)
    if len({item["openalex_id"] for item in records}) != len(records):
        raise ValueError("Duplicate OpenAlex ID in manifest")
    counts = {label: sum(record["decision"] == label for record in records) for label in LABELS}
    pending = sum(record["decision"] is None for record in records)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "manifest_sha256": sha256(raw), "rubric_sha256": sha256(protocol.read_bytes()),
        "manifest_rows": len(records), "counts": counts, "pending_audit": pending,
        "counts_final": pending == 0,
        "records": records,
    }


def markdown(snapshot):
    lines = ["# Custom 2D snapshot screening inventory", "",
             f"Manifest SHA-256: `{snapshot['manifest_sha256']}`", "",
             f"Rubric SHA-256: `{snapshot['rubric_sha256']}`", "",
             f"Rows: {snapshot['manifest_rows']}. Pending source-complete audits: "
             f"{snapshot['pending_audit']}. Counts final: "
             f"{'yes' if snapshot['counts_final'] else 'no'}.", "",
             "The original EV6/GCC feasibility inventory is a separate screen. "
             "Pending rows are not confirmed or conditional 2D candidates.", "",
             "| Decision | Count |", "|---|---:|"]
    lines.extend(f"| `{label}` | {count} |" for label, count in snapshot["counts"].items())
    lines += ["", "## Named confirmed and conditional candidates", "",
              "| Paper | Decision | Blocking fact |", "|---|---|---|"]
    selected = [item for item in snapshot["records"] if item["decision"] in
                ("candidate_2d_snapshot", "conditional_2d_snapshot")]
    if selected:
        for item in selected:
            reason = "; ".join(item["blocking_facts"]).replace("|", "/")
            lines.append(f"| {item['openalex_id']}: {item['title'].replace('|', '/')} "
                         f"| `{item['decision']}` | {reason} |")
    else:
        lines.append("| None verified yet | — | Source-complete audits pending |")
    lines += ["", "## Per-paper status and blocking fact", "",
              "| OpenAlex ID | Status | Decision | Blocking fact |", "|---|---|---|---|"]
    for item in snapshot["records"]:
        reason = "; ".join(item["blocking_facts"]).replace("|", "/")
        lines.append(f"| {item['openalex_id']} | {item['audit_status']} "
                     f"| {item['decision'] or 'pending'} | {reason} |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", type=Path, default=HERE / "pilot-output")
    parser.add_argument("--json", type=Path, default=HERE / "screening_inventory.json")
    parser.add_argument("--markdown", type=Path, default=HERE / "screening_inventory.md")
    args = parser.parse_args()
    snapshot = build(args.results_dir)
    args.json.write_text(json.dumps(snapshot, indent=2) + "\n")
    args.markdown.write_text(markdown(snapshot))
    print(json.dumps({"rows": snapshot["manifest_rows"], "counts": snapshot["counts"],
                      "pending_audit": snapshot["pending_audit"],
                      "counts_final": snapshot["counts_final"]}))


if __name__ == "__main__":
    main()
