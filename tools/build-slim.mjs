#!/usr/bin/env node
/**
 * build-slim.mjs — write data/progress.slim.json, the file the web app actually loads.
 *
 * progress.json is the source of truth and keeps every earned trophy (name, desc,
 * rarity, date). The UI never lists earned trophies: it only needs their COUNT and the
 * most recent date. Dropping the earned[] bodies cuts the payload by ~75%, which matters
 * on a phone over GitHub Pages.
 *
 *   node tools/build-slim.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'progress.json');
const OUT = path.join(ROOT, 'data', 'progress.slim.json');

// Legacy dates look like "Sep. 6th, 202310:51:20 PM EDT" — sorting those as strings is
// wrong (December sorts before September), so parse to a real date and emit ISO.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function toDate(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { const d = new Date(s); return isNaN(d) ? null : d; }
  const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  return new Date(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
}

const full = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const slim = {};
let droppedTrophies = 0;

for (const [key, g] of Object.entries(full)) {
  if (key.startsWith('_')) continue;
  const earned = Array.isArray(g.earned) ? g.earned : [];
  const unearned = Array.isArray(g.unearned) ? g.unearned : [];
  droppedTrophies += earned.length;

  const dates = earned.map((t) => toDate(t && t.date)).filter(Boolean).sort((a, b) => a - b);
  const counts = earned.reduce((a, t) => { if (t && t.type) a[t.type] = (a[t.type] || 0) + 1; return a; }, {});

  const out = {
    title: g.title || key.replace(/\b\w/g, (c) => c.toUpperCase()),
    platforms: g.platforms || [],
    genres: g.genres || [],
    // earned collapses to a count; the app only ever uses earned.length and the latest date
    earnedCount: typeof g.earned === 'number' ? g.earned : earned.length,
    earnedCounts: Object.keys(counts).length ? counts : (g.earnedCounts || null),
    lastPlayed: (toDate(g.lastPlayed) || (dates.length ? dates[dates.length - 1] : null) || { toISOString: () => null }).toISOString(),
    hasPlatinum: typeof g.hasPlatinum === 'boolean' ? g.hasPlatinum : null,
    platinumEarned: typeof g.platinumEarned === 'boolean' ? g.platinumEarned : null,
    platinumRarity: g.platinumRarity ?? null,
    // unearned is the working set — keep it whole
    unearned: unearned.map((t) => {
      const o = { name: t.name, desc: t.desc };
      if (t.type) o.type = t.type;
      if (t.rarity != null) o.rarity = t.rarity;
      if (t.tier) o.tier = t.tier;
      if (t.id != null) o.id = t.id;
      if (t.unobtainable) o.unobtainable = true;
      return o;
    }),
  };
  for (const k of ['url', 'timeNormal', 'timeHastily', 'timePlat', 'psnpHref', 'psnpGuide', 'psnpGuideFacts', 'psnpTrophyTags', 'serverNote', 'iconUrl', 'legacyOnly']) {
    if (g[k] != null) out[k] = g[k];
  }
  slim[key] = out;
}

fs.writeFileSync(OUT, JSON.stringify(slim));
const a = fs.statSync(SRC).size, b = fs.statSync(OUT).size;
console.log(`data/progress.slim.json: ${(b / 1048576).toFixed(2)} MB from ${(a / 1048576).toFixed(2)} MB (${Math.round((1 - b / a) * 100)}% smaller), ${droppedTrophies} earned trophy records collapsed to counts`);
