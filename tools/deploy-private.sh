#!/usr/bin/env bash
# deploy-private.sh — publish the full-fat build (including guide authors' text) to
# Cloudflare Pages, behind Cloudflare Access.
#
#   ./tools/deploy-private.sh --placeholder   create the project with NO guide text
#   ./tools/deploy-private.sh                 deploy the real build
#
# A Pages project is PUBLIC until you add an Access policy. So: create it with the
# placeholder first, add Access in the dashboard, then deploy for real.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${PROJECT:-trophy-tracker}"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare. Run this first (it opens your browser):"
  echo "    npx wrangler login"
  exit 1
fi

if [ "${1:-}" = "--placeholder" ]; then
  rm -rf dist-placeholder && mkdir -p dist-placeholder
  cat > dist-placeholder/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>Trophy Tracker</title>
<style>body{font:16px/1.6 system-ui;margin:12vh auto;max-width:34rem;padding:0 1.2rem;color:#222}
code{background:#f3f3f3;padding:.15em .4em;border-radius:3px}</style>
<h1>Trophy Tracker</h1>
<p>This site is not configured yet. It will hold a private copy of the trophy tracker,
including trophy-guide text kept for personal reference.</p>
<p>Before deploying the real build, put this project behind Cloudflare Access
(Zero&nbsp;Trust &rarr; Access &rarr; Applications), allowing only your own email.</p>
HTML
  echo "Creating/deploying placeholder to project '$PROJECT'…"
  npx wrangler pages deploy dist-placeholder --project-name "$PROJECT" --commit-dirty=true
  cat <<'NEXT'

Placeholder is live. Now, in the Cloudflare dashboard:
  Zero Trust -> Access -> Applications -> Add an application -> Self-hosted
    Application domain : <your-project>.pages.dev
    Policy             : Allow, Emails -> matthew.g.leavitt@gmail.com
Then run  ./tools/deploy-private.sh  to publish the real build.
NEXT
  exit 0
fi

node tools/build-private.mjs
if [ ! -s dist-private/data/guides-full.json ]; then
  echo "WARNING: no guide text in this build (data/guides-full.json is empty)."
  echo "         Run  npm run guide -- \"<game>\"  first if you expected some."
fi
echo
read -r -p "Is Cloudflare Access already protecting '$PROJECT'? This build contains guide text. [y/N] " ok
case "$ok" in [yY]*) ;; *) echo "Stopped. Add the Access policy first."; exit 1 ;; esac

npx wrangler pages deploy dist-private --project-name "$PROJECT" --commit-dirty=true
