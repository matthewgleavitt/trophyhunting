#!/usr/bin/env node
/**
 * build-private.mjs — assemble dist-private/, the full-fat build for your own eyes.
 *
 * Identical to the public site plus data/guides-full.json (the guide authors' written
 * solutions). This directory must only ever be served from somewhere access-controlled —
 * it is gitignored, and the deploy script puts it behind Cloudflare Access.
 *
 *   node tools/build-private.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-private');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

const copy = (rel) => {
  const src = path.join(ROOT, rel), dst = path.join(OUT, rel);
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return fs.statSync(src).isDirectory()
    ? fs.readdirSync(src).reduce((s, f) => s + fs.statSync(path.join(src, f)).size, 0)
    : fs.statSync(src).size;
};

let bytes = 0;
for (const rel of ['index.html', 'css', 'js']) bytes += copy(rel);
const DATA_FILES = ['progress.slim.json', 'enriched.json', 'overrides.json', 'guides.json',
                    'library.json', 'sync-meta.json', 'guides-full.json'];
let withText = 0;
for (const f of DATA_FILES) {
  const n = copy(path.join('data', f));
  bytes += n;
  if (f === 'guides-full.json' && n) {
    withText = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'))).length;
  }
}

// A plain marker so it is obvious which build you are looking at.
fs.writeFileSync(path.join(OUT, 'BUILD.txt'),
  `private build\n${new Date().toISOString()}\nguide write-ups for ${withText} games\n`);

console.log(`dist-private/ built: ${(bytes / 1048576).toFixed(2)} MB, guide write-ups for ${withText} games`);
if (!withText) console.log('note: data/guides-full.json is empty — run  npm run guide -- "<game>"  first');
console.log('deploy: npx wrangler pages deploy dist-private --project-name trophy-tracker');
