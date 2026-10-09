#!/usr/bin/env node
/**
 * scrape-guides.mjs — fetch PSNProfiles trophy guides with a real headless browser.
 *
 * PSNProfiles blocks plain HTTP (Cloudflare) but a real browser is fine, and Playwright is
 * far more reliable than driving a visible pane: this writes incrementally to disk and
 * resumes, so nothing is lost if it is interrupted.
 *
 * Output: data/psnp-guides-raw.json  (gitignored — contains guide authors' written text)
 * Then:   node tools/merge-guides.mjs   splits it into public facts + private text.
 *
 *   node tools/scrape-guides.mjs              resume (skips guides already saved)
 *   node tools/scrape-guides.mjs --limit 20
 *   node tools/scrape-guides.mjs --fresh      ignore what is already saved
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/Users/mattmini/Documents/Claude/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'psnp-guides-raw.json');
const argv = process.argv.slice(2);
const LIMIT = Number((argv[argv.indexOf('--limit') + 1]) || 0) || 0;
const FRESH = argv.includes('--fresh');
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const progress = read(path.join(DATA, 'progress.json'), {});
const wanted = [...new Set(Object.values(progress)
  .filter((g) => g && (g.unearned || []).length && g.psnpGuide)
  .map((g) => g.psnpGuide))];
const results = FRESH ? {} : read(OUT, {});
let todo = wanted.filter((u) => !results[u]);
if (LIMIT) todo = todo.slice(0, LIMIT);
console.log(`${wanted.length} guides referenced; ${Object.keys(results).length} already saved; fetching ${todo.length}`);
if (!todo.length) process.exit(0);

// Runs inside the page: same-origin fetch is fast and keeps Cloudflare happy.
// Must be a real function — Playwright evaluates a *string* as an expression and would
// never call it (that silently returned undefined for every guide).
function EXTRACT(url) {
  return (async () => {
    const r = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html,application/xhtml+xml', 'Referer': location.origin + '/' } });
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
      hoursMin: hrs,
      hoursMax: num((txt.match(/[\d.]+\s*-\s*([\d.]+)\s*Hours?/i) || [])[1]) ?? hrs,
      tags, text, textCount: Object.keys(text).length,
    };
  })();
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://psnprofiles.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });

let spacing = 2000, done = 0, failed = 0;   // Cloudflare is stricter with a fresh session
for (const [i, url] of todo.entries()) {
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    try {
      const r = await page.evaluate(EXTRACT, url);
      if (r && (r.__status === 429 || r.__status === 403)) { spacing = Math.min(12000, Math.round(spacing * 1.6)); await sleep(r.__status === 403 ? 15000 : 25000); continue; }
      if (!r || r.__status) throw new Error('HTTP ' + (r && r.__status));
      results[url] = r; ok = true; done++;
      if (done % 5 === 0) { fs.writeFileSync(OUT, JSON.stringify(results)); spacing = Math.max(1200, Math.round(spacing * 0.9)); }
      if (done % 25 === 0 || i === todo.length - 1) console.log(`  [${i + 1}/${todo.length}] ${done} saved, ${failed} failed, spacing ${spacing}ms`);
    } catch (e) {
      if (attempt === 3) { failed++; console.log(`  FAILED ${url}: ${String(e.message).slice(0, 60)}`); }
      else await sleep(3000);
    }
  }
  await sleep(spacing);
}
fs.writeFileSync(OUT, JSON.stringify(results));
await browser.close();
const chars = Object.values(results).reduce((s, g) => s + Object.values(g.text || {}).reduce((a, x) => a + (x.t || '').length, 0), 0);
console.log(`\ndone: ${Object.keys(results).length} guides saved, ${failed} failed, ${(chars / 1048576).toFixed(2)} MB of guide text`);
