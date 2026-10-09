# Trophy Tracker — where things stand (2026-10-08)

Live site: https://matthewgleavitt.github.io/trophyhunting/ (deploys from `main`)
Local preview: `npm run serve` → http://localhost:8766

## What this is for

One question: **which unfinished game do I play tonight?** Everything below exists to
answer that without making you read 288 cards.

## The scoring model (js/scoring.js)

Your rules, as implemented:

| Your rule | How it works |
|---|---|
| "High attainment % = easier" | A trophy's rarity sets its difficulty (50% → ~1.5/10, 3% → ~7.6/10). When **everything left** is common (≥20%), the game is an Easy Gain no matter how brutal its reputation. |
| "Horizon needs a whole new playthrough, so -3 hours is wrong" | Trophies that need a fresh run are detected and charged a **full playthrough** (hasty time → guide hours ÷ runs → normal × 0.6 → 10h fallback), ×1.6 if the run is locked to a hard difficulty. |
| "Disc Jam shouldn't be close, it's unattainable" | Server-shutdown tags, unobtainable trophies and your own `overrides.json` move a game to the **Unattainable** lane and take it out of scoring. |
| "Mega Man 11 trophies are extremely rare" | 3 left, all ~3.7% → difficulty 7.1, not "almost done". |
| "4 left doesn't mean easiest" | Effort is driven by rarity and time, not by the count. |

Two corrections found by running the model against real scraped data:

1. **Effort is sub-additive.** Summing per-trophy hours turned a 54-trophy roguelike into
   286h. Trophies overlap — one run sweeps up many — so the hardest dominates and the rest
   decay. Mewgenics now reads ~105h.
2. **Rarity measures difficulty, not duration.** Twisted Metal's 23 remaining trophies sit
   at ~30% (common, so cheap by rarity) but mean replaying the campaign as every character.
   There's now a floor for doing N separate things, plus an anchor to the game's own time
   estimate scaled by the share of trophies left.

Estimates with no underlying time data are marked **low confidence**: dashed chip, a `?`,
a wider range, and a stated reason. Getting rid of those is what the guide pass below is for.

## Data pipeline

```
PSN / PSNProfiles ──► data/progress.json  (source of truth, full history)
                            │
PowerPyx ──► data/enriched.json            │
your hand edits ──► data/overrides.json    │   (always wins)
                            ▼
                   node tools/build-slim.mjs
                            ▼
                 data/progress.slim.json  ◄── what the web app loads (64% smaller)
```

### Refreshing the data — two paths

**A. PSN API (best; needs a token from you, and can run itself on a schedule)**

```bash
cp tools/.env.example tools/.env     # then paste your NPSSO into it
npm run sync && node tools/build-slim.mjs
```

Get the NPSSO: log in at playstation.com, open
https://ca.account.sony.com/api/v1/ssocookie, copy the `npsso` value. It lasts ~60 days.
`tools/.env` is gitignored — never commit it, and I never handle it.
`tools/refresh.sh` does sync → enrich → build → commit → push; see `tools/README.md`
for the launchd plist that runs it every morning.

**B. PSNProfiles browser scrape (no token, slower, rate-limited)**

PSNProfiles blocks plain HTTP with Cloudflare but a real browser tab is fine. Open your
profile, paste `tools/psnp-browser-scrape.js` into the console, wait, run `psnpDownload()`,
move the file to `data/psnp-trophies.json`, then:

```bash
node tools/merge-psnp.mjs && node tools/build-slim.mjs
```

Then optionally paste `tools/psnp-guides-snippet.js` in the same tab for the guide
overviews (difficulty / playthroughs / hours + per-trophy Missable/Online tags), save as
`data/psnp-guides.json`, and re-run the merge. **This is the thing that turns most
"rough guess" hour estimates into real ones.**

## Known gaps / next steps

- Most games still show low-confidence hours until the guide pass (B, step 2) runs.
- `data/library.json` is your full purchase history, committed to a **public** repo.
  Decided 2026-10-08: publish it, so the Never-started tab works on your phone with no
  setup. To reverse that later, add it to `.gitignore` and the tab degrades gracefully.
- Genres only exist for games that were in the original PocketPSN export.
- Platform-stack duplicates (same game on PS4 + PS5) are merged by name; a handful of
  collisions get suffixed. `tools/last-sync-report.json` lists them after every sync.
