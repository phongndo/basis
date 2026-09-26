#!/usr/bin/env bash
# Type-check every workspace package that defines a check script.
set -euo pipefail
cd "$(dirname "$0")/.."
for dir in packages/* plugins/* apps/*; do
  [ -f "$dir/package.json" ] || continue
  grep -q '"check"' "$dir/package.json" || continue
  echo "== $dir"
  bun run --cwd "$dir" check
done
