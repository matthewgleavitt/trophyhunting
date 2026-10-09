#!/usr/bin/env node
/**
 * merge-ta.mjs — fold TrueAchievements cross-reference data into data/enriched.json.
 *
 * Multiplatform games share an achievement list with their Xbox version, and
 * TrueAchievements carries a time estimate and a walkthrough for many games that have no
 * PlayStation guide at all. Those hours are what turn a dashed "?" estimate into a real one.
 *
 * Precedence: PowerPyx > PSNProfiles guide > TrueAchievements. Your overrides always win.
 *
 *   node tools/merge-ta.mjs            (expects data/ta-hours.json)
 *   node tools/merge-ta.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SRC = path.join(DATA, 'ta-hours.json');
const ENR = path.join(DATA, 'enriched.json');
const DRY = process.argv.includes('--dry-run');
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

const ta = read(SRC, null);
if (!ta) { console.error('data/ta-hours.json missing — run tools/ta-hours-snippet.js first'); process.exit(2); }
const enriched = read(ENR, {});
const progress = read(path.join(DATA, 'progress.json'), {});

let added = 0, skippedBetter = 0, mismatched = 0;
for (const [key, v] of Object.entries(ta)) {
  if (!v || (v.hoursMin == null && !v.walkthrough)) continue;
  const cur = enriched[key] && enriched[key].guide;
  // never downgrade a PlayStation-specific guide
  if (cur && cur.source && cur.source !== 'trueachievements') { skippedBetter++; continue; }

  // Sanity check: if the achievement count is wildly different from the trophy list, this
  // is probably a different game (or an Xbox version with different DLC) — do not trust it.
  const g = progress[key];
  if (g && v.achievements) {
    const trophies = ((g.earned || []).length + (g.unearned || []).length) - (g.hasPlatinum ? 1 : 0);
    if (trophies > 0 && Math.abs(trophies - v.achievements) > Math.max(4, trophies * 0.35)) { mismatched++; continue; }
  }

  enriched[key] = enriched[key] || {};
  enriched[key].guide = {
    source: 'trueachievements',
    url: v.walkthrough || v.url,
    fetchedAt: new Date().toISOString(),
    hoursMin: v.hoursMin, hoursMax: v.hoursMax,
    difficulty: null, playthroughs: null, missables: null, online: null,
    crossReferenced: 'Xbox achievement list for the same game',
  };
  added++;
}
console.log(JSON.stringify({ games: Object.keys(ta).length, added, skippedBetter, mismatched }, null, 2));
if (DRY) { console.log('dry run — nothing written'); process.exit(0); }
fs.writeFileSync(ENR, JSON.stringify(enriched, null, 2) + '\n');
console.log('wrote data/enriched.json — next: node tools/build-slim.mjs');
