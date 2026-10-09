# tools/

Scripts that keep `data/` current. Everything here runs locally; nothing in this
folder is served by the site.

## One-time setup

```bash
npm install
cp tools/.env.example tools/.env
```

Then put your NPSSO in `tools/.env`:

1. Log in at https://www.playstation.com in your normal browser.
2. Open https://ca.account.sony.com/api/v1/ssocookie
3. Copy the 64-character `npsso` value into `tools/.env` as `NPSSO=<value>`.

`tools/.env`, `tools/.psn-tokens.json` and `tools/.psn-cache/` are gitignored.
The NPSSO is exchanged once for a refresh token (cached ~60 days); you only need
a fresh NPSSO when the sync says so.

## Commands

| Command | What it does |
|---|---|
| `npm run sync` | Pull every title + trophy for the account from PSN. Incremental: only titles whose last-trophy time changed are refetched. Writes `data/progress.json`, `data/sync-meta.json`, `data/library.json`, and a report at `tools/last-sync-report.json`. A backup of the previous `progress.json` lands in `tools/.psn-cache/`. |
| `npm run sync -- --full` | Ignore the per-title cache and refetch everything. |
| `npm run sync -- --limit 20 --dry-run` | Smoke test on 20 titles without writing data files. |
| `npm run sync -- --no-library` | Skip the owned-library pull. |
| `npm run enrich` | Pull guide FACTS per unfinished game from PowerPyx roadmap headers (difficulty /10, hours, playthroughs, missables, online, glitched, server-shutdown language) into `data/enriched.json` under `<game>.guide`. Cached per game in `tools/.guide-cache/`; `--refresh` refetches, `--game "<key>"` targets one, `--limit N`. PowerPyx covers ~50 of the 286 unfinished games; the rest fall back to rarity + text heuristics. |
| `tools/psnp-browser-scrape.js` + `node tools/merge-psnp.mjs` | No-NPSSO refresh path. Paste the scrape script into the browser console on your PSNProfiles page (Cloudflare blocks scripts, not browsers); it reads every unfinished game's trophy table (type, PSN + PSNProfiles rarity, earned timestamps, official "Server shutdown" tag) at ~2.5 s/page, then `psnpDownload()` saves `psnp-trophies.json`. Drop it in `data/` and run the merge to upgrade `progress.json` to schema v2. |
| `tools/psnp-guides-snippet.js` | Optional second browser pass, run after the main scrape in the same tab. Reads each game's PSNProfiles guide overview (difficulty /10, playthroughs, hours) and the per-trophy Missable/Online/Difficulty-Specific tags. `psnpgDownload()` saves `psnp-guides.json`; drop it in `data/` and re-run the merge. This is what turns most "rough guess" hour estimates into real ones. |
| `node tools/build-slim.mjs` | Writes `data/progress.slim.json` — the file the web app actually loads. Earned trophies collapse to counts plus a last-played date (the UI never lists them), which is ~64% smaller. Run it after any sync or merge. `progress.json` stays the full source of truth for tooling. |
| `node tools/test-scoring.mjs` | Prints the lanes the scoring model produces for the current data, plus an explanation for Horizon Forbidden West and a synthetic rarity test. Run after changing `js/scoring.js`. |
| `npm run serve` | Static server on http://localhost:8766 for local preview. |

## Data files the app reads

| File | Written by | Purpose |
|---|---|---|
| `data/progress.json` | `npm run sync` (today: legacy PocketPSN export) | every game + trophy |
| `data/enriched.json` | `npm run enrich` | machine-gathered guide facts under `<game>.guide`; legacy manual blocks are kept |
| `data/overrides.json` | **you, by hand** | wins over everything: `platDead`/`deadReason`, per-trophy `trophies.<name>.tags` (MISSABLE, ONLINE, SKILL_WALL, GRIND, RNG, BUGGY, PLAYTHROUGH, UNOBTAINABLE, DLC) and `notes[]` |
| `data/guides.json` + `js/guides-inline.js` | you | long-form walkthrough notes shown in the guide panel |
| `data/library.json` | `npm run sync` | owned titles → "Never started" tab |
| `data/sync-meta.json` | `npm run sync` | sync timestamp + counts shown in the header |

## progress.json schema (v2)

Keyed by the legacy lowercase game name so existing checklist/star state and
`enriched.json` keep matching. Each game:

```
title, npCommunicationId, npServiceName, platforms[], iconUrl,
hasPlatinum, platinumEarned, defined{bronze,silver,gold,platinum}, earnedCounts{...},
progress (0-100 from PSN), lastPlayed (ISO),
url, timeNormal, timeHastily, timePlat, genres[]        <- carried over from the old PocketPSN data
earned[]:   { id, name, desc, type, hidden, group, date (ISO), rarity (% of players), tier }
unearned[]: { id, name, desc, type, hidden, group, rarity, tier }
```

`tier` is PSN's own bucket: `ultra rare` (<5%), `very rare` (5-10%), `rare` (10-20%), `common` (20%+).

## Fixtures

`tools/fixtures/` holds snapshots pasted from PSNProfiles / the PSN library on
2026-10-08, used to validate the first real sync.

## Automatic refresh (optional)

`tools/refresh.sh` runs the sync, enriches any new games, commits `data/` and pushes
(GitHub Pages redeploys in about a minute). To run it every morning at 6:00 on this Mac,
save this as `~/Library/LaunchAgents/com.labyrinthworm.trophy-refresh.plist` and run
`launchctl load ~/Library/LaunchAgents/com.labyrinthworm.trophy-refresh.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.labyrinthworm.trophy-refresh</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>/Users/mattmini/Documents/GitHub/trophyhunting/tools/refresh.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
```

The NPSSO expires roughly every two months; when the sync log says so, paste a fresh one
into `tools/.env`. Nothing secret is ever committed: `.env`, tokens and caches are gitignored.
