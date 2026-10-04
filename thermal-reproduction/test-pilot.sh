#!/usr/bin/env bash
set -euo pipefail

workflow_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$workflow_dir"

pdf_tool="${PDFTOTEXT:-pdftotext}"
if ! command -v "$pdf_tool" >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo 'Install poppler-utils or set PDFTOTEXT to an existing pdftotext executable.' >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y poppler-utils
fi

if [ ! -d node_modules/@ironclad/rivet-node ]; then
  npm ci --no-audit --no-fund
fi

studio_url="${HOTSPOT_BASE_URL:-http://127.0.0.1:8000}"
if ! curl -fsS "$studio_url/api/status" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ready") else 1)'; then
  echo "HotSpot Studio is not ready at $studio_url. Start it in a separate terminal first." >&2
  exit 1
fi

npm test
HOTSPOT_BASE_URL="$studio_url" npm run pilot -- --mock-llm --allow-adapted

pilot_manifest="$(python3 - <<'PY'
from pathlib import Path
files = list(Path('pilot-output/W4206159291').glob('*/manifest.json'))
if not files:
    raise SystemExit('Pilot manifest was not created')
print(max(files, key=lambda item: item.stat().st_mtime))
PY
)"
python3 load_pilot.py --manifest "$pilot_manifest"
python3 - "$pilot_manifest" <<'PY'
import hashlib,json,sqlite3,sys
from pathlib import Path
manifest_path=Path(sys.argv[1])
manifest=json.loads(manifest_path.read_text())
assert manifest['assessment']['verdict']=='adapted_only'
assert manifest['feasibility']['scientific_gate_pass'] is False
assert manifest['adversarial']['approved'] is False
assert manifest['assessment']['comparison_valid'] is False
for name,meta in manifest['simulation']['artifacts'].items():
    data=(manifest_path.parent/name).read_bytes()
    assert len(data)==meta['bytes'] and hashlib.sha256(data).hexdigest()==meta['sha256']
db=sqlite3.connect('pilot-output/pilot.db')
row=db.execute("SELECT decision,latest_status,studio_run_id FROM app_paper_summary WHERE paper_id='W4206159291'").fetchone()
assert row==('adapted_only','completed',manifest['simulation']['studio_run_id'])
print('Verified app row:',row)
print('Pilot output:',manifest_path.parent)
print('Downloads:',manifest_path.parent/'gcc.steady',manifest_path.parent/'gcc.ttrace')
PY
