#!/usr/bin/env node
/**
 * stamp-assets.mjs — rewrite index.html's ?v= query on css/js to a content hash.
 *
 * A hand-written version string only works if you remember to bump it. Hashing the
 * files means a changed asset always gets a new URL and a stale cache is impossible.
 *
 *   node tools/stamp-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
let html = fs.readFileSync(INDEX, 'utf8');
let changed = 0;

html = html.replace(/(href|src)="\.\/((?:css|js)\/[A-Za-z0-9._-]+)(?:\?v=[A-Za-z0-9]+)?"/g, (m, attr, rel) => {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.warn(`  missing: ${rel}`); return m; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  changed++;
  return `${attr}="./${rel}?v=${h}"`;
});

fs.writeFileSync(INDEX, html);
console.log(`stamped ${changed} asset links in index.html with content hashes`);
