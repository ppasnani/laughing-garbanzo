#!/usr/bin/env bash
set -euo pipefail
studio_dir="$(cd "$(dirname "$0")" && pwd)"
if ! command -v make >/dev/null || ! command -v gcc >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y build-essential python3
fi
bash "$studio_dir/setup.sh"
exec python3 "$studio_dir/server.py" --host 0.0.0.0 --port "${PORT:-8000}"
