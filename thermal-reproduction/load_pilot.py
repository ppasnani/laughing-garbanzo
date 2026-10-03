"""Load the feasibility screen and one pilot result into an app-readable SQLite DB."""

import argparse
import csv
import hashlib
import json
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_inventory(conn):
    with (HERE / "feasibility_inventory.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    for row in rows:
        source_status = "downloaded" if row["pdf_filename"] else "unavailable"
        pdf_path = ROOT / "chip_thermal_management_papers" / row["pdf_filename"] if row["pdf_filename"] else None
        pdf_hash = digest(pdf_path.read_bytes()) if pdf_path else None
        conn.execute("""INSERT INTO paper(id,title,doi,pdf_path,pdf_sha256,source_status)
            VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            title=excluded.title, doi=excluded.doi, pdf_path=excluded.pdf_path,
            pdf_sha256=excluded.pdf_sha256, source_status=excluded.source_status""",
            (row["openalex_id"], row["title"], row["doi"],
             str(pdf_path.relative_to(ROOT)) if pdf_path else None, pdf_hash, source_status))
        decision = "adapted_only" if row["decision"] == "adapted_pilot_only" else row["decision"]
        experiment_id = f'{row["openalex_id"]}:screen'
        conn.execute("""INSERT INTO experiment(id,paper_id,label,decision,required_capabilities_json,feasibility_reason)
            VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            decision=excluded.decision, required_capabilities_json=excluded.required_capabilities_json,
            feasibility_reason=excluded.feasibility_reason""",
            (experiment_id, row["openalex_id"], "Current Studio feasibility screen", decision,
             json.dumps([row["required_for_faithful_replication"]]), row["reason"]))
        if row["pdf_pages"]:
            conn.execute("DELETE FROM evidence WHERE experiment_id=? AND field_name='feasibility_screen'", (experiment_id,))
            for page in row["pdf_pages"].split(","):
                conn.execute("""INSERT INTO evidence(experiment_id,field_name,value_json,pdf_page,source_kind,note)
                    VALUES(?,?,?,?,?,?)""", (experiment_id, "feasibility_screen",
                    json.dumps({"finding": row["evidence"]}), int(page), "paper", "Page-indexed feasibility screen"))
    return len(rows)


def load_pilot(conn, manifest_file):
    manifest_file = manifest_file.resolve()
    manifest = json.loads(manifest_file.read_text())
    folder = manifest_file.parent
    paper_id = manifest["paper_id"]
    simulation = manifest["simulation"]
    run_id = simulation["studio_run_id"]
    workflow_id = f"pilot:{run_id}"
    key = digest(f'{manifest["pdf_sha256"]}:{manifest["graph_sha256"]}:{run_id}'.encode())
    code_version = digest((HERE / "pilot.mjs").read_bytes())
    conn.execute("""INSERT INTO workflow_run(
        id,experiment_id,idempotency_key,status,graph_sha256,code_version,finished_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING""",
        (workflow_id, f"{paper_id}:screen", key, "completed", manifest["graph_sha256"],
         code_version, manifest["generated_at"]))
    config = (folder / "submitted.config").read_text()
    studio_result = json.loads((folder / "studio-result.json").read_text())
    conn.execute("""INSERT INTO simulation(
        id,workflow_run_id,studio_run_id,backend_version,config_text,config_sha256,
        status,temperatures_json,solver_log,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING""",
        (f"studio:{run_id}", workflow_id, run_id, "HotSpot Studio EV6/GCC source",
         config, simulation["config_sha256"], simulation["status"],
         json.dumps(simulation["rows"]), studio_result.get("log", ""), manifest["generated_at"]))
    paths = {"gcc.steady": folder / "gcc.steady", "gcc.ttrace": folder / "gcc.ttrace",
             "config": folder / "submitted.config", "result_json": folder / "studio-result.json"}
    for kind, path in paths.items():
        data = path.read_bytes()
        if not data:
            raise ValueError(f"Empty artifact: {path}")
        if kind in simulation["artifacts"]:
            expected = simulation["artifacts"][kind]
            if expected["sha256"] != digest(data) or expected["bytes"] != len(data):
                raise ValueError(f"Artifact integrity mismatch: {path}")
        conn.execute("""INSERT INTO artifact(simulation_id,kind,storage_path,sha256,byte_count)
            VALUES(?,?,?,?,?) ON CONFLICT(simulation_id,kind) DO UPDATE SET
            storage_path=excluded.storage_path, sha256=excluded.sha256, byte_count=excluded.byte_count""",
            (f"studio:{run_id}", kind, str(path.relative_to(HERE)), digest(data), len(data)))
    conn.execute("""INSERT INTO comparison(workflow_run_id,metric,comparison_valid,explanation)
        SELECT ?, 'paper temperature comparison', 0, ?
        WHERE NOT EXISTS(SELECT 1 FROM comparison WHERE workflow_run_id=? AND metric='paper temperature comparison')""",
        (workflow_id, manifest["feasibility"]["reason"], workflow_id))
    return run_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=HERE / "pilot-output/pilot.db")
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    args.db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript((HERE / "schema.sql").read_text())
    with conn:
        count = load_inventory(conn)
        run_id = load_pilot(conn, args.manifest) if args.manifest else None
    summary = conn.execute("SELECT COUNT(*),SUM(source_status='downloaded') FROM paper").fetchone()
    print(json.dumps({"database": str(args.db), "papers": summary[0], "downloaded": summary[1],
                      "pilot_studio_run_id": run_id}))
    conn.close()


if __name__ == "__main__":
    main()
