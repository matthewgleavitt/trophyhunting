#!/usr/bin/env node
/**
 * trim-public-prose.mjs — keep the FACT, drop the paragraph, in public files.
 *
 * data/enriched.json is committed to a public repo. Numbers and trophy names are facts
 * and fine there. But several guide fields carry the author's explanatory prose at
 * paragraph length (one `missablesRaw` runs 572 characters), and that is PowerPyx's
 * writing, not a fact. So: the public copy keeps the leading factual clause, and the
 * full sentence moves to data/guides-full.json, which is gitignored.
 *
 *   node tools/trim-public-prose.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DRY = process.argv.includes('--dry-run');
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const write = (p, v) => { if (!DRY) fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

const PROSE_FIELDS = ['missablesRaw', 'glitchedRaw', 'difficultyRaw', 'playthroughsRaw', 'freeRoam', 'hardest', 'timeRaw', 'difficultyAffectsRaw'];
const CAP = 120;

/** The factual head of a guide line: the count/answer plus the trophy names, no explanation. */
function factualHead(s) {
  let t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= CAP) return t;
  // cut at the first real sentence end, or the first parenthetical explanation
  const cut = t.search(/(?<=[a-z0-9)\]])\.\s+[A-Z]|\s–\s|\s—\s/);
  if (cut > 12 && cut <= CAP) return t.slice(0, cut).trim().replace(/[,;:]$/, '');
  const paren = t.indexOf(' (');
  if (paren > 12 && paren <= CAP) return t.slice(0, paren).trim();
  // last resort: clip on a word boundary and say it is clipped
  return t.slice(0, t.lastIndexOf(' ', CAP) > 12 ? t.lastIndexOf(' ', CAP) : CAP).trim() + '…';
}

const enriched = read(path.join(DATA, 'enriched.json'), {});
const full = read(path.join(DATA, 'guides-full.json'), {});
let trimmed = 0, saved = 0, chars = 0;

for (const [key, e] of Object.entries(enriched)) {
  const g = e && e.guide;
  if (!g) continue;
  for (const f of PROSE_FIELDS) {
    const v = g[f];
    if (typeof v !== 'string' || v.length <= CAP) continue;
    const head = factualHead(v);
    if (head === v) continue;
    // preserve the full line privately so nothing is actually lost
    full[key] = full[key] || { trophies: {} };
    full[key].guideLines = full[key].guideLines || {};
    full[key].guideLines[f] = v;
    chars += v.length - head.length;
    g[f] = head;
    trimmed++; saved++;
  }
}

write(path.join(DATA, 'enriched.json'), enriched);
write(path.join(DATA, 'guides-full.json'), full);
console.log(`${DRY ? '[dry run] ' : ''}trimmed ${trimmed} prose field(s) in the public file, ${(chars / 1024).toFixed(1)} KB of authored text moved to the private one`);
