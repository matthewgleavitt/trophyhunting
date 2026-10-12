#!/usr/bin/env bash
# play.sh — "I want to play this tonight and I want the guide in the app."
#
# You should rarely need this: tools/refresh.sh pulls guides on a schedule, so by the time
# you pick a game it is usually already there. This is the impatient path for one game.
#
#   npm run play -- "silent hill 2"
set -uo pipefail
cd "$(dirname "$0")/.."
GAME="${1:-}"
if [ -z "$GAME" ]; then echo 'usage: npm run play -- "<game title>"'; exit 2; fi

echo "Looking for a guide for: $GAME"
node tools/fetch-powerpyx.mjs --game "$GAME" || true
node tools/merge-powerpyx.mjs || true
node tools/build-slim.mjs && node tools/stamp-assets.mjs
if [ -f tools/build-private.mjs ]; then
  node tools/build-private.mjs && ./tools/deploy-private.sh --quiet && echo "Private site updated — open it on your phone."
fi
