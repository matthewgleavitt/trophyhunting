#!/usr/bin/env bash
# refresh.sh — the whole pipeline, unattended. This is the ONLY thing that should ever
# need to run, and launchd runs it; you should not be typing commands to play a game.
#
#   PSN sync -> fetch any new guides -> merge -> rebuild -> push public -> deploy private
#
# Every network step is best-effort: a rate limit or an outage must not stop the rest of
# the run, because the next run picks up where this one stopped.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
LOG="tools/.refresh.log"
GUIDES_PER_RUN="${GUIDES_PER_RUN:-6}"

{
  echo "=== refresh $(date -u +%FT%TZ) ==="

  # 1. your trophies
  node tools/psn-sync.mjs || echo "!! psn-sync failed (auth may have expired: run node login-once.js)"

  # 2. guides. PowerPyx first: it is index-driven, verified by trophy name, and not rate
  #    limited. PSNProfiles second and small — it cuts you off after ~2 guide pages.
  node tools/fetch-powerpyx.mjs --auto "$GUIDES_PER_RUN" || true
  node tools/merge-powerpyx.mjs || true
  node tools/fetch-guide.mjs --auto 2 || true
  node tools/merge-guides.mjs || true
  node tools/guide-enrich.mjs --limit 20 || true

  # 3. artifacts the apps load
  node tools/build-slim.mjs || exit 1
  node tools/stamp-assets.mjs || exit 1

  # 4. public site: facts only. guides-full.json / powerpyx-raw.json are gitignored.
  if ! git diff --quiet -- data index.html; then
    git add data index.html
    git commit -q -m "data: sync $(date +%Y-%m-%d)"
    git push -q origin main && echo "pushed public"
  else
    echo "no public data changes"
  fi

  # 5. private site: the same app PLUS the guide authors' text, behind Cloudflare Access.
  #    This is what your phone loads.
  if command -v npx >/dev/null 2>&1; then
    node tools/build-private.mjs && ./tools/deploy-private.sh --quiet && echo "deployed private"
  fi
  echo "=== done $(date -u +%FT%TZ) ==="
} >> "$LOG" 2>&1
tail -6 "$LOG"
