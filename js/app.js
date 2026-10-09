/* LabyrinthWorm // Trophy Tracker — v2 app
   Data: data/progress.json (v1 or v2), data/enriched.json (machine guide facts),
         data/overrides.json (hand-maintained), data/guides.json + js/guides-inline.js (walkthrough notes),
         data/library.json (owned titles), data/sync-meta.json.
   Scoring: js/scoring.js (window.TrophyScoring). */
(function () {
  'use strict';
  const S = window.TrophyScoring;
  const $ = (id) => document.getElementById(id);

  // ---------- persistence ----------
  const LS = { checked: 'trophyTracker.checked.v1', starred: 'trophyTracker.starred.v1', ui: 'trophyTracker.ui.v2' };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
  let checked = load(LS.checked, {});
  let starred = load(LS.starred, {});
  let ui = Object.assign({ sort: 'score', platform: 'all', range: 'all', genre: 'all', q: '', bl: 'all', tab: 'incomplete', collapsed: { walls: true, dead: true } }, load(LS.ui, {}));
  const checkId = (key, trophy) => (key + '||' + trophy).toLowerCase();
  const isChecked = (key, trophy) => !!checked[checkId(key, trophy)];
  const isStarred = (key) => !!starred[key.toLowerCase()];

  // ---------- data ----------
  let GAMES = {};            // key -> model
  let LIBRARY = null, META = null, GUIDES = {};
  let dataAsOf = null;
  const assessCache = new Map();

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attr = (s) => encodeURIComponent(String(s == null ? '' : s));
  const unattr = (s) => decodeURIComponent(s || '');
  const titleCase = (name) => name.replace(/\b\w/g, (c) => c.toUpperCase());
  const safeId = (key) => 'g-' + key.replace(/[^a-z0-9]+/gi, '-');

  const loadProblems = [];
  async function fetchJson(path, fallback) {
    let r;
    try { r = await fetch(path, { cache: 'no-cache' }); }
    catch (e) { loadProblems.push(`${path}: network error`); return fallback; }
    if (!r.ok) { if (r.status !== 404) loadProblems.push(`${path}: HTTP ${r.status}`); return fallback; }
    try { return await r.json(); }
    // A typo in overrides.json would otherwise silently drop your hand-written rules
    // (and quietly resurrect games you marked unattainable), so say so out loud.
    catch (e) { loadProblems.push(`${path}: invalid JSON — ${e.message}`); return fallback; }
  }

  function normalizeTrophy(t) {
    return { id: t.id ?? null, name: t.name ?? '', desc: t.desc ?? '', type: t.type ?? null, rarity: t.rarity == null ? null : Number(t.rarity), tier: t.tier ?? null, hidden: !!t.hidden, date: t.date ?? null, unobtainable: !!t.unobtainable };
  }

  function buildModel(key, raw, enr, ovr) {
    const earnedArr = Array.isArray(raw.earned) ? raw.earned.map(normalizeTrophy) : [];
    const unearnedArr = Array.isArray(raw.unearned) ? raw.unearned.map(normalizeTrophy) : [];
    const hasPlatInfo = earnedArr.concat(unearnedArr).some((t) => t.type);
    // PSNProfiles per-trophy tags (Missable / Online / Difficulty Specific) are the weakest
    // source; your own overrides always win.
    const psnpTags = {};
    for (const [name, labels] of Object.entries(raw.psnpTrophyTags || {})) {
      const tags = [];
      for (const l of labels) {
        if (/^missable$/i.test(l)) tags.push('MISSABLE');
        else if (/online/i.test(l)) tags.push('ONLINE');
        else if (/difficulty specific/i.test(l)) tags.push('SKILL_WALL');
        else if (/buggy|glitch/i.test(l)) tags.push('BUGGY');
      }
      if (tags.length) psnpTags[name] = { tags };
    }
    const trophyMeta = Object.assign({}, psnpTags, (enr && enr.trophies) || {}, (ovr && ovr.trophies) || {});
    const platDead = ovr && typeof ovr.platDead === 'boolean' ? ovr.platDead : (enr && typeof enr.platDead === 'boolean' ? enr.platDead : false);
    return {
      key, title: raw.title || titleCase(key),
      platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
      genres: Array.isArray(raw.genres) ? raw.genres : [],
      url: raw.url || null, iconUrl: raw.iconUrl || null,
      timeNormal: (enr && enr.timeNormal) ?? raw.timeNormal ?? null,
      timeHastily: (enr && enr.timeHastily) ?? raw.timeHastily ?? null,
      timePlat: (enr && enr.timePlat) ?? raw.timePlat ?? null,
      earnedBase: earnedArr, unearnedBase: unearnedArr,
      earnedBaseCount: typeof raw.earnedCount === 'number' ? raw.earnedCount : (typeof raw.earned === 'number' ? raw.earned : earnedArr.length),
      // null = unknown (legacy data has no trophy types); scoring treats unknown ≠ "has a platinum"
      hasPlatinum: typeof raw.hasPlatinum === 'boolean' ? raw.hasPlatinum : (hasPlatInfo ? earnedArr.concat(unearnedArr).some((t) => t.type === 'platinum') : null),
      platinumEarned: typeof raw.platinumEarned === 'boolean' ? raw.platinumEarned : (hasPlatInfo ? earnedArr.some((t) => t.type === 'platinum') : null),
      lastPlayed: raw.lastPlayed || (S.lastPlayedOf({ earned: earnedArr }) || {}).toISOString?.() || null,
      progress: raw.progress ?? null,
      guide: (enr && enr.guide && enr.guide.source) ? enr.guide : (raw.psnpGuideFacts || null),
      platDead, deadReason: (ovr && ovr.deadReason) || (enr && enr.deadReason) || '',
      serverNote: raw.serverNote || null, communityFlags: raw.communityFlags || null, platinumRarity: raw.platinumRarity ?? null, psnpHref: raw.psnpHref || null, psnpGuide: raw.psnpGuide || null,
      trophyMeta, gameTags: (enr && Array.isArray(enr.gameTags)) ? enr.gameTags : null,
      legacyOnly: !!raw.legacyOnly,
    };
  }

  /** The game as the scorer/UI should see it: checked-off trophies count as earned. */
  function view(g) {
    // Ticking every other remaining trophy implies the platinum pops, so don't make the
    // owner tick it by hand (and don't leave the game stuck at 1 left forever).
    const nonPlatLeft = g.unearnedBase.filter((t) => t.type !== 'platinum' && !isChecked(g.key, t.name));
    const platAuto = nonPlatLeft.length === 0;
    const isDone = (t) => isChecked(g.key, t.name) || (platAuto && t.type === 'platinum');
    const unearned = g.unearnedBase.filter((t) => !isDone(t));
    const checkedOnes = g.unearnedBase.filter(isDone);
    const earned = g.earnedBase.concat(checkedOnes);
    const platinumEarned = g.platinumEarned === null ? (unearned.length === 0) : (g.platinumEarned || checkedOnes.some((t) => t.type === 'platinum'));
    const earnedCount = g.earnedBaseCount + checkedOnes.length;
    return Object.assign({}, g, { earned, earnedCount, unearned, left: unearned.length, total: earnedCount + unearned.length, platinumEarned, starred: isStarred(g.key), completed: unearned.length === 0 });
  }
  function pctOf(v) { return v.total === 0 ? 100 : Math.round((v.earnedCount / v.total) * 100); }
  function assessOf(key) {
    if (assessCache.has(key)) return assessCache.get(key);
    const v = view(GAMES[key]);
    const a = S.assess(v, { dataAsOf });
    assessCache.set(key, a);
    return a;
  }
  function invalidate(key) { if (key) assessCache.delete(key); else assessCache.clear(); }

  function pctTheme(p) { return p >= 80 ? { bar: 'bar-green', pct: 'pct-high', prog: 'prog-green' } : p >= 40 ? { bar: 'bar-amber', pct: 'pct-med', prog: 'prog-amber' } : { bar: 'bar-red', pct: 'pct-low', prog: 'prog-red' }; }
  const diffClass = (d) => d >= 7 ? 'diff-hi' : d >= 4.5 ? 'diff-mid' : 'diff-lo';
  const fmtH = (h) => (h < 1 ? '<1h' : h < 10 ? `${Math.round(h * 2) / 2}h` : `${Math.round(h)}h`);
  const tierClass = (t) => (t || '').replace(/\s+/g, '-');
  function fmtDate(iso) { const d = S.parseDate(iso); if (!d) return ''; return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function ago(iso) {
    const d = S.parseDate(iso); if (!d) return '';
    const days = Math.round((dataAsOf - d) / 86400000);
    if (days <= 0) return 'today'; if (days === 1) return 'yesterday'; if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.round(days / 30)}mo ago`; return `${Math.round(days / 365 * 10) / 10}y ago`;
  }

  // ---------- chips / badges ----------
  function assessChips(a, opts) {
    opts = opts || {};
    const chips = [];
    if (a.dead) chips.push(`<span class="chip dead" title="${esc(a.deadReason)}">🚫 unattainable</span>`);
    const conf = a.timeConfidence === 'low'
      ? `rough guess from trophy rarity — no time estimate exists for this game (could be ${a.hoursLow}–${a.hoursHigh}h)`
      : `estimated remaining effort, ${a.hoursLow}–${a.hoursHigh}h`;
    chips.push(`<span class="chip hours${a.timeConfidence === 'low' ? ' guess' : ''}" title="${esc(conf)}">≈ <b>${fmtH(a.hours)}</b>${a.timeConfidence === 'low' ? '?' : ''}</span>`);
    chips.push(`<span class="chip ${diffClass(a.difficulty)}" title="Difficulty 0–10 from rarity of what is left${a.guideDifficulty != null ? ' blended with guide rating ' + a.guideDifficulty + '/10' : ''}">diff <b>${a.difficulty}</b></span>`);
    if (a.rarestRemaining != null) chips.push(`<span class="chip rar" title="Rarest remaining trophy: ${esc(a.rarestName)}">rarest <b>${a.rarestRemaining}%</b></span>`);
    if (a.needsPlaythrough) chips.push(`<span class="chip play" title="At least one trophy needs a fresh playthrough (~${a.playthroughHours}h)">🔁 playthrough</span>`);
    if (!a.dead && opts.game && opts.game.communityFlags) chips.push(`<span class="chip warn" title="${esc('Players are discussing this on PSNProfiles — worth checking before you invest time:\n• ' + opts.game.communityFlags.join('\n• '))}">⚠ check first</span>`);
    if (!opts.compact && a.hasPlat) chips.push(`<span class="chip plat">◆ platinum</span>`);
    return `<div class="chips">${chips.join('')}</div>`;
  }
  function gameFlagBadges(g, a) {
    if (g.gameTags && g.gameTags.length) return `<div class="flag-row">${g.gameTags.map((b) => `<span class="g-badge ${esc(b.cls)}">${esc(b.label)}</span>`).join('')}</div>`;
    const f = a.flags, out = [];
    if (f.SKILL_WALL) out.push(`<span class="g-badge gt-skill">💀 SKILL WALL ×${f.SKILL_WALL}</span>`);
    if (f.PLAYTHROUGH) out.push(`<span class="g-badge gt-play">🔁 NEW RUN</span>`);
    if (f.MISSABLE) out.push(`<span class="g-badge gt-missable">⚠ MISSABLE ×${f.MISSABLE}</span>`);
    if (f.ONLINE) out.push(`<span class="g-badge gt-online">🌐 ONLINE ×${f.ONLINE}</span>`);
    if (f.GRIND) out.push(`<span class="g-badge gt-grind">⏱ GRIND ×${f.GRIND}</span>`);
    return out.length ? `<div class="flag-row">${out.join('')}</div>` : '';
  }
  function trophyBadges(g, t) {
    const { flags, source } = S.trophyFlags(g, t);
    const map = { MISSABLE: ['note-warn', '⚠ Missable'], ONLINE: ['note-online', '🌐 Online'], SKILL_WALL: ['note-skill', '💀 Skill wall'], GRIND: ['note-grind', '⏱ Grind'], RNG: ['note-grind', '🎲 RNG'], BUGGY: ['note-warn', '🧨 Buggy'], PLAYTHROUGH: ['note-play', '🔁 New playthrough'], UNOBTAINABLE: ['note-dead', '🚫 Unobtainable'], DLC: ['note-grind', 'DLC'] };
    const out = [];
    const bug = S.glitchNote(g, t);
    const note = (g.trophyMeta && g.trophyMeta[t.name] && g.trophyMeta[t.name].notes) || null;
    for (const f of flags) {
      if (!map[f]) continue;
      // a BUGGY flag is only useful with the reason and the workaround attached
      const why = f === 'BUGGY' && bug ? bug : (source === 'manual' ? 'from your notes' : 'detected from the description');
      out.push(`<span class="t-note ${map[f][0]}" title="${esc(why)}">${map[f][1]}</span>`);
    }
    let extra = '';
    if (bug) extra += `<div class="t-bugnote"><b>Known issue:</b> ${esc(bug)}</div>`;
    if (note) extra += note.map((n) => `<div class="t-bugnote mine"><b>Your note:</b> ${esc(n)}</div>`).join('');
    return (out.length || extra) ? `<div class="t-badges">${out.join('')}</div>${extra}` : '';
  }
  function starBtn(key) { const on = isStarred(key); return `<button class="star-btn ${on ? 'on' : ''}" data-action="star" data-key="${attr(key)}" title="${on ? 'Unstar' : 'Star: add to your work-on queue'}" aria-pressed="${on}">${on ? '★' : '☆'}</button>`; }
  /** Only link to guides we have actually seen exist. A search URL is not a guide:
   *  for a game nobody has written about yet (Duskfade), PowerPyx's search is an empty
   *  page, and offering it under "Guides" is a dead end dressed up as help. */
  function guideLinks(g) {
    const t = g.title;
    const real = [], search = [];
    const SOURCE_LABEL = { powerpyx: 'PowerPyx guide', psnprofiles: 'PSNProfiles guide', trueachievements: 'Xbox walkthrough' };
    if (g.guide && g.guide.url && SOURCE_LABEL[g.guide.source]) real.push([SOURCE_LABEL[g.guide.source], g.guide.url, g.guide.crossReferenced || '']);
    if (g.psnpGuide) real.push(['PSNProfiles guide', 'https://psnprofiles.com' + g.psnpGuide]);
    if (g.psnpHref) search.push(['My trophy list', 'https://psnprofiles.com' + g.psnpHref]);
    search.push(['Search the web', 'https://www.google.com/search?q=' + encodeURIComponent(t + ' trophy guide')]);
    const btn = (pair, cls) => `<a class="guide-link-btn ${cls}" href="${esc(pair[1])}" target="_blank" rel="noopener"${pair[2] ? ` title="${esc(pair[2])}"` : ''}>${esc(pair[0])}</a>`;
    const tail = search.map((x) => btn(x, 'is-search')).join('');
    if (real.length) {
      return `<div class="guide-links" data-stop="1"><span class="guide-links-label">Guide</span>${real.map((x) => btn(x, 'is-real')).join('')}${tail}</div>`;
    }
    return `<div class="guide-links" data-stop="1"><span class="guide-links-label no-guide" title="No trophy guide has been written for this game yet — usually because it is new or niche.">No guide written yet</span>${tail}</div>`;
  }

  // ---------- collections ----------
  let incomplete = [], completed = [];
  function recompute() {
    incomplete = []; completed = [];
    let left = 0, plats = 0, checkedCount = 0;
    for (const key of Object.keys(GAMES)) {
      const v = view(GAMES[key]);
      // Legacy data has no trophy types, so "has a platinum" is unknown; a finished game is
      // then the best available proxy. Real platinum counts arrive with the PSN/PSNProfiles sync.
      if (v.completed) { completed.push([key, v]); if (v.platinumEarned === true || (v.hasPlatinum === null && v.platinumEarned !== false)) plats++; }
      else { incomplete.push([key, v]); left += v.left; }
      checkedCount += v.earnedCount - GAMES[key].earnedBaseCount;
      if (v.completed && v.platinumEarned === true && !v.hasPlatinum) { /* 100% without platinum */ }
    }
    $('st-total').textContent = Object.keys(GAMES).length;
    $('st-plat').textContent = plats;
    const platKnown = Object.values(GAMES).some((g) => g.hasPlatinum === true);
    const platLabel = $('st-plat').previousElementSibling;
    if (platLabel) { platLabel.textContent = platKnown ? 'Platinums' : 'Completed'; platLabel.title = platKnown ? '' : 'Trophy types are unknown in this data; showing finished games. Run a sync for real platinum counts.'; }
    $('st-incomplete').textContent = incomplete.length;
    $('st-unearned').textContent = left.toLocaleString();
    $('st-checked').textContent = checkedCount;
    $('tab-inc-count').textContent = incomplete.length;
    $('tab-comp-count').textContent = completed.length;
  }

  // ---------- lanes ----------
  let lanesCache = null;
  function renderLanes() {
    const host = $('lanes');
    const entries = incomplete;
    const { lanes } = S.buildLanes(entries, { dataAsOf, now: dataAsOf, assessFn: (name) => assessOf(name) });
    lanesCache = lanes;
    let html = '';
    for (const lane of lanes) {
      if (!lane.items.length && lane.id !== 'starred') continue;
      const collapsed = !!ui.collapsed[lane.id];
      html += `<section class="lane lane-${lane.id} ${collapsed ? 'collapsed' : ''}" aria-label="${esc(lane.title)}">
        <div class="lane-head">${esc(lane.title)}<span class="lane-count">${lane.items.length}</span>${lane.sub ? `<span class="lane-sub">${esc(lane.sub)}</span>` : ''}
          ${lane.collapsed || collapsed || lane.items.length > 8 ? `<button class="lane-toggle" data-action="toggle-lane" data-lane="${lane.id}">${collapsed ? 'show' : 'hide'}</button>` : ''}</div>
        <div class="lane-row">${lane.items.length ? lane.items.map((x) => miniCard(x.name, x.g, x.a)).join('') : `<div class="empty" style="padding:16px;grid-column:auto">Star a game to pin it here.</div>`}</div>
      </section>`;
    }
    host.innerHTML = html;
  }
  function miniCard(key, v, a) {
    const p = pctOf(v), th = pctTheme(p);
    return `<div class="mini-card" data-action="focus" data-key="${attr(key)}" title="${esc(a.reasons.slice(0, 3).join(' · '))}">
      <div class="mini-top"><button class="mini-title" data-action="focus" data-key="${attr(key)}">${esc(v.title)}</button>${starBtn(key)}</div>
      <div class="mini-meta"><span class="pct-badge ${th.pct}">${p}%</span><span class="mini-left"><b>${v.left}</b> left</span>${v.lastPlayed ? `<span class="last-played">${esc(ago(v.lastPlayed))}</span>` : ''}</div>
      ${assessChips(a, { compact: true })}
      <div class="prog-bg" style="margin:8px 0 0"><div class="prog-fill ${th.prog}" style="width:${p}%"></div></div>
    </div>`;
  }

  // ---------- grid ----------
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    let list = incomplete.filter(([key, v]) => {
      if (q && !v.title.toLowerCase().includes(q) && !key.includes(q)) return false;
      if (ui.genre !== 'all' && !v.genres.includes(ui.genre)) return false;
      if (ui.platform !== 'all' && !v.platforms.includes(ui.platform)) return false;
      const p = pctOf(v);
      if (ui.range === 'near' && p < 80) return false;
      if (ui.range === 'mid' && (p < 40 || p >= 80)) return false;
      if (ui.range === 'low' && p >= 40) return false;
      if (ui.range === 'quick' && v.left > 5) return false;
      if (ui.range === 'easy' && !assessOf(key).easyGain) return false;
      if (ui.range === 'starred' && !v.starred) return false;
        if (ui.range === 'dead' && !assessOf(key).dead) return false;
      if (ui.range !== 'dead' && assessOf(key).dead && !q && key !== focusKey) return false;   // hide dead unless searched, asked for, or focused
      return true;
    });
    const s = ui.sort;
    const A = (k) => assessOf(k);
    if (s === 'score') list.sort(([a], [b]) => A(b).score - A(a).score);
    else if (s === 'hours-asc') list.sort(([a], [b]) => A(a).hours - A(b).hours);
    else if (s === 'diff-asc') list.sort(([a], [b]) => A(a).difficulty - A(b).difficulty || A(a).hours - A(b).hours);
    else if (s === 'recent') list.sort(([a], [b]) => (A(a).daysSince ?? 1e9) - (A(b).daysSince ?? 1e9));
    else if (s === 'pct-desc') list.sort(([, a], [, b]) => pctOf(b) - pctOf(a));
    else if (s === 'pct-asc') list.sort(([, a], [, b]) => pctOf(a) - pctOf(b));
    else if (s === 'left-asc') list.sort(([, a], [, b]) => a.left - b.left);
    else if (s === 'alpha') list.sort(([, a], [, b]) => a.title.localeCompare(b.title));
    return list;
  }

  function cardHtml(key, v) {
    const a = assessOf(key);
    const p = pctOf(v), th = pctTheme(p);
    const plats = v.platforms.map((x) => `<span class="plat-tag">${esc(x)}</span>`).join('');
    const times = [['Normal', v.timeNormal], ['Hasty', v.timeHastily], ['Completion', v.timePlat]].filter(([, x]) => S.parseHours(x));
    const timeRow = times.length ? `<div class="time-row">${times.map(([l, x]) => `<div class="time-pill"><span class="time-label">${l}</span><span class="time-val">${esc(x)}</span></div>`).join('')}</div>` : '';
    const open = openDrawers.has(key);
    return `<article class="game-card ${a.dead ? 'is-dead' : ''} ${open ? 'open' : ''}" id="${safeId(key)}" data-key="${attr(key)}">
      <div class="card-bar ${th.bar}"></div>
      <div class="card-inner" data-action="toggle" data-key="${attr(key)}">
        <div class="card-top"><h3 class="game-title">${esc(v.title)}</h3><div class="card-right"><span class="pct-badge ${th.pct}">${p}%</span>${starBtn(key)}</div></div>
        <div class="prog-bg"><div class="prog-fill ${th.prog}" style="width:${p}%"></div></div>
        <div class="card-meta">${plats}${a.dead ? `<span class="dead-badge" title="${esc(a.deadReason)}">🚫 UNATTAINABLE</span>` : ''}${v.lastPlayed ? `<span class="last-played">last trophy ${esc(ago(v.lastPlayed))}</span>` : ''}<span class="trophy-remaining"><span>${v.left}</span> left</span></div>
        <div class="assess-row">${assessChips(a, { game: v })}</div>
        ${gameFlagBadges(v, a)}
        ${timeRow}
        <button class="expand-hint" data-action="toggle" data-key="${attr(key)}" aria-expanded="${open}" aria-controls="dr-${safeId(key)}"><span class="expand-arrow" aria-hidden="true">▾</span> ${open ? 'Hide' : 'Show'} ${v.left} remaining ${v.left === 1 ? 'trophy' : 'trophies'}</button>
        ${guideLinks(v)}
      </div>
      <div class="trophy-drawer ${open ? 'open' : ''}" id="dr-${safeId(key)}">${open ? drawerHtml(key, v) : ''}</div>
    </article>`;
  }
  function drawerHtml(key, v) {
    const g = GAMES[key];
    const rows = g.unearnedBase.map((t) => {
      const on = isChecked(key, t.name);
      const hasGuide = !!(GUIDES[key] && GUIDES[key][t.name]);
      const rar = t.rarity != null ? `<span class="rarity ${tierClass(S.easeTierOf(t.rarity))}" title="${esc(S.easeTierOf(t.rarity))}: ${t.rarity}% of players have this">${t.rarity}%</span>` : '';
      return `<div class="trophy-item ${on ? 'is-checked' : ''}">
        <button class="t-check" role="checkbox" aria-checked="${on}" aria-label="Mark ${esc(t.name)} as done" data-action="check" data-key="${attr(key)}" data-trophy="${attr(t.name)}"></button>
        <div class="t-info">
          <div class="t-name">${t.type ? `<span class="ttype ${esc(t.type)}" title="${esc(t.type)}"></span>` : ''}<span>${esc(t.name)}</span>${rar}<button class="guide-btn ${hasGuide ? 'has' : ''}" data-action="guide" data-key="${attr(key)}" data-trophy="${attr(t.name)}">📖 ${hasGuide ? 'Guide' : 'Info'}</button></div>
          ${t.desc ? `<div class="t-desc">${esc(t.desc)}</div>` : ''}
          ${trophyBadges(g, t)}
        </div></div>`;
    }).join('');
    const done = g.unearnedBase.filter((t) => isChecked(key, t.name)).length;
    return `<div class="drawer-header"><span class="drawer-title">Remaining trophies</span><span class="drawer-progress"><span class="checked-count">${done}</span> / ${g.unearnedBase.length} checked</span><button class="drawer-reset" data-action="reset" data-key="${attr(key)}">Reset checklist</button></div><div class="trophy-list">${rows}</div>`;
  }
  const openDrawers = new Set();

  function renderGrid() {
    const list = filtered();
    const left = list.reduce((s, [, v]) => s + v.left, 0);
    $('resultsInfo').innerHTML = `Showing <strong>${list.length}</strong> games · <strong>${left.toLocaleString()}</strong> trophies remaining`;
    const grid = $('grid');
    grid.innerHTML = list.length ? list.map(([k, v]) => cardHtml(k, v)).join('') : '<div class="empty">No games match your filters</div>';
  }
  function rerenderCard(key) {
    const el = $(safeId(key)); if (!el) return;
    const v = view(GAMES[key]);
    if (v.completed) { renderAll(); return; }
    const tmp = document.createElement('div'); tmp.innerHTML = cardHtml(key, v);
    el.replaceWith(tmp.firstElementChild);
  }
  function renderAll() { recompute(); renderLanes(); renderGrid(); if (ui.tab === 'completed') renderCompleted(); }

  // ---------- completed & backlog ----------
  function renderCompleted() {
    const q = ($('search-comp').value || '').toLowerCase();
    const sort = $('sort-comp').value;
    let list = completed.filter(([k, v]) => !q || v.title.toLowerCase().includes(q) || k.includes(q));
    if (sort === 'alpha') list.sort(([, a], [, b]) => a.title.localeCompare(b.title));
    else if (sort === 'recent') list.sort(([, a], [, b]) => (S.parseDate(b.lastPlayed) || 0) - (S.parseDate(a.lastPlayed) || 0));
    else if (sort === 'trophies-desc') list.sort(([, a], [, b]) => b.earnedCount - a.earnedCount);
    else if (sort === 'time-desc') list.sort(([, a], [, b]) => ((S.parseHours(b.timePlat) || {}).avg || 0) - ((S.parseHours(a.timePlat) || {}).avg || 0));
    $('comp-info').innerHTML = `<strong>${list.length}</strong> completed games`;
    $('completed-grid').innerHTML = list.length ? list.map(([key, v]) => `
      <div class="comp-card ${v.hasPlatinum ? '' : 'no-plat'}">
        <div class="comp-title">${esc(v.title)}</div>
        <div class="comp-meta">
          <div class="plat-icon-wrap"><div class="plat-diamond" title="${v.hasPlatinum ? 'Platinum' : '100% (no platinum)'}"></div><span class="comp-trophies">${v.earnedCount}</span></div>
          ${v.lastPlayed ? `<span class="comp-time">· ${esc(fmtDate(v.lastPlayed))}</span>` : (S.parseHours(v.timePlat) ? `<span class="comp-time">· ${esc(v.timePlat)}</span>` : '')}
          ${v.platforms.map((p) => `<span class="plat-tag">${esc(p)}</span>`).join('')}
          ${GAMES[key].unearnedBase.length ? `<button class="reopen-btn" data-action="reopen" data-key="${attr(key)}">Reopen</button>` : ''}
        </div></div>`).join('') : '<div class="empty">No games found</div>';
  }
  function renderBacklog() {
    const host = $('backlog-grid');
    if (!LIBRARY) { host.innerHTML = '<div class="empty">No library data yet. Run <code>npm run sync</code> to pull your owned games.</div>'; return; }
    const q = ($('search-backlog').value || '').toLowerCase();
    const looseKeys = new Set(Object.values(GAMES).map((g) => loose(g.title)).concat(Object.keys(GAMES).map(loose)));
    const seen = new Set();
    let items = LIBRARY.titles.filter((t) => !t.nonGame && !t.preorder).filter((t) => { const k = loose(t.name); if (looseKeys.has(k) || seen.has(k)) return false; seen.add(k); return true; })
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .filter((t) => ui.bl === 'all' || (ui.bl === 'owned' ? !t.plus : ui.bl === 'plus' ? t.plus : t.platform === ui.bl));
    const sort = ($('sort-backlog') || {}).value || 'owned';
    if (sort === 'alpha') items.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'platform') items.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || a.name.localeCompare(b.name));
    else items.sort((a, b) => (a.plus === b.plus ? a.name.localeCompare(b.name) : (a.plus ? 1 : -1)));
    const owned = items.filter((t) => !t.plus).length;
    $('backlog-info').innerHTML = `<strong>${items.length}</strong> never started · <strong>${owned}</strong> bought outright, ${items.length - owned} on PS Plus`;
    host.innerHTML = items.length ? items.map((t) => `<div class="bl-card"><div class="bl-title">${esc(t.name)}</div><div class="bl-meta"><span class="plat-tag">${esc(t.platform)}</span>${t.plus ? '<span class="bl-plus">PS PLUS</span>' : ''}<a class="guide-link-btn" style="margin-left:auto" href="https://www.google.com/search?q=${encodeURIComponent(t.name + ' trophy guide')}" target="_blank" rel="noopener">Guide</a></div></div>`).join('') : '<div class="empty">Nothing here</div>';
  }
  // backlog filter state lives in ui so it survives a reload
  const EDITION = /\b(remastered|remaster|remake|hd|definitive edition|ultimate edition|complete edition|game of the year edition|goty|anniversary edition|directors cut|final mix|the game|console edition|enhanced edition|deluxe|ps4|ps5|vita|vr|edition|demo)\b/g;
  const loose = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[™®©]/g, '').replace(/['’]/g, '').replace(EDITION, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

  // ---------- filters UI ----------
  function buildFilters() {
    const plats = [...new Set(Object.values(GAMES).flatMap((g) => g.platforms))].sort();
    const sel = $('platform');
    sel.innerHTML = '<option value="all">All platforms</option>' + plats.map((p) => `<option value="${esc(p)}" ${ui.platform === p ? 'selected' : ''}>${esc(p)}</option>`).join('');
    const genres = [...new Set(Object.values(GAMES).flatMap((g) => g.genres))].sort();
    const gf = $('genreFilters');
    gf.querySelectorAll('button').forEach((b) => b.remove());
    for (const g of ['all'].concat(genres)) {
      const b = document.createElement('button'); b.className = 'pill' + (ui.genre === g ? ' active' : ''); b.textContent = g === 'all' ? 'All' : g; b.dataset.action = 'genre'; b.dataset.genre = g; gf.appendChild(b);
    }
    $('sort').value = ui.sort; $('search').value = ui.q;
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === ui.range));
  }
  function persistUi() { save(LS.ui, ui); }

  // ---------- actions ----------
  let lastToggle = null;
  function toggleCheck(key, trophy) {
    const id = checkId(key, trophy);
    const was = !!checked[id];
    const v0 = view(GAMES[key]);
    if (was) delete checked[id]; else checked[id] = true;
    save(LS.checked, checked);
    lastToggle = { key, trophy, was };
    invalidate(key);
    const v1 = view(GAMES[key]);
    if (!v0.completed && v1.completed) { toast(`${v1.title} moved to Completed (based on your checklist).`, () => { if (lastToggle) { if (lastToggle.was) checked[checkId(lastToggle.key, lastToggle.trophy)] = true; else delete checked[checkId(lastToggle.key, lastToggle.trophy)]; save(LS.checked, checked); invalidate(lastToggle.key); openDrawers.add(lastToggle.key); renderAll(); } }); renderAll(); return; }
    // in-place update: keep scroll + drawer
    const card = $(safeId(key));
    if (card) {
      const btn = card.querySelector(`[data-action="check"][data-trophy="${CSS.escape(attr(trophy))}"]`);
      if (btn) { btn.setAttribute('aria-checked', String(!was)); btn.closest('.trophy-item').classList.toggle('is-checked', !was); }
      const cnt = card.querySelector('.checked-count'); if (cnt) cnt.textContent = GAMES[key].unearnedBase.filter((t) => isChecked(key, t.name)).length;
      const p = pctOf(v1), th = pctTheme(p);
      const badge = card.querySelector('.pct-badge'); if (badge) { badge.textContent = p + '%'; badge.className = 'pct-badge ' + th.pct; }
      const fill = card.querySelector('.card-inner .prog-fill'); if (fill) { fill.style.width = p + '%'; fill.className = 'prog-fill ' + th.prog; }
      const rem = card.querySelector('.trophy-remaining span'); if (rem) rem.textContent = v1.left;
      const ar = card.querySelector('.assess-row'); if (ar) ar.innerHTML = assessChips(assessOf(key));
    }
    recompute(); renderLanes();
  }
  function resetChecks(key, label) {
    const undo = {};
    for (const t of GAMES[key].unearnedBase) { const id = checkId(key, t.name); if (checked[id]) undo[id] = true; delete checked[id]; }
    save(LS.checked, checked); invalidate(key); renderAll();
    const n = Object.keys(undo).length;
    if (n) toast(`${label || 'Cleared'} ${GAMES[key].title}: ${n} tick${n === 1 ? '' : 's'} removed.`, () => {
      Object.assign(checked, undo); save(LS.checked, checked); invalidate(key); renderAll();
    });
  }
  function toggleStar(key) {
    const k = key.toLowerCase();
    if (starred[k]) delete starred[k]; else starred[k] = true;
    save(LS.starred, starred); invalidate(key);
    document.querySelectorAll(`[data-action="star"][data-key="${CSS.escape(attr(key))}"]`).forEach((b) => { const on = isStarred(key); b.classList.toggle('on', on); b.textContent = on ? '★' : '☆'; b.setAttribute('aria-pressed', String(on)); });
    recompute();          // refresh the cached views so the Starred lane sees the new state
    renderLanes();
    if (ui.range === 'starred' || ui.sort === 'score') renderGrid();
  }
  function toggleDrawer(key) {
    const card = $(safeId(key)); if (!card) return;
    const dr = card.querySelector('.trophy-drawer');
    const open = !openDrawers.has(key);
    if (open) { openDrawers.add(key); if (!dr.innerHTML.trim()) dr.innerHTML = drawerHtml(key, view(GAMES[key])); dr.classList.add('open'); card.classList.add('open'); }
    else { openDrawers.delete(key); dr.classList.remove('open'); card.classList.remove('open'); }
    const hint = card.querySelector('.expand-hint');
    if (hint) {
      hint.setAttribute('aria-expanded', String(open));
      const n = view(GAMES[key]).left;
      hint.innerHTML = `<span class="expand-arrow" aria-hidden="true">▾</span> ${open ? 'Hide' : 'Show'} ${n} remaining ${n === 1 ? 'trophy' : 'trophies'}`;
    }
  }
  let focusKey = null;
  function focusGame(key) {
    ui.q = ''; ui.range = 'all'; ui.genre = 'all'; ui.platform = 'all'; persistUi(); buildFilters();
    focusKey = key;                       // survives the filters so unattainable games open too
    switchTab('incomplete'); renderGrid();
    const card = $(safeId(key)); if (!card) return;
    if (!openDrawers.has(key)) toggleDrawer(key);
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
  }
  function switchTab(tab) {
    ui.tab = tab; persistUi();
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'completed') renderCompleted();
    if (tab === 'backlog') renderBacklog();
  }

  // ---------- suggest ----------
  let suggestPool = [];
  function suggest(next) {
    const pool = filtered().filter(([k]) => !assessOf(k).dead);
    if (!pool.length) { toast('No games match the current filters — clear them and try again.'); return; }
    if (!next || !suggestPool.length) suggestPool = pool.slice().sort(([a], [b]) => assessOf(b).score - assessOf(a).score).slice(0, 12);
    // pick from the top 5 with light randomness, then rotate
    const idx = Math.floor(Math.random() * Math.min(5, suggestPool.length));
    const [key, v] = suggestPool.splice(idx, 1)[0];
    const a = assessOf(key), p = pctOf(v);
    $('rec-genre').textContent = v.genres.join(' · ') || v.platforms.join(' · ') || 'Suggestion';
    $('rec-title').textContent = v.title;
    $('rec-pct').innerHTML = `${p}%<span>· ${v.left} trophies left</span>`;
    $('rec-chips').innerHTML = assessChips(a);
    $('rec-reasons').innerHTML = a.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    $('rec-star').dataset.key = attr(key); $('rec-star').textContent = isStarred(key) ? '★ Starred' : '☆ Star it';
    $('rec-open').dataset.key = attr(key);
    openDialog($('modal'), $('rec-open'));
  }
  // Dialogs: move focus in, keep Tab inside, and put it back where it came from.
  let lastFocus = null;
  function openDialog(el, focusEl) {
    lastFocus = document.activeElement;
    el.classList.add('open');
    (focusEl || el.querySelector('button, [href], input, select, [tabindex]'))?.focus();
  }
  function closeDialog(el) {
    el.classList.remove('open');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function trapTab(e) {
    const dlg = document.querySelector('.modal-bg.open, .guide-overlay.open');
    if (!dlg || e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function closeModal() { const m = $('modal'); if (m.classList.contains('open')) closeDialog(m); }

  // ---------- guide panel ----------
  function openGuide(key, trophyName) {
    const g = GAMES[key]; const t = g.unearnedBase.concat(g.earnedBase).find((x) => x.name === trophyName) || { name: trophyName, desc: '' };
    const guide = GUIDES[key] && GUIDES[key][trophyName];
    $('guide-game').textContent = g.title; $('guide-trophy-name').textContent = t.name; $('guide-trophy-desc').textContent = t.desc || '';
    const tags = [];
    if (guide && guide.tags) tags.push(...guide.tags.map((x) => `<span class="guide-tag ${esc(x.cls)}">${esc(x.label)}</span>`));
    if (t.rarity != null) tags.push(`<span class="guide-tag gt-time">${t.rarity}% of players · ${esc(S.easeTierOf(t.rarity))}</span>`);
    $('guide-tags').innerHTML = tags.join('');
    let html = '';
    const facts = [];
    if (t.type) facts.push(['Type', t.type]);
    if (t.rarity != null) facts.push(['Rarity', `${t.rarity}%`]);
    const { flags } = S.trophyFlags(g, t);
    if (flags.size) facts.push(['Flags', [...flags].map((f) => f.toLowerCase().replace('_', ' ')).join(', ')]);
    if (g.guide) { if (g.guide.difficulty != null) facts.push(['Game difficulty', `${g.guide.difficulty}/10`]); if (g.guide.playthroughs != null) facts.push(['Playthroughs', g.guide.playthroughs]); if (g.guide.hoursMin != null) facts.push(['Platinum time', `${g.guide.hoursMin}–${g.guide.hoursMax ?? g.guide.hoursMin}h`]); if (g.guide.missables != null) facts.push(['Missables', g.guide.missables]); }
    if (facts.length) html += `<div class="guide-facts">${facts.map(([k, v]) => `<div class="guide-fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>`;
    const notes = g.trophyMeta && g.trophyMeta[trophyName] && g.trophyMeta[trophyName].notes;
    if (notes && notes.length) html += `<div class="guide-section"><div class="guide-section-title">Notes</div>${notes.map((n) => `<div class="guide-tip">${esc(n)}</div>`).join('')}</div>`;
    if (guide) {
      for (const section of guide.sections || []) html += `<div class="guide-section"><div class="guide-section-title">${esc(section.title)}</div><div class="guide-steps">${section.steps.map((s, i) => `<div class="guide-step"><div class="step-num">${i + 1}</div><div class="step-text">${s}</div></div>`).join('')}</div></div>`;
      if (guide.tips && guide.tips.length) html += `<div class="guide-section"><div class="guide-section-title">Tips & warnings</div>${guide.tips.map((tip) => tip.type === 'warning' ? `<div class="guide-warning">${tip.text}</div>` : `<div class="guide-tip">${tip.text}</div>`).join('')}</div>`;
    } else {
      // No hand-written walkthrough for this trophy. Show what we actually KNOW rather than a
      // list of searches: the guide's own per-trophy verdict, a link straight to that trophy's
      // section, and what the rarity implies. Never a speculative search dressed as a guide.
      const anchors = g.psnpGuideAnchors || {};
      const deepLink = g.psnpGuide && anchors[t.name] ? 'https://psnprofiles.com' + g.psnpGuide + anchors[t.name] : null;
      const tmeta = g.trophyMeta && g.trophyMeta[t.name];
      const verdict = tmeta && Array.isArray(tmeta.tags) && tmeta.tags.length
        ? tmeta.tags.map((x) => String(x).toLowerCase().replace(/_/g, ' ')).join(', ') : null;
      if (deepLink || verdict) {
        html += `<div class="guide-section"><div class="guide-section-title">What the guide says</div>`;
        if (verdict) html += `<div class="guide-tip"><strong>Flagged as:</strong> ${esc(verdict)}</div>`;
        if (deepLink) html += `<div class="guide-steps"><div class="guide-step"><div class="step-num">&rarr;</div><div class="step-text"><a href="${esc(deepLink)}" target="_blank" rel="noopener">Open this trophy&rsquo;s section in the guide</a></div></div></div>`;
        html += `</div>`;
      }
      if (t.rarity != null) {
        const readMe = t.rarity >= 50 ? 'most owners have it, so this is unlikely to be the hard part'
          : t.rarity >= 20 ? 'a majority never get it, but it is not among the rarest'
          : t.rarity >= 10 ? 'uncommon \u2014 expect it to need deliberate effort'
          : t.rarity >= 5 ? 'few players have this; treat it as a real obstacle'
          : 'one of the rarest here \u2014 likely what stands between you and the platinum';
        html += `<div class="guide-section"><div class="guide-section-title">What the rarity says</div><div class="guide-tip"><strong>${t.rarity}% of players have this (${esc(S.easeTierOf(t.rarity))}).</strong> ${esc(readMe)}</div></div>`;
      }
      if (!deepLink && !verdict) {
        const anyGuide = (g.guide && g.guide.url) || (g.psnpGuide ? 'https://psnprofiles.com' + g.psnpGuide : null);
        html += `<div class="guide-section"><div class="guide-section-title">No written guide</div><div class="guide-tip">${anyGuide
          ? `No guide covers this trophy individually, but the game&rsquo;s guide may help: <a href="${esc(anyGuide)}" target="_blank" rel="noopener">open it</a>.`
          : `Nobody has written a trophy guide for ${esc(g.title)} \u2014 usually because it is new or niche. The description and rarity above are genuinely all the information that exists.`}</div></div>`;
      }
    }
    $('guide-body').innerHTML = html;
    $('guide-source').innerHTML = guide && guide.source ? `Source: <a href="${esc(guide.source.url)}" target="_blank" rel="noopener">${esc(guide.source.label)}</a>` : (g.guide ? `Facts: <a href="${esc(g.guide.url)}" target="_blank" rel="noopener">PowerPyx</a>` : '');
    openDialog($('guideOverlay'), $('guideOverlay').querySelector('.guide-close'));
  }
  function closeGuide() { const g = $('guideOverlay'); if (g.classList.contains('open')) closeDialog(g); }

  // ---------- toast ----------
  function toast(text, onUndo) {
    const el = $('complete-toast'); $('ct-body').textContent = text;
    $('ct-undo').onclick = () => { el.classList.remove('show'); onUndo && onUndo(); };
    $('ct-close').onclick = () => el.classList.remove('show');
    el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 8000);
  }

  // ---------- export / import ----------
  function exportState() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), checked, starred }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `trophy-tracker-state-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  /** Copy only plain own string->true entries; never let __proto__ or nested objects through. */
  function sanitiseFlags(src) {
    const out = Object.create(null);
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    for (const k of Object.getOwnPropertyNames(src)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (src[k] === true) out[k] = true;
    }
    return out;
  }
  function importState(file) {
    const r = new FileReader();
    r.onload = () => {
      let o;
      try { o = JSON.parse(r.result); } catch (e) { toast('Import failed: that file is not valid JSON.'); return; }
      const c = sanitiseFlags(o && o.checked), st = sanitiseFlags(o && o.starred);
      if (!c && !st) { toast('Import failed: no "checked" or "starred" data in that file.'); return; }
      const before = { checked: { ...checked }, starred: { ...starred } };
      Object.assign(checked, c || {}); Object.assign(starred, st || {});
      save(LS.checked, checked); save(LS.starred, starred); invalidate(); renderAll();
      toast(`Merged ${Object.keys(c || {}).length} ticks and ${Object.keys(st || {}).length} stars into what you already had.`,
        () => { checked = before.checked; starred = before.starred; save(LS.checked, checked); save(LS.starred, starred); invalidate(); renderAll(); });
    };
    r.onerror = () => toast('Import failed: could not read that file.');
    r.readAsText(file);
  }

  // ---------- events (delegated) ----------
  document.addEventListener('click', (e) => {
    const stop = e.target.closest('[data-stop]'); if (stop) { e.stopPropagation(); return; }
    const el = e.target.closest('[data-action]'); if (!el) return;
    const key = el.dataset.key ? unattr(el.dataset.key) : null;
    const act = el.dataset.action;
    if (act !== 'toggle') e.stopPropagation();
    switch (act) {
      case 'check': e.preventDefault(); toggleCheck(key, unattr(el.dataset.trophy)); break;
      case 'star': toggleStar(key); if ($('modal').classList.contains('open')) $('rec-star').textContent = isStarred(key) ? '★ Starred' : '☆ Star it'; break;
      case 'toggle': toggleDrawer(key); break;
      case 'focus': closeModal(); focusGame(key); break;
      case 'reset': resetChecks(key, 'Reset'); break;
      case 'reopen': resetChecks(key, 'Reopened'); break;
      case 'guide': openGuide(key, unattr(el.dataset.trophy)); break;
      case 'genre': ui.genre = el.dataset.genre; persistUi(); document.querySelectorAll('#genreFilters .pill').forEach((b) => b.classList.toggle('active', b === el)); renderGrid(); break;
      case 'range': ui.range = el.dataset.range; persistUi(); document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b === el)); renderGrid(); break;
      case 'tab': switchTab(el.dataset.tab); break;
      case 'suggest': suggest(false); break;
      case 'suggest-next': suggest(true); break;
      case 'close-modal': closeModal(); break;
      case 'close-guide': closeGuide(); break;
      case 'toggle-lane': ui.collapsed[el.dataset.lane] = !ui.collapsed[el.dataset.lane]; persistUi(); renderLanes(); break;
      case 'export': exportState(); break;
      case 'import': $('import-file').click(); break;
      case 'bl-filter': ui.bl = el.dataset.bl; persistUi(); document.querySelectorAll('[data-action="bl-filter"]').forEach((b) => b.classList.toggle('active', b === el)); renderBacklog(); break;
    }
  });
  document.addEventListener('keydown', (e) => {
    trapTab(e);
    if (e.key === 'Escape') { closeModal(); closeGuide(); }
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); $('search').focus(); }
  });
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  $('guideOverlay').addEventListener('click', (e) => { if (e.target === $('guideOverlay')) closeGuide(); });
  let searchTimer;
  $('search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { ui.q = e.target.value; persistUi(); renderGrid(); }, 120); });
  $('sort').addEventListener('change', (e) => { ui.sort = e.target.value; persistUi(); renderGrid(); });
  $('platform').addEventListener('change', (e) => { ui.platform = e.target.value; persistUi(); renderGrid(); });
  $('search-comp').addEventListener('input', renderCompleted); $('sort-comp').addEventListener('change', renderCompleted);
  let blTimer;
  $('search-backlog').addEventListener('input', () => { clearTimeout(blTimer); blTimer = setTimeout(renderBacklog, 120); });
  $('sort-backlog').addEventListener('change', renderBacklog);
  $('import-file').addEventListener('change', (e) => { if (e.target.files[0]) importState(e.target.files[0]); e.target.value = ''; });

  // ---------- init ----------
  async function init() {
    const [slim, enriched, overrides, guidesFile, library, meta] = await Promise.all([
      fetchJson('./data/progress.slim.json', null), fetchJson('./data/enriched.json', {}), fetchJson('./data/overrides.json', {}),
      fetchJson('./data/guides.json', {}), fetchJson('./data/library.json', null), fetchJson('./data/sync-meta.json', null),
    ]);
    // progress.slim.json is the build artifact (earned trophies collapsed to counts);
    // fall back to the full file so the app still works before the first build.
    const progress = slim || await fetchJson('./data/progress.json', null);
    if (!progress) { $('grid').innerHTML = '<div class="empty">Failed to load trophy data. Run <code>node tools/build-slim.mjs</code>.</div>'; return; }
    LIBRARY = library; META = meta;
    GUIDES = Object.assign({}, window.TROPHY_GUIDES || {}, guidesFile || {});
    for (const [key, raw] of Object.entries(progress)) {
      if (key.startsWith('_')) continue;
      GAMES[key] = buildModel(key, raw, enriched[key], overrides[key]);
    }
    // "as of" = newest known activity in the data, so recency math is stable between syncs
    const dates = Object.values(GAMES).map((g) => S.lastPlayedOf({ lastPlayed: g.lastPlayed, earned: g.earnedBase })).filter(Boolean);
    dataAsOf = (META && S.parseDate(META.syncedAt)) || (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : new Date());
    const asof = $('data-asof');
    const staleDays = Math.round((new Date() - dataAsOf) / 86400000);
    asof.textContent = `Data as of ${fmtDate(dataAsOf.toISOString())}${staleDays > 14 ? ` (${staleDays}d old)` : ''}`;
    asof.classList.toggle('stale', staleDays > 14);
    asof.title = (META && META.syncedAt)
      ? `Synced ${fmtDate(META.syncedAt)} from ${META.source || 'PSN'}: ${META.games} games, ${META.trophiesRemaining} trophies remaining`
      : 'Dated from the newest trophy in progress.json. Run npm run sync (or the PSNProfiles scrape) to refresh.';
    buildFilters();
    recompute(); renderLanes(); renderGrid();
    switchTab(ui.tab || 'incomplete');
    if (loadProblems.length) {
      console.warn('Trophy tracker data problems:', loadProblems);
      toast(`Some data could not be loaded, so parts of this page may be wrong: ${loadProblems.join('; ')}`);
    }
  }
  init().catch((e) => { console.error(e); $('grid').innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`; });
})();
