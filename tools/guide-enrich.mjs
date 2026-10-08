#!/usr/bin/env node
/**
 * guide-enrich.mjs — pull structured guide FACTS (not guide text) per game and
 * merge them into data/enriched.json under each game's `guide` key.
 *
 * Source 1 (works over plain HTTP): PowerPyx roadmap headers —
 *   difficulty /10, hours to platinum, offline/online counts, missables, glitched,
 *   "does difficulty affect trophies", minimum playthroughs, server-shutdown notes.
 *
 *   npm run enrich                    all incomplete games without a cached guide
 *   npm run enrich -- --limit 10      first N
 *   npm run enrich -- --game "mega man 11"
 *   npm run enrich -- --refresh       ignore cache
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'tools', '.guide-cache');
const PROGRESS_PATH = path.join(DATA, 'progress.json');
const ENRICHED_PATH = path.join(DATA, 'enriched.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(opt('--limit', 0)) || 0;
const ONLY = opt('--game', null);
const REFRESH = flag('--refresh');
const DELAY_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}
const decode = (s) => s.replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
const stripTags = (html) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- PowerPyx ----------
const slugify = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const POST_RE = /https:\/\/www\.powerpyx\.com\/([a-z0-9-]+-)trophy-guide(?:-roadmap)?\/?(?=["'\s])/gi;
function looksLikeGuide(html) { return /Estimated trophy difficulty/i.test(html) || /Approximate amount of time to (platinum|100%)/i.test(html); }
async function tryUrl(url) {
  try { const html = await get(url); return looksLikeGuide(html) ? { url, html } : null; } catch { return null; }
}
async function powerpyxFind(title) {
  const slug = slugify(title);
  // 1) canonical slugs first — far more reliable than site search
  for (const u of [`https://www.powerpyx.com/${slug}-trophy-guide-roadmap/`, `https://www.powerpyx.com/${slug}-trophy-guide/`]) {
    const hit = await tryUrl(u);
    await sleep(400);
    if (hit) return hit;
  }
  // 2) site search, strict post-slug regex, exact/near slug match wins
  const html = await get('https://www.powerpyx.com/?s=' + encodeURIComponent(title));
  const found = [...new Set([...html.matchAll(POST_RE)].map((m) => m[0].replace(/\/?$/, '/')))];
  if (!found.length) return null;
  const want = alnum(title);
  const score = (u) => {
    const s = alnum(u.replace(/^https:\/\/www\.powerpyx\.com\//, '').replace(/-trophy-guide.*$/, ''));
    if (s === want) return 100;
    if (/newgame|dlc|expansion|season|pack/i.test(s) && !/newgame|dlc|expansion|season|pack/i.test(want)) return 5;
    if (want.startsWith(s) || s.startsWith(want)) return 60 + (Math.min(s.length, want.length) / Math.max(s.length, want.length)) * 30;
    let common = 0; for (const w of title.toLowerCase().split(/\W+/).filter((x) => x.length > 2)) if (s.includes(alnum(w))) common++;
    return common * 10;
  };
  found.sort((a, b) => score(b) - score(a));
  if (score(found[0]) < 40) return null; // nothing credible
  return tryUrl(found[0]);
}
function numRange(s) {
  const nums = (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  return { min: Math.min(nums[0], nums[1] ?? nums[0]), max: Math.max(nums[0], nums[1] ?? nums[0]) };
}
function parsePowerpyx(html, url) {
  const full = stripTags(html);
  // scope to the roadmap header: from "Trophy Roadmap" (or difficulty line) up to Introduction / Step 1
  const start = Math.max(0, full.search(/Trophy Roadmap|Estimated trophy difficulty/i));
  const rest = full.slice(start);
  const endRel = rest.search(/\n\s*(Introduction|Step 1|Stage 1|Trophy Guide\s*\n)/i);
  const text = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 4000);
  if (process.env.DEBUG_ENRICH) console.log('--- scoped header (start=' + start + ', endRel=' + endRel + ') ---\n' + text.slice(0, 900) + '\n--- end ---');
  const line = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const difficulty = line(/Estimated trophy difficulty\s*:\s*([^\n]+)/i);
  const time = line(/Approximate amount of time to platinum\s*:\s*([^\n]+)/i) || line(/Approximate amount of time to 100%\s*:\s*([^\n]+)/i);
  const offline = line(/Offline Trophies\s*:\s*([^\n]+)/i);
  const online = line(/Online Trophies\s*:\s*([^\n]+)/i);
  const missable = line(/Number of missable trophies\s*:\s*([^\n]+)/i);
  const glitched = line(/Glitched trophies\s*:\s*([^\n]+)/i);
  const diffAffects = line(/Does difficulty affect trophies\s*\??\s*:\s*([^\n]+)/i);
  const playthroughs = line(/Minimum Playthroughs?\s*:\s*([^\n]+)/i);
  const freeRoam = line(/Free-?Roam\s*\/\s*Level Select after Story\s*\??\s*:\s*([^\n]+)/i);
  const num = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
  const hours = numRange(time);
  // Only explicit server-closure language counts; 'unobtainable' alone is too often about glitches or other platforms.
  const serverNote = /\bservers? (are|were|have been|will be|got|is|was) (now )?(shut ?down|closed|taken offline|offline|discontinued)|\bservers? (shutdown|closure)\b|\bonline (trophies|mode) (is|are) (no longer|not) (obtainable|available|possible)/i.test(text);
  return {
    source: 'powerpyx', url, fetchedAt: new Date().toISOString(),
    difficulty: num(difficulty), difficultyRaw: difficulty,
    hoursMin: hours ? hours.min : null, hoursMax: hours ? hours.max : null, timeRaw: time,
    offline: num(offline), online: num(online), missables: num(missable), missablesRaw: missable,
    glitched: num(glitched), glitchedRaw: glitched,
    difficultyAffects: diffAffects ? !/^no\b/i.test(diffAffects) : null, difficultyAffectsRaw: diffAffects,
    playthroughs: num(playthroughs), playthroughsRaw: playthroughs,
    freeRoam: freeRoam,
    serverShutdownMentioned: serverNote,
  };
}

// ---------- main ----------
(async () => {
  const progress = readJson(PROGRESS_PATH, {});
  const enriched = readJson(ENRICHED_PATH, {});
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let keys = Object.keys(progress).filter((k) => Array.isArray(progress[k].unearned) ? progress[k].unearned.length > 0 : (progress[k].unearned || 0) > 0);
  if (ONLY) keys = keys.filter((k) => k === ONLY.toLowerCase());
  if (!REFRESH) keys = keys.filter((k) => !(enriched[k] && enriched[k].guide && enriched[k].guide.source));
  if (LIMIT) keys = keys.slice(0, LIMIT);
  console.log(`Enriching ${keys.length} games`);

  let ok = 0, miss = 0;
  for (const [i, key] of keys.entries()) {
    const g = progress[key];
    const title = g.title || key;
    const cachePath = path.join(CACHE_DIR, alnum(key) + '.json');
    let guide = REFRESH ? null : readJson(cachePath, null);
    try {
      if (!guide) {
        const hit = await powerpyxFind(title);
        await sleep(DELAY_MS);
        if (hit) {
          guide = parsePowerpyx(hit.html, hit.url);
        } else {
          guide = { source: null, fetchedAt: new Date().toISOString(), notFound: true };
        }
        writeJson(cachePath, guide);
      }
      enriched[key] = enriched[key] || {};
      if (guide.source) {
        enriched[key].guide = guide; ok++;
        console.log(`[${i + 1}/${keys.length}] ${title} — ${guide.difficulty ?? '?'}/10, ${guide.hoursMin ?? '?'}-${guide.hoursMax ?? '?'}h, ${guide.playthroughs ?? '?'} run(s), ${guide.missables ?? '?'} missable, ${guide.online ?? '?'} online`);
      } else {
        miss++;
        console.log(`[${i + 1}/${keys.length}] ${title} — no PowerPyx guide found`);
      }
    } catch (e) {
      miss++;
      console.log(`[${i + 1}/${keys.length}] ${title} — ERROR ${e.message}`);
    }
    if ((i + 1) % 10 === 0) writeJson(ENRICHED_PATH, enriched);
  }
  writeJson(ENRICHED_PATH, enriched);
  console.log(`\nDone: ${ok} enriched, ${miss} without a guide. Wrote data/enriched.json`);
})().catch((e) => { console.error('ENRICH FAILED:', e.stack || e); process.exit(1); });
