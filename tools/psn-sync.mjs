#!/usr/bin/env node
/**
 * psn-sync.mjs — pull the owner's full trophy list from PlayStation Network
 * and write data/progress.json (schema v2, backward compatible with index.html).
 *
 *   npm run sync                 incremental (only titles whose lastUpdatedDateTime changed)
 *   npm run sync -- --full       ignore the per-title cache, refetch everything
 *   npm run sync -- --limit 25   first N titles only (smoke test)
 *   npm run sync -- --dry-run    fetch but do not write data/progress.json
 *
 * Auth: tools/.env must contain NPSSO=<64 chars>. Get it by logging in at
 * https://www.playstation.com in your browser, then opening
 * https://ca.account.sony.com/api/v1/ssocookie and copying the "npsso" value.
 * The script exchanges it for a refresh token cached in tools/.psn-tokens.json
 * (gitignored) so the NPSSO is only needed again when that expires (~60 days).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exchangeNpssoForAccessCode,
  exchangeAccessCodeForAuthTokens,
  exchangeRefreshTokenForAuthTokens,
  getUserTitles,
  getTitleTrophies,
  getUserTrophiesEarnedForTitle,
  getPurchasedGames,
} from 'psn-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, 'tools');
const DATA = path.join(ROOT, 'data');
const ENV_PATH = path.join(TOOLS, '.env');
const TOKENS_PATH = path.join(TOOLS, '.psn-tokens.json');
const CACHE_DIR = path.join(TOOLS, '.psn-cache');
const PROGRESS_PATH = path.join(DATA, 'progress.json');
const META_PATH = path.join(DATA, 'sync-meta.json');
const REPORT_PATH = path.join(TOOLS, 'last-sync-report.json');
const LIBRARY_PATH = path.join(DATA, 'library.json');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const FULL = flag('--full');
const DRY = flag('--dry-run');
const LIMIT = Number(opt('--limit', 0)) || 0;
const CONCURRENCY = Number(opt('--concurrency', 2)) || 2;
const DELAY_MS = Number(opt('--delay', 150)) || 150;
const SKIP_LIBRARY = flag('--no-library');

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const log = (...a) => console.log(...a);

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}

async function withRetry(label, fn, tries = 5) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fn();
      if (res && res.error) throw new Error(`${res.error.code || ''} ${res.error.message || JSON.stringify(res.error)}`.trim());
      return res;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      const rateLimited = /429|rate|too many/i.test(msg);
      const wait = (rateLimited ? 4000 : 800) * i;
      if (i < tries) { log(`  retry ${i}/${tries - 1} for ${label} in ${wait}ms (${msg.slice(0, 80)})`); await sleep(wait); }
    }
  }
  throw new Error(`${label} failed: ${lastErr && lastErr.message || lastErr}`);
}

// ---------- auth ----------
async function getAuth() {
  const env = loadEnv();
  const saved = readJson(TOKENS_PATH, null);
  const now = Date.now();
  if (saved && saved.refreshToken && saved.refreshExpiresAt > now + 60_000) {
    if (saved.accessToken && saved.accessExpiresAt > now + 120_000) return saved;
    try {
      const t = await exchangeRefreshTokenForAuthTokens(saved.refreshToken);
      return saveTokens(t);
    } catch (e) {
      log('Refresh token rejected, falling back to NPSSO:', e.message);
    }
  }
  const npsso = (env.NPSSO || '').trim();
  if (!npsso) {
    console.error([
      '',
      'NPSSO missing. One-time setup:',
      '  1. Log in at https://www.playstation.com in your normal browser.',
      '  2. Open https://ca.account.sony.com/api/v1/ssocookie',
      '  3. Copy the 64-character "npsso" value into tools/.env as:  NPSSO=<value>',
      '     (tools/.env is gitignored; never paste the value anywhere else.)',
      '',
    ].join('\n'));
    process.exit(2);
  }
  const code = await withRetry('exchangeNpssoForAccessCode', () => exchangeNpssoForAccessCode(npsso));
  const t = await withRetry('exchangeAccessCodeForAuthTokens', () => exchangeAccessCodeForAuthTokens(code));
  return saveTokens(t);
}
function saveTokens(t) {
  const now = Date.now();
  const rec = {
    accessToken: t.accessToken,
    accessExpiresAt: now + (t.expiresIn || 3600) * 1000,
    refreshToken: t.refreshToken,
    refreshExpiresAt: now + (t.refreshTokenExpiresIn || 60 * 24 * 3600) * 1000,
    savedAt: new Date(now).toISOString(),
  };
  writeJson(TOKENS_PATH, rec);
  return rec;
}

// ---------- naming ----------
const PLATFORM_MAP = { PS5: 'PS5', PS4: 'PS4', PS3: 'PS3', PSVITA: 'Vita', VITA: 'Vita', PSPC: 'PS PC', PC: 'PS PC' };
function platformsOf(t) {
  return String(t.trophyTitlePlatform || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    .map((s) => PLATFORM_MAP[s] || s);
}
function cleanTitle(s) {
  return String(s || '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
}
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const EDITION_RE = /\b(remastered|remaster|remake|hd remaster|hd|definitive edition|ultimate edition|complete edition|game of the year edition|goty|anniversary edition|directors cut|director's cut|butchers cut|butcher's cut|final mix|the game|console edition|enhanced edition|deluxe|ps4|ps5|ps vita|vita|vr|edition)\b/g;
/** Looser key for matching across naming variants: no accents, no edition words. */
function looseKey(title) {
  return deaccent(cleanTitle(title)).toLowerCase().replace(/['’`]/g, '').replace(EDITION_RE, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Reproduce the legacy PocketPSN-style key: lowercase, no apostrophes/colons, collapsed spaces. */
function legacyKey(title) {
  return deaccent(cleanTitle(title)).toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[:;,!?"“”()\[\]{}]/g, '')
    .replace(/[\/\\|–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const alnum = (s) => deaccent(String(s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

const TIER = { 0: 'ultra rare', 1: 'very rare', 2: 'rare', 3: 'common' };
function tierFromRate(rate, trophyRare) {
  if (trophyRare != null && TIER[trophyRare]) return TIER[trophyRare];
  const r = Number(rate);
  if (!isFinite(r)) return null;
  if (r < 5) return 'ultra rare';
  if (r < 10) return 'very rare';
  if (r < 20) return 'rare';
  return 'common';
}

// ---------- fetch helpers ----------
async function listAllTitles(auth) {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await withRetry(`getUserTitles@${offset}`, () => getUserTitles(auth, 'me', { limit: 800, offset }));
    out.push(...(res.trophyTitles || []));
    if (res.nextOffset == null || !(res.trophyTitles || []).length) break;
    offset = res.nextOffset;
    await sleep(DELAY_MS);
  }
  return out;
}
async function pageAll(label, fn) {
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await withRetry(`${label}@${offset}`, () => fn(offset));
    out.push(...(res.trophies || []));
    if (res.nextOffset == null || !(res.trophies || []).length) break;
    offset = res.nextOffset;
    await sleep(DELAY_MS);
  }
  return out;
}
async function fetchTitleTrophies(auth, t) {
  const opts = t.npServiceName === 'trophy' ? { npServiceName: 'trophy' } : {};
  const defs = await pageAll(`getTitleTrophies ${t.trophyTitleName}`, (offset) => getTitleTrophies(auth, t.npCommunicationId, 'all', { ...opts, offset }));
  await sleep(DELAY_MS);
  const earned = await pageAll(`getUserTrophiesEarnedForTitle ${t.trophyTitleName}`, (offset) => getUserTrophiesEarnedForTitle(auth, 'me', t.npCommunicationId, 'all', { ...opts, offset }));
  const byId = new Map(earned.map((e) => [e.trophyId, e]));
  return defs.map((d) => {
    const e = byId.get(d.trophyId) || {};
    const rate = e.trophyEarnedRate != null ? Number(e.trophyEarnedRate) : null;
    return {
      id: d.trophyId,
      name: cleanTitle(d.trophyName),
      desc: cleanTitle(d.trophyDetail),
      type: d.trophyType,
      hidden: !!d.trophyHidden,
      group: d.trophyGroupId || 'default',
      earned: !!e.earned,
      date: e.earned ? (e.earnedDateTime || null) : null,
      rarity: rate,
      tier: tierFromRate(rate, e.trophyRare),
      progressTarget: e.trophyProgressTargetValue != null ? e.trophyProgressTargetValue : undefined,
    };
  });
}


// ---------- owned library (purchased + PS Plus) ----------
const NONGAME_RE = /\b(demo|beta|soundtrack|ost|trailer|theme|unity save data|public test server|the art of)\b|^(youtube|netflix|hulu|spotify|twitch|plex|disney\+|hbo go|funimation|amazon prime video|media player|live events viewer|playstation vue|vudu hd movies|littlstar cinema|p\.t\.)$/i;
async function syncLibrary(auth) {
  const res = await withRetry('getPurchasedGames', () => getPurchasedGames(auth));
  const games = (res && res.data && res.data.purchasedTitlesRetrieve && res.data.purchasedTitlesRetrieve.games) || [];
  const seen = new Set();
  const titles = [];
  for (const g of games) {
    if (!g || !g.titleId || seen.has(g.titleId)) continue;
    seen.add(g.titleId);
    const name = cleanTitle(g.name);
    titles.push({
      name,
      platform: g.platform,
      plus: g.membership === 'PS_PLUS',
      titleId: g.titleId,
      preorder: !!g.isPreOrder,
      active: g.isActive !== false,
      image: g.image && g.image.url || null,
      nonGame: NONGAME_RE.test(name),
    });
  }
  writeJson(LIBRARY_PATH, { capturedAt: new Date().toISOString(), source: 'PSN getPurchasedGames', count: titles.length, titles });
  log(`Library: ${titles.length} entitlements (${titles.filter((t) => !t.nonGame).length} games) → data/library.json`);
  return titles.length;
}

// ---------- main ----------
(async () => {
  const startedAt = new Date();
  log(`PSN sync starting ${startedAt.toISOString()}${FULL ? ' (FULL)' : ''}${DRY ? ' (DRY RUN)' : ''}`);
  const auth = await getAuth();

  if (!SKIP_LIBRARY && !DRY) {
    try { await syncLibrary(auth); } catch (e) { log('Library sync skipped:', e.message); }
  }

  const legacy = readJson(PROGRESS_PATH, {});
  const legacyByKey = new Map(Object.entries(legacy));
  const legacyByAlnum = new Map(Object.keys(legacy).map((k) => [alnum(k), k]));
  const legacyByLoose = new Map(Object.keys(legacy).map((k) => [looseKey(k), k]));

  let titles = (await listAllTitles(auth)).filter((t) => !t.hiddenFlag);
  log(`Titles on account: ${titles.length}`);
  if (LIMIT) titles = titles.slice(0, LIMIT);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const report = { startedAt: startedAt.toISOString(), titles: titles.length, fetched: 0, cached: 0, failed: [], unmatchedLegacy: [], fuzzyMatched: [], keyCollisions: [], newGames: [] };

  // worker pool
  const results = new Array(titles.length);
  let next = 0;
  async function worker(id) {
    for (;;) {
      const i = next++;
      if (i >= titles.length) return;
      const t = titles[i];
      const cachePath = path.join(CACHE_DIR, `${t.npCommunicationId}.json`);
      const cached = FULL ? null : readJson(cachePath, null);
      let trophies;
      if (cached && cached.lastUpdatedDateTime === t.lastUpdatedDateTime && cached.trophySetVersion === t.trophySetVersion && Array.isArray(cached.trophies)) {
        trophies = cached.trophies; report.cached++;
      } else {
        try {
          trophies = await fetchTitleTrophies(auth, t);
          writeJson(cachePath, { npCommunicationId: t.npCommunicationId, lastUpdatedDateTime: t.lastUpdatedDateTime, trophySetVersion: t.trophySetVersion, fetchedAt: new Date().toISOString(), trophies });
          report.fetched++;
          log(`[${i + 1}/${titles.length}] ${cleanTitle(t.trophyTitleName)} — ${trophies.filter((x) => x.earned).length}/${trophies.length}`);
          await sleep(DELAY_MS);
        } catch (e) {
          report.failed.push({ title: t.trophyTitleName, id: t.npCommunicationId, error: String(e.message || e) });
          log(`[${i + 1}/${titles.length}] FAILED ${t.trophyTitleName}: ${e.message}`);
          continue;
        }
      }
      results[i] = { t, trophies };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k)));

  // assemble v2 progress
  const out = {};
  for (const r of results) {
    if (!r) continue;
    const { t, trophies } = r;
    const title = cleanTitle(t.trophyTitleName);
    let key = legacyKey(title);
    let legacyRec = legacyByKey.get(key);
    if (!legacyRec) {
      const alt = legacyByAlnum.get(alnum(title));
      if (alt) { key = alt; legacyRec = legacyByKey.get(alt); }
    }
    if (!legacyRec) {
      const alt = legacyByLoose.get(looseKey(title));
      if (alt) { key = alt; legacyRec = legacyByKey.get(alt); report.fuzzyMatched.push({ title, legacyKey: alt }); }
    }
    if (!legacyRec) report.unmatchedLegacy.push(title);
    if (out[key]) {
      // same name on another platform stack: keep both, suffix the later one
      const p = platformsOf(t)[0] || 'alt';
      const alt = `${key} (${p.toLowerCase()})`;
      report.keyCollisions.push({ key, alt, title });
      key = alt;
    }
    const earnedArr = trophies.filter((x) => x.earned).map(({ earned, ...rest }) => rest);
    const unearnedArr = trophies.filter((x) => !x.earned).map(({ earned, date, ...rest }) => rest);
    const platEarned = trophies.some((x) => x.type === 'platinum' && x.earned);
    out[key] = {
      title,
      npCommunicationId: t.npCommunicationId,
      npServiceName: t.npServiceName,
      platforms: platformsOf(t),
      iconUrl: t.trophyTitleIconUrl || null,
      hasPlatinum: (t.definedTrophies && t.definedTrophies.platinum > 0) || trophies.some((x) => x.type === 'platinum'),
      platinumEarned: platEarned,
      defined: t.definedTrophies || null,
      earnedCounts: t.earnedTrophies || null,
      progress: t.progress,
      lastPlayed: t.lastUpdatedDateTime || null,
      // legacy carry-over (PocketPSN/HLTB/IGDB fields the PSN API does not have)
      url: legacyRec && legacyRec.url || null,
      timeNormal: legacyRec && legacyRec.timeNormal || null,
      timeHastily: legacyRec && legacyRec.timeHastily || null,
      timePlat: legacyRec && legacyRec.timePlat || null,
      genres: legacyRec && Array.isArray(legacyRec.genres) ? legacyRec.genres : [],
      earned: earnedArr,
      unearned: unearnedArr,
    };
    if (!legacyRec) report.newGames.push(title);
  }

  // keep legacy games that PSN did not return (should be rare) so nothing silently vanishes
  let keptLegacy = 0;
  for (const [k, v] of legacyByKey) {
    if (!out[k] && !Object.values(out).some((g) => alnum(g.title) === alnum(k))) { out[k] = { ...v, title: v.title || k, legacyOnly: true }; keptLegacy++; }
  }

  const stats = {
    syncedAt: new Date().toISOString(),
    schema: 2,
    games: Object.keys(out).length,
    platinums: Object.values(out).filter((g) => g.platinumEarned).length,
    completed: Object.values(out).filter((g) => (g.unearned || []).length === 0).length,
    trophiesEarned: Object.values(out).reduce((s, g) => s + (g.earned || []).length, 0),
    trophiesRemaining: Object.values(out).reduce((s, g) => s + (g.unearned || []).length, 0),
    legacyOnly: keptLegacy,
    fetched: report.fetched, cached: report.cached, failed: report.failed.length,
  };
  report.stats = stats;
  writeJson(REPORT_PATH, report);

  if (DRY) {
    log('\nDRY RUN — not writing data/progress.json');
  } else {
    if (fs.existsSync(PROGRESS_PATH)) fs.copyFileSync(PROGRESS_PATH, path.join(CACHE_DIR, `progress.backup.${startedAt.toISOString().replace(/[:.]/g, '-')}.json`));
    writeJson(PROGRESS_PATH, out);
    writeJson(META_PATH, stats);
  }
  log('\nDone.', JSON.stringify(stats, null, 2));
  if (report.failed.length) log(`${report.failed.length} titles failed — see tools/last-sync-report.json`);
  if (report.unmatchedLegacy.length) log(`${report.unmatchedLegacy.length} titles had no legacy match (new games or renamed) — see report.`);
  if (report.keyCollisions.length) log(`${report.keyCollisions.length} platform-stack name collisions suffixed — see report.`);
})().catch((e) => { console.error('\nSYNC FAILED:', e && e.stack || e); process.exit(1); });
