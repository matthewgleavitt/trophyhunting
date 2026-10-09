/* =====================================================================
   scoring.js — Finish Cost model for the trophy tracker
   ---------------------------------------------------------------------
   Pure functions, no DOM. Works in the browser (global `TrophyScoring`)
   and in Node (module.exports) so tools/test-scoring.mjs can exercise it.

   Inputs per game (schema v2 from tools/psn-sync.mjs; v1 degrades gracefully):
     unearned[]  { name, desc, type, rarity (% of players), tier }
     earned[]    { ..., date (ISO) }  — only used for lastPlayed fallback
     lastPlayed  ISO string           — PSN lastUpdatedDateTime
     hasPlatinum, platinumEarned
     timeNormal / timeHastily / timePlat  "43.7H" style strings (HLTB-ish)
     guide       { difficulty, hoursMin, hoursMax, playthroughs, missables,
                   online, glitched, difficultyAffects, serverShutdownMentioned }
     platDead, deadReason   manual override (data/enriched.json)
     trophyMeta  { [trophyName]: { tags: [...] } }  manual per-trophy tags

   Outputs: assess(game) → {
     dead, deadReason, hours, hoursLow, hoursHigh, difficulty, flags,
     rarestRemaining, easeTier, needsPlaythrough, playthroughHours,
     value, score, momentum, reasons[]
   }
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrophyScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- helpers ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  const log2 = (x) => Math.log(x) / Math.LN2;

  /** "43.7H" | "25-40h" | "127 hours" → { min, max, avg } hours, or null. */
  function parseHours(str) {
    if (str == null) return null;
    const s = String(str).toLowerCase().trim();
    if (!s || /^-\s*\d/.test(s) || /^(na|n\/a|unknown|null)$/.test(s)) return null;
    const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => isFinite(n) && n >= 0);
    if (!nums.length) return null;
    const min = Math.min(nums[0], nums[1] ?? nums[0]);
    const max = Math.max(nums[0], nums[1] ?? nums[0]);
    return { min, max, avg: (min + max) / 2 };
  }

  /** Tolerant date parser: ISO, or PocketPSN's "Sep. 6th, 202310:51:20 PM EDT". */
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v);
    const iso = Date.parse(s);
    if (!isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(iso);
    const m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()] != null) return new Date(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);   // local date, no TZ shift
    return isNaN(iso) ? null : new Date(iso);
  }

  function lastPlayedOf(g) {
    const d = parseDate(g.lastPlayed);
    if (d) return d;
    let best = null;
    for (const t of g.earned || []) { const x = parseDate(t && t.date); if (x && (!best || x > best)) best = x; }
    return best;
  }

  // ---------- per-trophy classification ----------
  // Conservative text heuristics. Manual tags from enriched.json override these.
  const RX = {
    PLAYTHROUGH: /\b(new game\s*\+|ng\+|new game plus|complete (the )?(game|story|campaign)|beat (the )?(game|story|campaign)|finish (the )?(game|story|campaign)|clear (the )?(game|story|all stages)|(on|in) (ultra hard|very hard|hard|hardest|nightmare|legendary|grounded|give me god of war|hardcore|expert|master|veteran|inferno|lunatic|insane) (difficulty|mode)?|(ultra hard|very hard|nightmare|legendary|grounded|hardcore|permadeath|ironman|iron ?man|one life|no deaths?|without dying|deathless|without (taking )?damage|no damage|under \d+ ?hours?|in (one|a single) (sitting|run|session)|all (chapters|stages|levels|missions) on)\b)/i,
    DIFFICULTY: /\b(ultra hard|very hard|hardest|nightmare|legendary|grounded|give me god of war|hardcore|permadeath|ironman|iron ?man|no damage|without (taking )?damage|no deaths?|without dying|deathless|flawless|s[- ]?rank|ss[- ]?rank|perfect (run|score|game)|speed ?run|under \d+ ?(hours?|minutes?|seconds?))\b/i,
    ONLINE: /\b(online|multiplayer|ranked match|pvp|matchmaking|public (match|game|lobby)|other players?|another player online|online (co-?op|match|game|multiplayer)|servers?)\b/i,
    MISSABLE: /\b(missable|point of no return|before (you|the) (leave|finish|complete|enter)|only (chance|opportunity)|single playthrough|cannot (return|be replayed)|one[- ]time|first (visit|time) only)\b/i,
    GRIND: /\b(collect all|find all|obtain all|acquire all|unlock all|complete all|gather all|discover all|every (collectible|artifact|relic|card|coin|flag|feather|audio ?log|document|trophy|item|weapon|skill|upgrade|recipe|blueprint|achievement)|100 ?%|all (collectibles|trophies|achievements|side ?quests|skills|upgrades|weapons|outfits|costumes)|reach (level|rank) (\d{2,3})|level (50|60|70|80|90|99|100)|\b(1,?000|5,?000|10,?000|100,?000)\b|\d{3,}(,\d{3})* (kills|enemies|matches|wins)|\d{2,} hours)\b/i,
    RNG: /\b(random|rng|luck(y)?|chance|lottery|drop(s)? from|rare drop|gacha|roll)\b/i,
    DLC: /\b(dlc|expansion|season pass|add-?on)\b/i,
  };
  function heuristicFlags(name, desc) {
    const text = `${name || ''} ${desc || ''}`;
    const f = new Set();
    if (RX.PLAYTHROUGH.test(text)) f.add('PLAYTHROUGH');
    if (RX.DIFFICULTY.test(text)) f.add('SKILL_WALL');
    if (RX.ONLINE.test(text)) f.add('ONLINE');
    if (RX.MISSABLE.test(text)) f.add('MISSABLE');
    if (RX.GRIND.test(text)) f.add('GRIND');
    if (RX.RNG.test(text) && !f.has('GRIND')) f.add('RNG');
    if (RX.DLC.test(text)) f.add('DLC');
    return f;
  }
  const MANUAL_TAG_MAP = { MISSABLE: 'MISSABLE', ONLINE: 'ONLINE', SKILL_WALL: 'SKILL_WALL', GRIND: 'GRIND', BUGGY: 'BUGGY', RNG: 'RNG', PLAYTHROUGH: 'PLAYTHROUGH', NG_PLUS: 'PLAYTHROUGH', DIFFICULTY: 'SKILL_WALL', UNOBTAINABLE: 'UNOBTAINABLE', DLC: 'DLC' };

  /** Guides list glitched trophies as prose: "3 – Weapons Expert (delete save and redo),
   *  Breaker of Gates (...)". Rather than parse that, check whether THIS trophy's name
   *  appears in it — the game's own trophy names are the reliable key. */
  function glitchNote(g, t) {
    const raw = (g.guide && g.guide.glitchedRaw) || '';
    if (!raw || !t.name || /^\s*(0|none|nothing yet)\b/i.test(raw)) return null;
    const name = String(t.name).trim();
    if (name.length < 4 || !raw.toLowerCase().includes(name.toLowerCase())) return null;
    // Pull the clause about THIS trophy, stopping where the next named trophy begins.
    // The game's own trophy names are the delimiters, so one bug note never swallows another.
    const i = raw.toLowerCase().indexOf(name.toLowerCase());
    let clause = raw.slice(i);
    const others = [].concat(g.earned || [], g.unearned || [])
      .map((x) => x && x.name).filter((n) => n && n !== name && n.length > 3);
    let cut = clause.length;
    for (const o of others) {
      const at = clause.toLowerCase().indexOf(o.toLowerCase(), name.length);
      if (at > 0 && at < cut) cut = at;
    }
    // Earned trophies are not in the slim data, so their names cannot act as delimiters.
    // These lists are written "Name (why it breaks), Next Name (…)", so the first "), "
    // after our trophy is a reliable structural boundary.
    // Match whitespace tolerantly: the scraped text contains non-breaking spaces, so a
    // literal "), " never matches.
    const m = clause.slice(name.length).match(/\)[\s\u00a0]*,[\s\u00a0]+(?=[A-Z\u201c"'])/);
    if (m && m.index != null) {
      const paren = name.length + m.index + 1;
      if (paren < cut) cut = paren;
    }
    clause = clause.slice(0, cut).trim().replace(/[\s,;–-]+$/, '').replace(/^[\s–-]+/, '');
    return clause.length > 260 ? clause.slice(0, 260).replace(/\s\S*$/, '') + '…' : clause;
  }

  function trophyFlags(g, t) {
    const meta = g.trophyMeta && g.trophyMeta[t.name];
    const manual = meta && Array.isArray(meta.tags) ? meta.tags : null;
    if (manual && manual.length) {
      const f = new Set();
      for (const tag of manual) { const k = MANUAL_TAG_MAP[String(tag).toUpperCase()]; if (k) f.add(k); }
      if (glitchNote(g, t)) f.add('BUGGY');
      return { flags: f, source: 'manual' };
    }
    const f = heuristicFlags(t.name, t.desc);
    if (t.unobtainable) f.add('UNOBTAINABLE');
    if (glitchNote(g, t)) f.add('BUGGY');
    return { flags: f, source: 'heuristic' };
  }

  // ---------- rarity → effort / difficulty ----------
  /** Typical hours a committed player needs for ONE remaining trophy of this rarity. */
  function rarityHours(r) {
    if (r == null) return 0.75;              // unknown rarity: neutral guess
    if (r >= 50) return 0.2;
    if (r >= 30) return 0.4;
    if (r >= 20) return 0.75;
    if (r >= 10) return 1.5;
    if (r >= 5) return 3;
    if (r >= 2) return 5;
    return 8;
  }
  /** 0–10 difficulty implied by a trophy's rarity (50% → 1.5, 12% → 4.6, 3% → 7.6, ≤1% → 10). */
  function rarityDifficulty(r) {
    if (r == null) return null;
    return clamp(1.5 * log2(100 / Math.max(r, 0.1)), 0, 10);
  }
  function easeTierOf(r) {
    if (r == null) return 'unknown';
    if (r >= 50) return 'common';
    if (r >= 20) return 'uncommon';
    if (r >= 10) return 'rare';
    if (r >= 5) return 'very rare';
    return 'ultra rare';
  }

  // ---------- playthrough cost ----------
  function playthroughHours(g) {
    const hasty = parseHours(g.timeHastily);
    if (hasty) return { hours: hasty.avg, basis: `hasty playthrough (${g.timeHastily})` };
    const guide = g.guide || {};
    if (num(guide.hoursMin) != null) {
      const runs = Math.max(1, num(guide.playthroughs) || 1);
      const h = ((num(guide.hoursMin) + (num(guide.hoursMax) ?? num(guide.hoursMin))) / 2) / runs;
      return { hours: Math.max(3, h * 0.7), basis: `guide: ${guide.hoursMin}–${guide.hoursMax ?? guide.hoursMin}h / ${runs} run(s), rushed` };
    }
    const normal = parseHours(g.timeNormal);
    if (normal) return { hours: normal.avg * 0.6, basis: `normal playthrough (${g.timeNormal}) × 0.6 for a focused run` };
    const plat = parseHours(g.timePlat);
    if (plat) return { hours: plat.avg * 0.4, basis: `completion time (${g.timePlat}) × 0.4` };
    return { hours: 10, basis: 'no time data; assuming ~10h run' };
  }

  // ---------- main assessment ----------
  function assess(g, opts) {
    opts = opts || {};
    const now = opts.now ? new Date(opts.now) : new Date();
    const dataAsOf = opts.dataAsOf ? new Date(opts.dataAsOf) : now;
    const unearned = Array.isArray(g.unearned) ? g.unearned : [];
    const left = unearned.length || num(g.unearned) || 0;
    const reasons = [];

    // --- per-trophy pass ---
    let hours = 0, worstDiff = 0, rarest = null, rarestName = null, anyRarity = false;
    const trophyHours = [];
    const flagCount = { PLAYTHROUGH: 0, SKILL_WALL: 0, ONLINE: 0, MISSABLE: 0, GRIND: 0, RNG: 0, BUGGY: 0, UNOBTAINABLE: 0, DLC: 0 };
    const platRarity = (() => {
      const all = [].concat(g.earned || [], unearned);
      const p = all.find((t) => t && t.type === 'platinum');
      if (p && num(p.rarity) != null) return num(p.rarity);
      return num(g.platinumRarity);     // slim data keeps this even when earned[] is gone
    })();
    // Split what is left into the platinum path and DLC/optional extras.
    // A trophy required for the platinum can never be rarer than the platinum itself
    // (everyone holding the plat holds it), so rarer-than-plat means it is not required.
    const platPath = [], dlcList = [];
    for (const t of unearned) {
      if (t && t.type === 'platinum') continue;          // the platinum itself pops for free
      const r = num(t.rarity);
      const isDlc = trophyFlags(g, t).flags.has('DLC') || (platRarity != null && r != null && r < platRarity * 0.95);
      (isDlc ? dlcList : platPath).push(t);
    }
    // If literally everything left is "DLC", there is no platinum path to protect — score
    // what is actually left, otherwise the game would read as 0 effort and 0 difficulty.
    const scored = platPath.length ? platPath : dlcList;
    const dlcCount = platPath.length ? dlcList.length : 0;
    for (const t of scored) {
      const r = num(t.rarity);
      const { flags } = trophyFlags(g, t);
      if (r != null) { anyRarity = true; if (rarest == null || r < rarest) { rarest = r; rarestName = t.name; } }
      for (const f of flags) if (flagCount[f] != null) flagCount[f]++;
      let h = rarityHours(r);
      if (flags.has('PLAYTHROUGH')) h = 0.25;            // the run itself is costed once below
      if (flags.has('GRIND')) h *= 1.5;
      if (flags.has('SKILL_WALL')) h *= 1.4;
      if (flags.has('ONLINE')) h *= 1.25;
      if (flags.has('RNG')) h *= 1.3;
      trophyHours.push(h);
      let d = rarityDifficulty(r);
      if (d == null) d = flags.has('SKILL_WALL') ? 7 : flags.has('GRIND') ? 4 : 3;
      else if (flags.has('SKILL_WALL')) d = Math.max(d, 6.5);
      worstDiff = Math.max(worstDiff, d);
    }

    // Trophies are not independent errands: a run that nets the hardest one usually sweeps up
    // most of the others. So the hardest dominates and the rest are discounted on a decaying
    // curve, instead of a straight sum that compounds a 50-trophy game into hundreds of hours.
    trophyHours.sort((a, b) => b - a);
    hours = trophyHours.reduce((sum, h, i) => sum + h / (1 + 0.25 * i), 0);
    // Rarity measures DIFFICULTY, not duration: "complete level 4" can sit at 33% (common,
    // so cheap by rarity) and still mean replaying a campaign. Doing N separate things has a
    // floor no matter how common each one is.
    hours = Math.max(hours, 0.3 * Math.pow(trophyHours.length, 0.85));
    // Anchor to a real time estimate when one exists: what is left should scale with the share
    // of the game still to do, which catches lots-of-ordinary-trophies that rarity under-costs.
    const totalTrophies = scored.length + ((g.earned && g.earned.length) || num(g.earnedCount) || 0);
    const anchorSrc = parseHours(g.timePlat) || (num((g.guide || {}).hoursMax) != null
      ? { avg: (num(g.guide.hoursMin) + num(g.guide.hoursMax)) / 2 } : null) || parseHours(g.timeNormal);
    if (anchorSrc && totalTrophies > 0) {
      const fracLeft = clamp(scored.length / totalTrophies, 0, 1);
      hours = Math.max(hours, anchorSrc.avg * Math.pow(fracLeft, 0.85));
    }

    // --- playthrough cost (once) ---
    const needsPlaythrough = flagCount.PLAYTHROUGH > 0;
    let pt = null;
    if (needsPlaythrough) {
      pt = playthroughHours(g);
      // a run locked to a hard difficulty is not a rushed run
      const hardRun = scored.some((t) => { const f = trophyFlags(g, t).flags; return f.has('PLAYTHROUGH') && f.has('SKILL_WALL'); });
      if (hardRun) { pt = { hours: pt.hours * 1.6, basis: pt.basis + ', on a locked hard difficulty' }; }
      hours += pt.hours;
      reasons.push(`Needs a new playthrough: ~${Math.round(pt.hours)}h (${pt.basis})`);
    }
    if (dlcCount) hours += dlcCount * 1.2;               // DLC still costs time, just not platinum time
    // Hard upper bound: finishing what is LEFT cannot cost more than the guide's estimate for
    // the entire platinum from scratch (plus slack for DLC, which the guide may exclude).
    const timeConfidence = num((g.guide || {}).hoursMax) != null ? 'high'
      : (parseHours(g.timePlat) || parseHours(g.timeNormal)) ? 'medium' : 'low';
    const guideCap = num((g.guide || {}).hoursMax);
    if (guideCap != null && guideCap > 0) hours = Math.min(hours, guideCap * 1.1 + dlcCount * 1.2);
    hours = Math.max(0.25, hours);

    // --- difficulty: blend guide rating (whole platinum) with what is left ---
    const guide = g.guide || {};
    const guideDiff = num(guide.difficulty);
    let difficulty;
    if (anyRarity) {
      // What is LEFT decides. The guide rates the whole platinum including trophies already
      // earned, so it only nudges — it can never make common leftovers look hard.
      difficulty = guideDiff != null ? 0.85 * worstDiff + 0.15 * guideDiff : worstDiff;
      if (flagCount.SKILL_WALL) difficulty = Math.max(difficulty, 6.5);
    } else if (guideDiff != null) {
      difficulty = 0.7 * guideDiff + 0.3 * worstDiff;
    } else {
      difficulty = worstDiff + (flagCount.SKILL_WALL ? 0.5 : 0);
    }
    difficulty = clamp(difficulty, 0, 10);

    // --- attainability ---
    let dead = g.platDead === true;
    let deadReason = dead ? (g.deadReason || 'marked unattainable') : null;
    if (!dead && flagCount.UNOBTAINABLE) { dead = true; deadReason = `${flagCount.UNOBTAINABLE} unobtainable trophy(ies)`; }
    const shutdownNote = guide.serverShutdownMentioned ? 'guide reports servers shut down' : (g.serverNote ? `PSNProfiles: ${g.serverNote}` : null);
    if (!dead && shutdownNote && (flagCount.ONLINE || num(guide.online) > 0)) { dead = true; deadReason = `${shutdownNote} and online trophies remain`; }
    if (!dead && shutdownNote) reasons.push(`${shutdownNote} (no remaining trophy looks online, so still counted as attainable)`);
    const onlineRisk = !dead && flagCount.ONLINE > 0 && (g.platforms || []).some((p) => /PS3|Vita/i.test(p));
    if (onlineRisk) reasons.push(`${flagCount.ONLINE} online trophy(ies) on an older platform: check servers before investing time`);

    // --- value of finishing ---
    const platKnown = g.hasPlatinum === true || g.hasPlatinum === false;
    const hasPlat = g.hasPlatinum === true && !g.platinumEarned;
    let value = 1;
    if (hasPlat) { value += 1; reasons.push('Finishing earns the platinum'); }
    else if (!platKnown) value += 0.5;                    // unknown: assume a normal game, do not over-reward
    if (hasPlat && platRarity != null && platRarity < 5) { value += 0.6; reasons.push(`Ultra-rare platinum (${platRarity}% of players)`); }
    const total = num(g.earnedCount) != null ? num(g.earnedCount) : ((g.earned && g.earned.length) || num(g.earned) || 0);
    const pct = total + left > 0 ? total / (total + left) : 1;
    value += 0.5 * pct;                                   // sunk progress makes the finish feel better

    // --- momentum ---
    const lp = lastPlayedOf(g);
    const daysSince = lp ? Math.max(0, (dataAsOf - lp) / 86400000) : null;
    let momentum = 1;
    if (daysSince != null && daysSince <= 30) momentum = 1.35;
    else if (daysSince != null && daysSince <= 90) momentum = 1.15;
    else if (daysSince != null && daysSince > 365 * 4) momentum = 0.9;

    // --- ease & lanes ---
    const easeTier = easeTierOf(rarest);
    const allCommonish = anyRarity && scored.every((t) => num(t.rarity) == null || num(t.rarity) >= 20);
    const noWalls = !flagCount.SKILL_WALL && !flagCount.PLAYTHROUGH && !flagCount.ONLINE;
    // Your rule: high attainment % == easy. When every remaining trophy is common, this is an
    // easy gain no matter how brutal the game's overall reputation is.
    const easyGain = !dead && (anyRarity ? (allCommonish && !flagCount.PLAYTHROUGH) : noWalls) && hours <= 6;
    const quickPlat = !dead && hasPlat && hours <= 3 && difficulty <= 6;

    // --- score: value per unit of effort, penalised by difficulty, boosted by momentum/stars ---
    const effort = Math.pow(hours, 0.7) * (1 + difficulty / 10);
    let score = (value / effort) * momentum * 100;
    if (g.starred) score *= 1.5;
    if (dead) score = -1;

    // --- explanations ---
    if (anyRarity && rarest != null) reasons.unshift(`Rarest remaining: "${rarestName}" at ${rarest}% (${easeTier})`);
    if (!anyRarity) reasons.push('No rarity data yet (run the PSN sync) — using text heuristics');
    if (timeConfidence === 'low') reasons.push('No time estimate for this game — the hour figure is a rough guess from trophy rarity');
    if (guideDiff != null) reasons.push(`Guide difficulty ${guideDiff}/10${guide.playthroughs ? `, ${guide.playthroughs} playthrough(s)` : ''}${guide.hoursMin ? `, ${guide.hoursMin}–${guide.hoursMax ?? guide.hoursMin}h to platinum` : ''}`);
    if (flagCount.SKILL_WALL) reasons.push(`${flagCount.SKILL_WALL} skill-wall trophy(ies)`);
    if (flagCount.GRIND) reasons.push(`${flagCount.GRIND} grind/collectible trophy(ies)`);
    if (flagCount.MISSABLE) reasons.push(`${flagCount.MISSABLE} potentially missable`);
    if (dlcCount) reasons.push(`${dlcCount} DLC trophy(ies) left — rarer than the platinum, so not required for it`);
    if (daysSince != null) reasons.push(daysSince < 1 ? 'Played today' : daysSince < 45 ? `Played ${Math.round(daysSince)} days ago` : `Last played ${lp.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`);
    if (dead) reasons.unshift(`Unattainable: ${deadReason}`);

    return {
      dead, deadReason, onlineRisk,
      hours: round1(hours), hoursLow: round1(hours * (timeConfidence === 'low' ? 0.5 : 0.7)),
      hoursHigh: round1(hours * (timeConfidence === 'low' ? 2.2 : 1.5)), timeConfidence,
      difficulty: round1(difficulty), guideDifficulty: guideDiff,
      flags: flagCount, rarestRemaining: rarest, rarestName, platRarity, dlcCount, platPathLeft: scored.length,
      easeTier, allCommonish, easyGain, quickPlat, needsPlaythrough, playthroughHours: pt ? round1(pt.hours) : null,
      hasPlat, value: round1(value), momentum, daysSince: daysSince == null ? null : Math.round(daysSince),
      lastPlayed: lp ? lp.toISOString() : null, pct: Math.round(pct * 100), left,
      score: Math.round(score), reasons,
    };
  }
  function round1(x) { return Math.round(x * 10) / 10; }

  /** Rank + bucket a whole collection. entries: [[name, game], ...].
   *  opts.assessFn lets the caller supply a memoised assess (app.js keeps one per game). */
  function buildLanes(entries, opts) {
    opts = opts || {};
    const run = opts.assessFn || ((name, g) => assess(g, opts));
    const assessed = entries.map(([name, g]) => ({ name, g, a: run(name, g) }));
    const live = assessed.filter((x) => !x.a.dead && x.a.left > 0);
    const byScore = (a, b) => b.a.score - a.a.score;
    const used = new Set();
    // `take` keeps the themed lanes from repeating each other. The headline lane opts out:
    // it must always show the genuinely best picks, even if they also appear further down.
    const take = (arr, n, dedupe) => {
      const out = [];
      for (const x of arr) {
        if (dedupe !== false && used.has(x.name)) continue;
        out.push(x);
        if (dedupe !== false) used.add(x.name);
        if (n && out.length >= n) break;
      }
      return out;
    };
    const lanes = [];
    lanes.push({ id: 'starred', title: '⭐ Starred', sub: 'your work-on queue', items: take(live.filter((x) => x.g.starred).sort(byScore)) });
    // Headline lane first: this is the answer to "what do I play tonight".
    // The two highest-intent lanes opt out of the dedupe: a "platinum tonight" pick must not
    // be swallowed by a generic lane that happened to list it first.
    lanes.push({ id: 'next', title: '🎯 Play This Next', sub: 'best payoff for the time it takes', items: take(live.slice().sort(byScore), 8, false) });
    lanes.push({ id: 'quickplat', title: '🏆 Quick Platinum', sub: 'a whole platinum in about 3 hours', items: take(live.filter((x) => x.a.quickPlat).sort((a, b) => a.a.hours - b.a.hours), 12, false) });
    lanes.push({ id: 'recent', title: '⏮ Jump Back In', sub: 'played in the last 90 days', items: take(live.filter((x) => x.a.daysSince != null && x.a.daysSince <= 90).sort((a, b) => a.a.daysSince - b.a.daysSince), 8) });
    lanes.push({ id: 'easy', title: '🟢 Easy Gains', sub: 'everything left is common — low effort', items: take(live.filter((x) => x.a.easyGain).sort((a, b) => a.a.hours - b.a.hours), 12) });
    lanes.push({ id: 'playthrough', title: '🔁 Needs a Playthrough', sub: 'NG+ / difficulty runs — plan a weekend', items: take(live.filter((x) => x.a.needsPlaythrough).sort(byScore), 10) });
    lanes.push({ id: 'walls', title: '💀 Skill Walls', sub: 'ultra-rare trophies left', items: take(live.filter((x) => x.a.difficulty >= 8).sort(byScore), 10), collapsed: true });
    const dead = assessed.filter((x) => x.a.dead && x.a.left > 0).sort((a, b) => b.a.pct - a.a.pct);
    lanes.push({ id: 'dead', title: '🚫 Unattainable', sub: 'servers down or otherwise locked', items: dead, collapsed: true });
    return { lanes, assessed };
  }

  return { assess, buildLanes, parseHours, parseDate, lastPlayedOf, heuristicFlags, trophyFlags, glitchNote, rarityHours, rarityDifficulty, easeTierOf, playthroughHours };
});
