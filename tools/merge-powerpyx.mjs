#!/usr/bin/env node
/**
 * merge-powerpyx.mjs — split data/powerpyx-raw.json into the two tiers.
 *
 *   PUBLIC  (committed)  data/enriched.json .guide      — facts: difficulty, hours,
 *     playthroughs, missables, hardest trophy. Facts are not copyrightable.
 *     data/progress.json .ppGuideAnchors / .ppTrophyType — deep-link anchors + trophy types.
 *
 *   PRIVATE (gitignored) data/guides-full.json          — the author's written advice.
 *     PowerPyx's prose is their copyrighted work: personal reference only, never published.
 *
 * Also strips UNVERIFIED TrueAchievements walkthrough urls. Those were built from the game
 * title and never fetched (TA returns 403 to plain HTTP), so some pointed at an empty page
 * or the wrong game entirely. TA stays a facts source; it is never offered as a link again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry-run');
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const write = (p, v) => { if (!DRY) fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

const raw = read(path.join(DATA, 'powerpyx-raw.json'), {});
const progress = read(path.join(DATA, 'progress.json'), {});
const enriched = read(path.join(DATA, 'enriched.json'), {});
const full = read(path.join(DATA, 'guides-full.json'), {});

let games = 0, texts = 0, chars = 0;
for (const [key, v] of Object.entries(raw)) {
  if (!progress[key]) { console.log(`orphan (no such game): ${key}`); continue; }
  const h = v.header || {};
  // ---- public: facts ----
  enriched[key] = enriched[key] || {};
  enriched[key].guide = {
    source: 'powerpyx', url: v.url, fetchedAt: v.fetchedAt,
    difficulty: h.difficulty ?? null, difficultyRaw: h.difficultyRaw ?? null,
    hoursMin: h.hoursMin ?? null, hoursMax: h.hoursMax ?? null, timeRaw: h.timeRaw ?? null,
    playthroughs: h.playthroughs ?? null, playthroughsRaw: h.playthroughsRaw ?? null,
    missables: h.missables ?? null, missablesRaw: h.missablesRaw ?? null,
    glitched: h.glitched ?? null, glitchedRaw: h.glitchedRaw ?? null,
    online: h.online ?? null, offline: h.offline ?? null,
    hardest: h.hardest ?? null, freeRoam: h.freeRoam ?? null,
    difficultyAffectsRaw: h.difficultyAffectsRaw ?? null,
    // how much of THIS trophy list the guide actually covers. Below ~0.95 the gap is
    // normally DLC, and the app says so instead of claiming nothing is written.
    coverage: v.coverage ? v.coverage.ratio : null,
  };
  // ---- public: anchors + trophy types ----
  const anchors = {}, types = {};
  for (const [name, t] of Object.entries(v.trophies || {})) {
    if (t.anchor) anchors[name] = '#' + String(t.anchor).replace(/^#/, '');
    if (t.type) types[name] = t.type;
  }
  if (Object.keys(anchors).length) progress[key].ppGuideAnchors = anchors;
  if (Object.keys(types).length) progress[key].ppTrophyType = types;
  progress[key].ppGuideCoverage = v.coverage ? v.coverage.ratio : null;

  // ---- private: the written advice ----
  const entry = full[key] || { trophies: {} };
  entry.sources = entry.sources || {};
  if (entry.url && !entry.sources.psnprofiles && /psnprofiles/.test(entry.url)) entry.sources.psnprofiles = entry.url;
  entry.sources.powerpyx = v.url;
  entry.url = entry.url || v.url;
  for (const [name, t] of Object.entries(v.trophies || {})) {
    if (!t.text) continue;
    // never overwrite a PSNProfiles write-up that was fetched deliberately
    if (entry.trophies[name] && entry.trophies[name].text) continue;
    entry.trophies[name] = { text: t.text, anchor: t.anchor ? '#' + String(t.anchor).replace(/^#/, '') : '', source: 'powerpyx', url: v.url };
    texts++; chars += t.text.length;
  }
  full[key] = entry;
  games++;
}

// ---- strip unverified TrueAchievements walkthrough urls ----
let stripped = 0;
for (const [key, e] of Object.entries(enriched)) {
  const g = e && e.guide;
  if (!g || g.source !== 'trueachievements' || !g.url) continue;
  g.urlUnverified = g.url;   // keep provenance, but nothing can link it
  delete g.url;
  g.note = 'Xbox cross-reference only. The walkthrough url was never verified, so it is not linked.';
  stripped++;
}

write(path.join(DATA, 'enriched.json'), enriched);
write(path.join(DATA, 'progress.json'), progress);
write(path.join(DATA, 'guides-full.json'), full);
console.log(`${DRY ? '[dry run] ' : ''}powerpyx: ${games} games, ${texts} written trophies (${(chars / 1024).toFixed(0)} KB private)`);
console.log(`stripped ${stripped} unverified TrueAchievements walkthrough link(s)`);
console.log(`private file now covers ${Object.keys(full).length} games`);
