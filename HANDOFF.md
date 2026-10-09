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

## Current data (PSN API sync, 2026-10-09)

**530 games · 178 platinums · 298 in progress · 7,780 trophies left.** Live from the PSN
API — `npm run sync` is now the refresh path and `tools/.psn-tokens.json` holds a refresh
token, so you will not need the NPSSO again for about 60 days.

Sanity check: Mega Man 11 reads 3 left, all at 0.3% (PSN official rate), difficulty 8.2,
needs a full run. Disc Jam sits in Unattainable on PSNProfiles' official server-shutdown tag.

### Two things to know about rarity

PSN's official earned-rate counts **everyone who ever booted the game**; sites like
PSNProfiles report rates among **enthusiasts**, which run roughly 10x higher. Mega Man 11's
platinum is 0.3% on PSN and 3.59% on PSNProfiles — both correct, different populations.
The difficulty curve is calibrated to the PSN scale (median remaining trophy ~5%). If you
ever switch the primary rarity source, **recalibrate `rarityDifficulty()`** or every game
will read as a skill wall.

A game's difficulty is weighted 65/35 between its rarest and its typical remaining trophy,
so one brutal outlier among twenty ordinary trophies does not condemn the whole game.

24 games carry a **⚠ check first** chip from PSNProfiles forum thread titles ("Platinum
unobtainable?"). Those are leads, not facts — only the official shutdown tag marks a game
dead. Confirm one and record it in `data/overrides.json`:

```json
{ "mad max": { "platDead": true, "deadReason": "online trophy dead since the server shutdown" } }
```

Per-trophy notes work the same way and show in gold above anything scraped:

```json
{ "before your eyes": { "trophies": { "Eyes of Steel": {
    "tags": ["BUGGY"], "notes": ["Tried repeatedly without it unlocking."] } } } }
```

## The guide pass (not done yet — the highest-value thing left)

Each PSNProfiles guide page supplies difficulty/10, playthroughs, hours, and per-trophy
Missable / Online Required / Difficulty Specific tags (Helldivers 2: 6/10, 75h, 35 online
trophies; Resident Evil 4: 7 playthroughs, 27 missables). That is what turns the dashed
"?" estimates into real ones.

**Run it in your own Chrome, not an embedded browser pane.** After the main scrape, paste
`tools/psnp-guides-snippet.js` into the console on psnprofiles.com, then:

```js
psnpgState()      // progress
psnpgDownload()   // saves psnp-guides.json — DO THIS PERIODICALLY, not just at the end
```

```bash
mv ~/Downloads/psnp-guides.json data/
node tools/merge-psnp.mjs && node tools/build-slim.mjs
```

WARNING — download as you go. The snippet also writes each result to
`localStorage['psnpGuides.v1']`, and I originally documented that as a safe fallback.
It is not, in an embedded pane: the Claude browser pane reset its storage on navigation
and lost a run, including a key that had been written 244 times. In a normal Chrome tab
localStorage is durable, but `psnpgDownload()` is the only thing that actually guarantees
you keep the work. PSNProfiles serves guide pages slowly (about a minute each), so a full
196-page run takes hours. Partial results are fine and merge cleanly.

## Known gaps / next steps

- **Most hour estimates are still rough guesses** (dashed chip with a `?`) until the guide
  pass above is merged. That is the single highest-value thing left, and the sync now
  preserves scraped metadata, so running it once means it survives every future refresh.
- 39 games have no guide anywhere (down from 57 after the Xbox cross-reference); they say
  so plainly rather than offering a search dressed up as a guide.
- **The Xbox cross-reference is the cheapest win left.** Multiplatform games share an
  achievement list with their Xbox version, and TrueAchievements carries time estimates and
  walkthroughs for games with no PlayStation guide at all. One pass over 102 games found 65,
  added 57, and cut guess-marked estimates from 142 to 105. Re-run it for anything still
  showing a dashed "?" — see `tools/ta-hours-snippet.js` and `tools/merge-ta.mjs`. PlayStation
  exclusives (LittleBigPlanet, inFamous, Twisted Metal…) will never match, which is expected.
- `npm run sync` is the routine refresh. `tools/refresh.sh` chains sync -> enrich ->
  build-slim -> stamp-assets -> commit -> push; see the launchd plist in tools/README.md.
- `data/library.json` is your full purchase history, committed to a **public** repo.
  Decided 2026-10-08: publish it, so the Never-started tab works on your phone with no
  setup. To reverse that later, add it to `.gitignore` and the tab degrades gracefully.
- Genres only exist for games that were in the original PocketPSN export.
- Platform-stack duplicates (same game on PS4 + PS5) are merged by name; a handful of
  collisions get suffixed. `tools/last-sync-report.json` lists them after every sync.
