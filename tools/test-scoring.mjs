// node tools/test-scoring.mjs — exercise js/scoring.js against real data + a few synthetic rarity cases
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const S = require('../js/scoring.js');
const progress = JSON.parse(fs.readFileSync(new URL('../data/progress.json', import.meta.url)));
const enriched = JSON.parse(fs.readFileSync(new URL('../data/enriched.json', import.meta.url)));
const overrides = JSON.parse(fs.readFileSync(new URL('../data/overrides.json', import.meta.url)));
const dataAsOf = Object.values(progress).flatMap((g) => (g.earned || []).map((t) => S.parseDate(t.date))).filter(Boolean).sort((a, b) => b - a)[0];
const entries = Object.entries(progress).filter(([, g]) => (g.unearned || []).length).map(([k, g]) => {
  const e = enriched[k] || {}, o = overrides[k] || {};
  const hasPlatInfo = [...(g.earned || []), ...(g.unearned || [])].some((t) => t.type);
  return [k, { ...g, guide: e.guide && e.guide.source ? e.guide : null,
    platDead: typeof o.platDead === 'boolean' ? o.platDead : e.platDead,
    deadReason: o.deadReason || e.deadReason,
    trophyMeta: { ...(e.trophies || {}), ...(o.trophies || {}) },
    hasPlatinum: hasPlatInfo ? [...(g.earned || []), ...(g.unearned || [])].some((t) => t.type === 'platinum') : null }];
});
console.log(`data as of ${dataAsOf.toISOString().slice(0, 10)}; ${entries.length} unfinished games\n`);
const { lanes } = S.buildLanes(entries, { dataAsOf });
for (const l of lanes) {
  console.log(`${l.title} (${l.items.length})${l.sub ? ' — ' + l.sub : ''}`);
  for (const x of l.items.slice(0, 6)) console.log(`   ${x.name.padEnd(34)} left=${String(x.a.left).padStart(2)} ~${String(x.a.hours).padStart(5)}h  diff=${x.a.difficulty}  score=${x.a.score}`);
}
console.log('\n--- explain: horizon forbidden west ---');
const hfw = entries.find(([k]) => k === 'horizon forbidden west');
if (hfw) { const a = S.assess(hfw[1], { dataAsOf }); console.log(a.hours + 'h, diff ' + a.difficulty + ', needsPlaythrough=' + a.needsPlaythrough); a.reasons.forEach((r) => console.log('  • ' + r)); }
console.log('\n--- synthetic: mega man 11 with PSNProfiles rarities (0.3%, 0.3%, 3.9%, 3.7%) vs an easy game (4 left @ 60/45/35/22%) ---');
const mm = JSON.parse(JSON.stringify(progress['mega man 11']));
mm.unearned = mm.unearned.map((t, i) => ({ ...t, rarity: [0.3, 0.3, 3.9, 3.7][i] ?? 2, type: 'silver' }));
mm.hasPlatinum = true; mm.earned = [{ name: 'plat', type: 'platinum', rarity: 3.59 }, ...mm.earned];
const easy = { title: 'Easy Game', earned: Array.from({ length: 40 }, () => ({})), unearned: [60, 45, 35, 22].map((r, i) => ({ name: 'T' + i, desc: 'Do a thing', rarity: r, type: 'bronze' })), hasPlatinum: true, lastPlayed: dataAsOf.toISOString() };
for (const [n, g] of [['mega man 11 (4 left, ultra rare)', mm], ['easy game (4 left, common)', easy]]) { const a = S.assess(g, { dataAsOf }); console.log(`${n}: ~${a.hours}h diff=${a.difficulty} easyGain=${a.easyGain} score=${a.score}`); a.reasons.slice(0, 3).forEach((r) => console.log('  • ' + r)); }
