#!/usr/bin/env node
/**
 * fetch-guide.mjs — pull ONE game's trophy guide, on demand.
 *
 * Why one at a time: PSNProfiles allows about two guide pages per session and then
 * returns 403 at the edge. That is a deliberate defence against bulk downloading, and
 * fetching their whole guide corpus would be working around it. Fetching the guide for a
 * game you are about to play is just reading a page — proportionate, and it means the
 * local library grows to cover exactly the games you care about.
 *
 *   npm run guide -- "mega man 11"        one game (key or title, case-insensitive)
 *   npm run guide -- --starred            every game you have starred (paced)
 *   npm run guide -- --list               show what is already stored
 *
 * Writes data/guides-full.json — gitignored, personal reference only, never published.
 * Run tools/merge-guides.mjs afterwards to refresh the public facts tier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/Users/mattmini/Documents/Claude/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'psnp-guides-raw.json');
const argv = process.argv.slice(2);
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const progress = read(path.join(DATA, 'progress.json'), {});
const raw = read(RAW, {});

if (argv.includes('--list')) {
  const have = Object.entries(progress).filter(([, g]) => g && g.psnpGuide && raw[g.psnpGuide]);
  console.log(`${have.length} guides stored locally:`);
  for (const [k, g] of have) console.log(`  ${g.title || k}  (${Object.keys(raw[g.psnpGuide].text || {}).length} sections)`);
  process.exit(0);
}

let targets = [];
if (argv.includes('--starred')) {
  console.error('--starred needs your starred list; export it from the app (Export button) and pass titles instead.');
  process.exit(2);
} else {
  const q = argv.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!q) { console.error('usage: npm run guide -- "game name"   |   --list'); process.exit(2); }
  const hits = Object.entries(progress).filter(([k, g]) =>
    norm(k) === norm(q) || norm(g.title) === norm(q) || norm(k).includes(norm(q)) || norm(g.title).includes(norm(q)));
  if (!hits.length) { console.error(`no game matches "${q}"`); process.exit(1); }
  if (hits.length > 4) { console.error(`"${q}" matches ${hits.length} games — be more specific:`); hits.slice(0, 8).forEach(([, g]) => console.error('  ' + g.title)); process.exit(1); }
  targets = hits;
}

const EXTRACT = function (url) {
  return (async () => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return { __status: r.status };
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const txt = doc.body.textContent.replace(/\s+/g, ' ');
    const grab = (re) => { const m = txt.match(re); return m ? m[1] : null; };
    const num = (v) => (v == null ? null : Number(v));
    const tags = {};
    for (const tr of doc.querySelectorAll('tr')) {
      const tag = tr.querySelector('span.tag'); if (!tag) continue;
      const label = tag.textContent.trim();
      if (!/^(missable|unmissable|online required|online|difficulty specific|stackable|buggy|glitched|time consuming|multiple playthroughs)$/i.test(label)) continue;
      for (const a of tr.querySelectorAll('a[href^="#"]')) {
        const n = a.textContent.trim(); if (!n || n.length > 90) continue;
        tags[n] = tags[n] || { tags: [], anchor: a.getAttribute('href') };
        if (!tags[n].tags.includes(label)) tags[n].tags.push(label);
      }
    }
    const text = {};
    for (const e of [...doc.querySelectorAll('[id]')].filter((x) => /^\d+-/.test(x.id))) {
      const head = (e.querySelector('a.title,.trophy-name,b,strong') || {}).textContent;
      let body = '', n = e.nextElementSibling, guard = 0;
      while (n && guard++ < 14) { if (n.id && /^\d+-/.test(n.id)) break; body += ' ' + (n.innerText || n.textContent || ''); n = n.nextElementSibling; }
      let whole = ((e.innerText || e.textContent || '') + ' ' + body).replace(/\s+/g, ' ').trim();
      whole = whole.replace(/^.*?(?:Ultra Rare|Very Rare|Uncommon|Common|Rare)\s*/i, '').trim();
      if (whole.length > 40) text[e.id] = { n: (head || '').trim() || null, t: whole.slice(0, 4000) };
    }
    const hrs = num(grab(/([\d.]+)(?:\s*-\s*[\d.]+)?\s*Hours?/i));
    return {
      difficulty: num(grab(/([\d.]+)\s*\/\s*10\s*Difficulty/i)),
      playthroughs: num(grab(/(\d+)\s*Playthroughs?/i)),
      hoursMin: hrs, hoursMax: num((txt.match(/[\d.]+\s*-\s*([\d.]+)\s*Hours?/i) || [])[1]) ?? hrs,
      tags, text, textCount: Object.keys(text).length,
    };
  })();
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://psnprofiles.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await sleep(1200);

let ok = 0;
for (const [key, g] of targets) {
  if (!g.psnpGuide) { console.log(`${g.title || key}: no PSNProfiles guide exists`); continue; }
  try {
    const r = await page.evaluate(EXTRACT, g.psnpGuide);
    if (!r || r.__status) { console.log(`${g.title || key}: HTTP ${r && r.__status} — PSNProfiles limits guide pages per session; wait a few minutes and retry`); continue; }
    raw[g.psnpGuide] = r; ok++;
    console.log(`${g.title || key}: ${r.textCount} sections, ${Object.keys(r.tags).length} tagged trophies, ${r.difficulty ?? '?'}/10, ${r.hoursMin ?? '?'}h`);
  } catch (e) { console.log(`${g.title || key}: ${String(e.message).slice(0, 70)}`); }
  await sleep(2500);
}
fs.writeFileSync(RAW, JSON.stringify(raw));
await browser.close();
console.log(`\n${ok} fetched. ${Object.keys(raw).length} guides stored. Next: node tools/merge-guides.mjs && node tools/build-slim.mjs`);
