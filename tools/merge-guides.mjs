#!/usr/bin/env node
/**
 * merge-guides.mjs — split scraped PSNProfiles guide data into two tiers.
 *
 *   PUBLIC  (committed):  data/enriched.json + progress.json
 *       Facts only — difficulty, hours, playthroughs, per-trophy Missable/Online flags,
 *       and a deep-link anchor per trophy. Facts are not copyrightable and linking is not
 *       republishing, so this is safe on a public site.
 *
 *   PRIVATE (gitignored): data/guides-full.json
 *       The authors' written solutions, for personal reference only. Never committed,
 *       never served from the public site. See HANDOFF.md for private hosting.
 *
 *   node tools/merge-guides.mjs            (expects data/psnp-guides-raw.json)
 *   node tools/merge-guides.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SRC = path.join(DATA, 'psnp-guides-raw.json');
const PROGRESS = path.join(DATA, 'progress.json');
const FULL = path.join(DATA, 'guides-full.json');
const DRY = process.argv.includes('--dry-run');
const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

const raw = read(SRC, null);
if (!raw) { console.error('data/psnp-guides-raw.json missing — run the guide scrape first'); process.exit(2); }
const progress = read(PROGRESS, {});

// guide url -> game key
const byGuide = {};
for (const [key, g] of Object.entries(progress)) if (g && g.psnpGuide) byGuide[g.psnpGuide] = key;

let facts = 0, texts = 0, orphan = 0, textChars = 0;
const full = {};
for (const [guideUrl, v] of Object.entries(raw)) {
  const key = byGuide[guideUrl];
  if (!key) { orphan++; continue; }
  const g = progress[key];

  // ---- public tier: facts + anchors onto progress.json ----
  if (v.difficulty != null || v.hoursMin != null || v.playthroughs != null) {
    g.psnpGuideFacts = {
      source: 'psnprofiles', url: 'https://psnprofiles.com' + guideUrl,
      difficulty: v.difficulty, hoursMin: v.hoursMin, hoursMax: v.hoursMax, playthroughs: v.playthroughs,
    };
    facts++;
  }
  if (v.tags && Object.keys(v.tags).length) {
    g.psnpTrophyTags = v.tags;
    g.psnpGuideAnchors = Object.fromEntries(Object.entries(v.tags).filter(([, x]) => x && x.anchor).map(([n, x]) => [n, x.anchor]));
  }

  // ---- private tier: the written solutions ----
  if (v.text && Object.keys(v.text).length) {
    // match a section to a trophy by name where we can; keep the rest as general sections
    const names = (g.unearned || []).concat(g.earned || []).map((t) => t && t.name).filter(Boolean);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const byTrophy = {}, general = [];
    for (const [id, sec] of Object.entries(v.text)) {
      const hit = names.find((n) => norm(sec.n) === norm(n)) ||
                  names.find((n) => norm(id).endsWith(norm(n)) && norm(n).length > 5);
      if (hit) byTrophy[hit] = { text: sec.t, anchor: '#' + id };
      else general.push({ id, title: sec.n || id.replace(/^\d+-/, '').replace(/-/g, ' '), text: sec.t });
      textChars += (sec.t || '').length;
    }
    full[key] = { url: 'https://psnprofiles.com' + guideUrl, trophies: byTrophy, sections: general.slice(0, 12) };
    texts++;
  }
}

console.log(JSON.stringify({ guides: Object.keys(raw).length, factsApplied: facts, withText: texts, unmatchedGuides: orphan, textMB: +(textChars / 1048576).toFixed(2) }, null, 2));
if (DRY) { console.log('dry run — nothing written'); process.exit(0); }
fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 1) + '\n');
fs.writeFileSync(FULL, JSON.stringify(full));
console.log('wrote data/progress.json (public facts) and data/guides-full.json (private, gitignored)');
console.log('next: node tools/build-slim.mjs && node tools/stamp-assets.mjs');
