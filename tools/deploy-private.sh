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
QUIET=0; FORCE=0
for a in "$@"; do [ "$a" = "--quiet" ] && QUIET=1; [ "$a" = "--force" ] && FORCE=1; done

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
# Access check. This used to be a y/N prompt, which (a) blocked the scheduled job and
# (b) trusted an answer instead of the truth. Now we ask the live site: an Access-protected
# Pages project answers an anonymous request with a redirect to <team>.cloudflareaccess.com.
# A 200 means the guide text would be readable by anyone with the url, so refuse.
HOST="${HOST:-}"
if [ -z "$HOST" ]; then
  HOST="$(npx wrangler pages project list 2>/dev/null | awk -v p="$PROJECT" '$0 ~ p {for(i=1;i<=NF;i++) if ($i ~ /pages\.dev/) {print $i; exit}}')"
fi
[ -z "$HOST" ] && HOST="${PROJECT}-66s.pages.dev"
echo "Checking Cloudflare Access on https://$HOST …"
HDRS="$(curl -sS -I -m 25 "https://$HOST/" 2>/dev/null || true)"
CODE="$(printf '%s' "$HDRS" | awk 'NR==1{print $2}')"
if printf '%s' "$HDRS" | grep -qi 'cloudflareaccess\.com'; then
  echo "  protected (HTTP $CODE -> cloudflareaccess.com login)"
elif [ "$FORCE" = "1" ]; then
  echo "  WARNING: no Access redirect seen (HTTP $CODE) — deploying anyway because --force was passed."
else
  echo "  REFUSING TO DEPLOY: https://$HOST/ answered HTTP $CODE with no redirect to Cloudflare Access."
  echo "  This build contains trophy-guide text written by other people; it must not be public."
  echo "  Add the Access policy (Access controls -> Applications), then run this again."
  echo "  If you are certain the check is wrong, re-run with --force."
  exit 1
fi

npx wrangler pages deploy dist-private --project-name "$PROJECT" --commit-dirty=true
