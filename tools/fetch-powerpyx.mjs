#!/usr/bin/env node
/**
 * fetch-powerpyx.mjs — pull a PowerPyx trophy guide and extract PER-TROPHY text.
 *
 * Why this exists separately from guide-enrich.mjs: that one only reads the roadmap
 * header (difficulty / hours / playthroughs). This one reads the guide table, so the
 * app can show what the guide actually says about a single trophy.
 *
 * THE RULE THAT MATTERS — never accept a guide we have not verified covers the game.
 * Title matching alone produced real, shipped bugs: a constructed TrueAchievements URL
 * for "Fruit Ninja VR" pointed at Marvel Rivals, and "CONTROL Resonant" silently got the
 * original Control guide, which shares only 4 of its 50 trophy names. So a candidate page
 * is accepted only when the game's own trophy NAMES appear in it. That check is cheap,
 * needs no judgement, and is impossible to fool with a plausible-looking slug.
 *
 * Output: data/powerpyx-raw.json  (gitignored — contains guide prose, which is PowerPyx's
 * copyrighted work. merge-guides.mjs splits it into public facts and private text.)
 *
 *   node tools/fetch-powerpyx.mjs --game "control resonant"
 *   node tools/fetch-powerpyx.mjs --auto 25        # games with no verified guide yet
 *   node tools/fetch-powerpyx.mjs --retry-ta       # games whose only "guide" was an unverified TA url
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const RAW_PATH = path.join(DATA, 'powerpyx-raw.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DELAY = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const decode = (s) => String(s)
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
  .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
  .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');
const strip = (html) => decode(String(html)
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|div|h\d|tr|td)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/ *\n[\s\n]*/g, '\n').trim();
const norm = (s) => decode(String(s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
  if (!r.ok) return { status: r.status, url: r.url || url, html: null };
  return { status: 200, url: r.url || url, html: await r.text() };
}

const slugify = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* Candidate URLs, most specific first. Dropping trailing words is deliberately aggressive —
 * "CONTROL Resonant" must still reach plain "control" for games whose edition suffix is not
 * in the guide's slug. It is safe to be aggressive here ONLY because verify() rejects a page
 * whose trophy names do not match. */
const EDITION = /^(edition|remastered|remaster|definitive|ultimate|deluxe|complete|goty|hd|ps4|ps5|vr|collection|bundle|trilogy|anniversary|enhanced|directors|cut|gold|standard|intergrade|reloaded)$/i;
function candidates(title) {
  const words = slugify(title).split('-').filter(Boolean);
  const stems = new Set();
  for (let n = words.length; n >= 1; n--) {
    const s = words.slice(0, n).join('-');
    if (s) stems.add(s);
    // only keep peeling while the trailing word is an edition marker or we are on the first pass
    if (n < words.length && !EDITION.test(words[n])) break;
  }
  if (words.length > 1) stems.add(words.slice(0, words.length - 1).join('-'));
  const urls = [];
  for (const s of stems) {
    urls.push(`https://www.powerpyx.com/${s}-trophy-guide-roadmap/`);
    urls.push(`https://www.powerpyx.com/${s}-trophy-guide/`);
  }
  return urls.slice(0, 8);
}

/* Discovery runs off PowerPyx's own sitemap, not their site search.
 * Their WordPress search returns `search-no-results` even for games they clearly cover
 * (try "Skyrim"), and the only links on that page come from the "recent guides" sidebar —
 * so scoring those handed every game the same wrong answer (Clive Barker's Hellraiser).
 * The sitemap is one cached fetch and is authoritative: if a game is not in it, PowerPyx
 * has not written a guide, which is a real answer rather than a dead link. */
const SLUG_CACHE = path.join(ROOT, 'tools', '.powerpyx-slugs.json');
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function slugIndex() {
  const cached = readJson(SLUG_CACHE, null);
  if (cached && cached.guides && cached.fetchedAt && (Date.now() - Date.parse(cached.fetchedAt)) < INDEX_TTL_MS && !flag('--refresh-index')) return cached.guides;
  process.stdout.write('building PowerPyx guide index from sitemap… ');
  const idx = await get('https://www.powerpyx.com/sitemap_index.xml');
  if (!idx.html) { console.log('failed; falling back to cache'); return (cached && cached.guides) || []; }
  const maps = [...idx.html.matchAll(/<loc>([^<]*post-sitemap\d+\.xml)<\/loc>/g)].map((m) => m[1]);
  const urls = new Set();
  for (const m of maps) {
    const x = await get(m);
    if (x.html) for (const u of [...x.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((a) => a[1])) urls.add(u);
    await sleep(400);
  }
  /* PowerPyx uses TWO url schemes and the older one is easy to miss:
   *   modern  https://www.powerpyx.com/<slug>-trophy-guide-roadmap/
   *   legacy  https://www.powerpyx.com/guides/<slug>-trophy-guide.html   (e.g. Fallout 4)
   * Matching only the modern one dropped every pre-2017 guide.
   * `-achievement-guide` posts are Xbox-only games with no PS trophy list, so they stay out. */
  const guides = [...urls].filter((u) => /^https:\/\/www\.powerpyx\.com\/[a-z0-9-]+-trophy-guide(?:-roadmap)?\/?$/i.test(u)
    || /^https:\/\/www\.powerpyx\.com\/guides?\/[a-z0-9-]+-trophy-guide\.html$/i.test(u));
  writeJson(SLUG_CACHE, { fetchedAt: new Date().toISOString(), guides });
  console.log(`${guides.length} guides`);
  return guides;
}

/** Rank indexed guide URLs against a title by word overlap. Cheap, local, no extra requests. */
const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'to', 'in', 'on', 'at', 'for', 'vs', 'with', 'my', 'is', 'it', 'edition', 'remastered', 'remaster', 'hd', 'ps4', 'ps5', 'vr', 'deluxe', 'ultimate', 'complete', 'definitive', 'goty', 'collection', 'bundle', 'anniversary', 'enhanced']);
const NUMERIC = /^(?:\d+|i{1,3}|iv|v|vi{1,3}|ix|x{1,3}|xi{1,3}|xiv|xv|xvi{1,3}|xix|xx)$/i;
const tokens = (t) => slugify(t).split('-').filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
function rankIndexed(title, guides) {
  const want = tokens(title);
  if (!want.length) return [];
  const wantSet = new Set(want);
  const wantNums = new Set(want.filter((w) => NUMERIC.test(w)));
  const scored = [];
  for (const u of guides) {
    const slug = (u.match(/powerpyx\.com\/(?:guides?\/)?(.+?)-trophy-guide/) || [])[1];
    if (!slug) continue;
    const words = tokens(slug);
    if (!words.length) continue;
    let shared = 0;
    for (const w of new Set(words)) if (wantSet.has(w)) shared++;
    if (!shared) continue;
    // reward covering the title, penalise slugs that pile on extra words
    const cover = shared / wantSet.size;
    const precision = shared / new Set(words).size;
    let score = cover * 0.7 + precision * 0.3;
    /* A sequel number is the most load-bearing token in a game title: "Resident Evil 4" and
     * "Resident Evil 3" differ by one character and are completely different trophy lists.
     * So a conflicting number is close to disqualifying, and a matching one is a real signal. */
    const slugNums = new Set(words.filter((w) => NUMERIC.test(w)));
    if (wantNums.size || slugNums.size) {
      const agree = [...wantNums].some((n) => slugNums.has(n));
      const conflict = wantNums.size && slugNums.size && !agree;
      if (conflict) score *= 0.25;
      else if (agree) score = Math.min(1, score + 0.15);
      else score *= 0.8;   // one side numbered, the other not: weaker, not fatal
    }
    scored.push({ u, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score >= 0.34).slice(0, 4).map((x) => x.u);
}

const looksLikeGuide = (html) => /Estimated trophy difficulty/i.test(html) || /Approximate amount of time to (platinum|100%)/i.test(html);

/** The gate. Returns {covered, total, ratio, ok}. */
function verify(html, names) {
  const flat = norm(strip(html));
  const total = names.length;
  let covered = 0;
  for (const n of names) { const k = norm(n); if (k.length > 2 && flat.includes(k)) covered++; }
  const ratio = total ? covered / total : 0;
  const ok = total === 0 ? false : (covered >= 3 && ratio >= 0.5) || (total <= 4 && ratio >= 0.9);
  return { covered, total, ratio: Math.round(ratio * 100) / 100, ok };
}

/* Per-trophy extraction. PowerPyx's guide table is:
 *   <tr><td><img></td><td>NAME<a id="anchor"></a><br>Description</td><td><img title="Gold"></td></tr>
 *   <tr><td colspan="3">...the actual advice...</td></tr>
 * so a 3-cell row names the trophy and the colspan row that follows explains it. */
function extractTrophies(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const out = {};
  for (let i = 0; i < rows.length; i++) {
    const cells = [...rows[i].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 2) continue;
    const isColspan = /colspan/i.test(rows[i]);
    if (isColspan) continue;
    const nameCell = cells[1] ? cells[1][1] : '';
    const anchor = (nameCell.match(/id=["']([^"']+)["']/) || [])[1] || null;
    const parts = strip(nameCell).split('\n').filter(Boolean);
    const name = parts[0];
    if (!name || name.length > 120) continue;
    const desc = parts.slice(1).join(' ') || null;
    const type = ((cells[2] ? cells[2][1] : '').match(/title=["'](Platinum|Gold|Silver|Bronze)/i) || [])[1] || null;
    // the explanation is the next colspan row, if there is one
    let text = null;
    const next = rows[i + 1];
    if (next && /colspan/i.test(next)) {
      const c = next.match(/<td[^>]*colspan[^>]*>([\s\S]*?)<\/td>/i);
      if (c) { const t = strip(c[1]); if (t && t.length > 2) text = t; }
    }
    out[name] = { name, desc, type: type ? type.toLowerCase() : null, anchor, text };
  }
  return out;
}

function parseHeader(html) {
  const full = strip(html);
  const start = Math.max(0, full.search(/Trophy Roadmap|Estimated trophy difficulty/i));
  const rest = full.slice(start);
  const endRel = rest.search(/\n\s*(Introduction|Step 1|Stage 1)/i);
  const text = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 5000);
  const line = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const num = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
  const range = (s) => { const n = (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number); return n.length ? { min: Math.min(...n.slice(0, 2)), max: Math.max(...n.slice(0, 2)) } : null; };
  const time = line(/Approximate amount of time to platinum\s*:?\s*([^\n]+)/i) || line(/Approximate amount of time to 100%\s*:?\s*([^\n]+)/i);
  const h = range(time);
  const diff = line(/Estimated trophy difficulty\s*:?\s*([^\n]+)/i);
  return {
    difficulty: num(diff), difficultyRaw: diff,
    hoursMin: h ? h.min : null, hoursMax: h ? h.max : null, timeRaw: time,
    offline: num(line(/Offline Trophies\s*:?\s*([^\n]+)/i)),
    online: num(line(/Online Trophies\s*:?\s*([^\n]+)/i)),
    missables: num(line(/Number of missable trophies\s*:?\s*([^\n]+)/i)),
    missablesRaw: line(/Number of missable trophies\s*:?\s*([^\n]+)/i),
    glitched: num(line(/Glitched trophies\s*:?\s*([^\n]+)/i)),
    glitchedRaw: line(/Glitched trophies\s*:?\s*([^\n]+)/i),
    hardest: line(/Hardest Trophy\s*:?\s*([^\n]+)/i),
    playthroughs: num(line(/Minimum Playthroughs?\s*:?\s*([^\n]+)/i)),
    playthroughsRaw: line(/Minimum Playthroughs?\s*:?\s*([^\n]+)/i),
    difficultyAffectsRaw: line(/Does difficulty affect trophies\s*\??\s*:?\s*([^\n]+)/i),
    freeRoam: line(/Free-?Roam\s*\/\s*Level Select after Story\s*\??\s*:?\s*([^\n]+)/i),
  };
}

// ---------------- main ----------------
const progress = readJson(path.join(DATA, 'progress.json'), {});
const enriched = readJson(path.join(DATA, 'enriched.json'), {});
const raw = readJson(RAW_PATH, {});

/* Misses are remembered. Without this, every scheduled run re-probes the same games that
 * PowerPyx does not cover, burning requests on a guaranteed negative. Re-checked after 45
 * days, because they do publish guides for older games occasionally. */
const MISS_PATH = path.join(ROOT, 'tools', '.powerpyx-misses.json');
const misses = readJson(MISS_PATH, {});
const MISS_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const skipUntil = (k) => {
  const m = misses[k];
  if (!m || flag('--game') || flag('--retry-misses')) return false;
  return (Date.now() - Date.parse(m.at)) < MISS_TTL_MS;
};
const noteMiss = (k, why) => { misses[k] = { at: new Date().toISOString(), why }; writeJson(MISS_PATH, misses); };

const trophyNames = (g) => [...(g.unearned || []).map((t) => t && t.name), ...(g.earned || []).map((t) => (t && t.name) || (typeof t === 'string' ? t : null))].filter(Boolean);

let keys = [];
if (opt('--game', null)) {
  const want = norm(opt('--game'));
  keys = Object.keys(progress).filter((k) => norm(k) === want || norm(progress[k].title) === want);
  if (!keys.length) keys = Object.keys(progress).filter((k) => norm(k).includes(want));
} else if (flag('--retry-ta')) {
  keys = Object.keys(progress).filter((k) => {
    const e = enriched[k] && enriched[k].guide;
    return e && e.source === 'trueachievements' && !raw[k] && trophyNames(progress[k]).length;
  });
} else if (flag('--auto')) {
  /* Priority is "what will you actually play next", not "what has the most trophies left".
   * Sorting by trophy count fed the first scheduled run Elder Scrolls Online, Gems of War
   * and Overwatch: live-service games with no guide and no chance of being finished.
   * The app's own scoring model already ranks playability, so reuse it. */
  const n = Number(opt('--auto', 20)) || 20;
  let scorer = null;
  try { scorer = (await import(new URL('../js/scoring.js', import.meta.url))).default || null; } catch { scorer = null; }
  if (scorer && !scorer.assess) scorer = null;
  const asOf = new Date();
  const score = (g) => {
    if (!scorer) return (g.unearned || []).length;
    try { return scorer.assess({ ...g, earnedCount: (g.earned || []).length }, { dataAsOf: asOf }).score || 0; } catch { return 0; }
  };
  keys = Object.keys(progress)
    .filter((k) => (progress[k].unearned || []).length && !raw[k] && trophyNames(progress[k]).length && !skipUntil(k))
    .map((k) => ({ k, s: score(progress[k]) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.k);
} else {
  console.error('usage: --game "<title>" | --auto <n> | --retry-ta');
  process.exit(2);
}
if (flag('--limit')) keys = keys.slice(0, Number(opt('--limit', keys.length)) || keys.length);

const INDEX = await slugIndex();
console.log(`${keys.length} game(s) to try · ${INDEX.length} guides in the PowerPyx index\n`);
let ok = 0, rejected = 0, missing = 0;
for (const key of keys) {
  const g = progress[key];
  const names = trophyNames(g);
  const title = g.title || key;
  /* The index is authoritative, so consult it FIRST and skip the game when it has no
   * match. Blind slug probing stays only as a safety net for when the sitemap fetch failed,
   * because guessing 8 URLs per game costs 12s and almost always 404s. */
  let urls = INDEX.length ? rankIndexed(title, INDEX) : candidates(title);
  const tried = new Set();
  let accepted = null, best = null;
  if (!urls.length) { console.log(`· ${title} — no PowerPyx guide`); missing++; continue; }
  for (let pass = 0; pass < 2 && !accepted; pass++) {
    if (pass === 1) { urls = candidates(title).filter((u) => !tried.has(u)).slice(0, 2); if (!urls.length) break; }
    for (const u of urls) {
      if (tried.has(u)) continue;
      tried.add(u);
      const r = await get(u);
      await sleep(DELAY);
      if (!r.html || !looksLikeGuide(r.html)) continue;
      const v = verify(r.html, names);
      if (!best || v.ratio > best.v.ratio) best = { url: r.url, v };
      if (v.ok) { accepted = { url: r.url, html: r.html, v }; break; }
    }
  }
  if (!accepted) {
    if (best) { console.log(`✗ ${title} — found a guide but it covers only ${Math.round(best.v.ratio * 100)}% of the trophy names (${best.url}) — not stored`); rejected++; noteMiss(key, `best match covered ${Math.round(best.v.ratio * 100)}%`); }
    else { console.log(`· ${title} — no PowerPyx guide`); missing++; noteMiss(key, 'not in the sitemap index'); }
    continue;
  }
  const trophies = extractTrophies(accepted.html);
  const withText = Object.values(trophies).filter((t) => t.text).length;
  raw[key] = {
    source: 'powerpyx', url: accepted.url, title, fetchedAt: new Date().toISOString(),
    coverage: accepted.v, header: parseHeader(accepted.html), trophies,
  };
  writeJson(RAW_PATH, raw);
  if (misses[key]) { delete misses[key]; writeJson(MISS_PATH, misses); }
  ok++;
  console.log(`✓ ${title} — ${Object.keys(trophies).length} trophies, ${withText} with written advice (${Math.round(accepted.v.ratio * 100)}% name match)`);
}
console.log(`\nstored ${ok} · rejected ${rejected} (wrong game) · none found ${missing}`);
console.log(`raw -> data/powerpyx-raw.json (${Object.keys(raw).length} games total)`);
