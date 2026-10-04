#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")" || exit 1
manifest="../chip_thermal_management_papers/download_manifest.csv"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo 'Set ANTHROPIC_API_KEY before running the batch.' >&2
  exit 1
fi

paper_ids="$(python3 - "$manifest" <<'PY'
import csv
import sys

with open(sys.argv[1], newline='', encoding='utf-8-sig') as source:
    for row in csv.DictReader(source):
        if row['status'] == 'downloaded':
            print(row['openalex_id'])
        elif row['status'] == 'unavailable':
            print(f"Skipping {row['openalex_id']}: no local PDF", file=sys.stderr)
        else:
            raise SystemExit(f"Unexpected status for {row['openalex_id']}: {row['status']}")
PY
)" || exit 1

if [[ -z "$paper_ids" ]]; then
  echo 'No downloaded papers found in the manifest.' >&2
  exit 1
fi

failed=0
while IFS= read -r paper_id; do
  echo "Running paper $paper_id"
  if ! npm run pilot -- --run-type custom --paper-id "$paper_id"; then
    echo "Failed: $paper_id" >&2
    failed=$((failed + 1))
  fi
done <<< "$paper_ids"

echo "Batch finished: $failed paper(s) failed. Results are in pilot-output/<paper-id>/<attempt>/."
if (( failed > 0 )); then exit 1; fi
