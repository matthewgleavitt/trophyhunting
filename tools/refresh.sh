#!/usr/bin/env bash
# refresh.sh — one-shot data refresh: PSN sync → PowerPyx facts → commit → push.
# Needs tools/.env with NPSSO (see tools/README.md). Safe to run from launchd/cron.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
LOG="tools/.refresh.log"
{
  echo "=== refresh $(date -u +%FT%TZ) ==="
  node tools/psn-sync.mjs
  node tools/guide-enrich.mjs --limit 40 || true      # new games only (cached ones are skipped)
  node tools/build-slim.mjs                          # the artifact the web app loads
  node tools/stamp-assets.mjs                        # content-hash css/js so no stale cache ships
  if ! git diff --quiet -- data index.html; then
    git add data index.html
    git commit -q -m "data: sync $(date +%Y-%m-%d)"
    git push -q origin main && echo "pushed"
  else
    echo "no data changes"
  fi
} >> "$LOG" 2>&1
tail -3 "$LOG"
