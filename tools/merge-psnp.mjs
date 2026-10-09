#!/usr/bin/env node
/**
 * merge-psnp.mjs — merge a PSNProfiles scrape (data/psnp-trophies.json, produced
 * from the browser) into data/progress.json, upgrading matched games to the v2
 * shape (title, per-trophy type/rarity/tier/date, lastPlayed, hasPlatinum,
 * platinumEarned, psnp id/href) while keeping every legacy field.
 *
 * Input shape (per PSNProfiles href):
 *   { t: title, n: total, e: earnedCount, notes: [..], stats: "..", guide: "/guide/..",
 *     trophies: [[name, desc, type, earned(0/1), dateText, rarityPSNP, rarityPSN, tier, unobtainable(0/1)], ...] }
 *
 *   node tools/merge-psnp.mjs            # writes data/progress.json (backup in tools/.psn-cache/)
 *   node tools/merge-psnp.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SCRAPE = path.join(DATA, 'psnp-trophies.json');
const MAP = path.join(ROOT, 'tools', 'fixtures', 'psnp-map.json');
const PROGRESS = path.join(DATA, 'progress.json');
const META = path.join(DATA, 'sync-meta.json');
const DRY = process.argv.includes('--dry-run');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n'); };

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function toIso(txt) {
  if (!txt) return null;
  const m = String(txt).match(/(\d{1,2})(?:st|nd|rd|th)\s+([A-Z][a-z]{2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M))?/);
  if (!m || MONTHS[m[2]] == null) return null;
  let h = m[4] != null ? Number(m[4]) % 12 : 12, mi = m[5] != null ? Number(m[5]) : 0, s = m[6] != null ? Number(m[6]) : 0;
  if (m[7] === 'PM') h += 12;
  return new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1], h, mi, s)).toISOString();
}
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const cleanTitle = (s) => String(s || '').replace(/[™®©]/g, '').replace(/\s*•\s*(NA|EU|JP|Asia)\s*$/, '').replace(/\s+/g, ' ').trim();
function legacyKey(title) {
  return deaccent(cleanTitle(title)).toLowerCase().replace(/['’`]/g, '').replace(/[:;,!?"“”()\[\]{}]/g, '').replace(/[\/\\|–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const tierOf = (t, r) => { if (t) return String(t).toLowerCase(); if (r == null) return null; return r < 5 ? 'ultra rare' : r < 10 ? 'very rare' : r < 20 ? 'rare' : 'common'; };

const scrape = readJson(SCRAPE, null);
if (!scrape) { console.error('data/psnp-trophies.json missing'); process.exit(2); }
const map = readJson(MAP, { mapping: {} }).mapping;
const gamesList = readJson(path.join(ROOT, 'tools', 'fixtures', 'psnp-games-2026-10-08.json'), []);
const guideOverviews = readJson(path.join(DATA, 'psnp-guides.json'), {});   // optional second pass
const listByHref = Object.fromEntries(gamesList.map((g) => [g.h, g]));
const PLAT = { PS5: 'PS5', PS4: 'PS4', PS3: 'PS3', VITA: 'Vita', PSVITA: 'Vita', VR: 'VR', PSVR: 'VR', PSVR2: 'VR', PC: 'PS PC' };
const legacy = readJson(PROGRESS, {});
const out = { ...legacy };
let upgraded = 0, added = 0, collisions = 0, deadFlags = [];
const collisionTitles = {};
for (const [href, g] of Object.entries(scrape)) {
  if (href.startsWith('__') || !g || !Array.isArray(g.trophies)) continue;   // metadata keys
  const id = (href.match(/\/trophies\/(\d+)-/) || [])[1] || null;
  let key = map[href] || legacyKey(g.t);
  if (!legacy[key] && !out[key]) { added++; }
  else if (out[key] && out[key].psnpHref && out[key].psnpHref !== href) {
    // Same name, different trophy list — Skyrim has separate PS5/PS4/PS3 sets. Keep both,
    // and disambiguate so the UI does not show two identical titles.
    collisions++;
    const plats = String((listByHref[href] || {}).p || '').split(',').map((x) => PLAT[x.trim().toUpperCase()] || x.trim()).filter(Boolean);
    const suffix = plats.length ? plats.join('/') : id;
    key = `${key} (${suffix.toLowerCase()})`;
    collisionTitles[key] = suffix;
  }
  const base = legacy[map[href]] || legacy[key] || {};
  // rarity = PSN's official earned-rate (what the PSN API also reports); rarityPsnp = PSNProfiles' tracked-user rate
  const trophies = g.trophies.map((t) => { const rPsn = t[6] != null ? t[6] : t[5]; return { name: t[0], desc: t[1], type: t[2], rarity: rPsn, rarityPsnp: t[5], tier: tierOf(null, rPsn), earned: !!t[3], date: t[3] ? toIso(t[4]) : null, unobtainable: !!t[8] }; });
  const earned = trophies.filter((t) => t.earned).map(({ earned, unobtainable, ...r }) => r);
  const unearned = trophies.filter((t) => !t.earned).map(({ earned, date, ...r }) => r);
  const dates = earned.map((t) => t.date).filter(Boolean).sort();
  // PSNProfiles' official game tag reads "Server shutdown Sep.30" — terse, with a date.
  // Everything else in notes is a FORUM THREAD TITLE ("Delisted?", "Platinum unobtainable?"),
  // which is a lead to check, not a fact. Only the official tag marks a game dead.
  const OFFICIAL = /^server shutdown\s+[A-Z][a-z]{2}\.?\s*\d/i;
  const shutdown = g.notes.find((n) => OFFICIAL.test(n)) || null;
  const communityFlags = [...new Set(g.notes.filter((n) => !OFFICIAL.test(n)))].slice(0, 4);
  if (shutdown) deadFlags.push([key, shutdown]);
  const platOwners = (g.stats.match(/\(([\d.]+)%\)\s*Platinum Achievers/) || [])[1];
  // PSNProfiles guide overview (difficulty / playthroughs / hours) when the second pass ran
  const ov = g.guide ? guideOverviews[g.guide] : null;
  const psnpGuideFacts = ov && (ov.difficulty != null || ov.hoursMin != null) ? {
    source: 'psnprofiles', url: 'https://psnprofiles.com' + g.guide, fetchedAt: scrape.__scrapedAt || new Date().toISOString(),
    difficulty: ov.difficulty, hoursMin: ov.hoursMin, hoursMax: ov.hoursMax, playthroughs: ov.playthroughs,
  } : null;
  out[key] = {
    ...base,
    title: (cleanTitle(g.t) || base.title || key) + (collisionTitles[key] ? ` (${collisionTitles[key]})` : ''),
    psnpId: id, psnpHref: href, psnpGuide: g.guide || null,
    platinumRarity: platOwners != null ? Number(platOwners) : (base.platinumRarity ?? null),
    serverNote: shutdown,
    communityFlags: communityFlags.length ? communityFlags : undefined,
    platforms: Array.isArray(base.platforms) && base.platforms.length ? base.platforms : String((listByHref[href] || {}).p || '').split(',').map((x) => PLAT[x.trim().toUpperCase()] || x.trim()).filter(Boolean),
    genres: Array.isArray(base.genres) ? base.genres : [],
    hasPlatinum: trophies.some((t) => t.type === 'platinum'),
    platinumEarned: trophies.some((t) => t.type === 'platinum' && t.earned),
    lastPlayed: dates.length ? dates[dates.length - 1] : (base.lastPlayed || null),
    earned, unearned,
    psnpGuideFacts,
    psnpTrophyTags: ov && ov.tags && Object.keys(ov.tags).length ? ov.tags : undefined,
    source: 'psnprofiles', scrapedAt: scrape.__scrapedAt || new Date().toISOString(),
  };
  if (legacy[map[href]] || legacy[key]) upgraded++;
}
const stats = { syncedAt: new Date().toISOString(), schema: 2, source: 'psnprofiles-browser-scrape', games: Object.keys(out).length, upgraded, added, collisions,
  platinums: Object.values(out).filter((g) => g.platinumEarned).length,
  trophiesRemaining: Object.values(out).reduce((s, g) => s + (g.unearned || []).length, 0) };
console.log(JSON.stringify(stats, null, 2));
if (deadFlags.length) console.log('server notes:', deadFlags);
if (DRY) { console.log('dry run — nothing written'); process.exit(0); }
fs.mkdirSync(path.join(ROOT, 'tools', '.psn-cache'), { recursive: true });
fs.copyFileSync(PROGRESS, path.join(ROOT, 'tools', '.psn-cache', `progress.backup.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
writeJson(PROGRESS, out);
writeJson(META, stats);
console.log('wrote data/progress.json + data/sync-meta.json');
console.log('next: node tools/build-slim.mjs   (rebuilds the file the web app loads)');
