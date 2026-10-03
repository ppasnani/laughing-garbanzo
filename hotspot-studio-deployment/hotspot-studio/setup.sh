#!/usr/bin/env bash
set -euo pipefail
studio_dir="$(cd "$(dirname "$0")" && pwd)"
hotspot_dir="${HOTSPOT_ROOT:-$studio_dir/../HotSpot}"
if [ ! -f "$hotspot_dir/Makefile" ]; then
  echo 'Set HOTSPOT_ROOT to the HotSpot source directory.' >&2
  exit 1
fi
make -C "$hotspot_dir" clean
make -C "$hotspot_dir" SUPERLU=0
printf '\nStart Studio: python3 "%s/server.py" --host 0.0.0.0 --port 8000\n' "$studio_dir"
