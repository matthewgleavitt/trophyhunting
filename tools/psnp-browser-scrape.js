/* psnp-browser-scrape.js — run INSIDE a logged-out browser tab on https://psnprofiles.com/LabyrinthWorm
 * (PSNProfiles blocks plain HTTP with Cloudflare, but a real browser tab can fetch same-origin pages).
 *
 *   1. Open https://psnprofiles.com/LabyrinthWorm, open DevTools → Console, paste this whole file, press Enter.
 *   2. Wait for  __psnp.running === false  (≈ 2.5 s per unfinished game; HTTP 429 triggers a 20 s backoff).
 *   3. Run  psnpDownload()  → saves psnp-trophies.json; move it to data/psnp-trophies.json.
 *   4. node tools/merge-psnp.mjs   (upgrades data/progress.json with rarity, type, dates, lastPlayed)
 *
 * Only your own public profile is read, at a polite pace. Nothing is posted.
 */
(async () => {
  const USER = 'LabyrinthWorm';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DATE_RE = /(\d{1,2})(?:st|nd|rd|th)\s+([A-Z][a-z]{2})\s+(\d{4})(?:\s+(\d{1,2}:\d{2}:\d{2}\s*[AP]M))?/;

  // 1) every game on the profile (paginated)
  const games = []; const seen = new Set();
  for (let p = 1; p <= 12; p++) {
    const html = await (await fetch(`/${USER}?page=${p}`, { credentials: 'include' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let added = 0;
    for (const tr of doc.querySelectorAll('#gamesTable tr')) {
      const a = tr.querySelector('a.title'); if (!a) continue;
      const href = a.getAttribute('href'); if (seen.has(href)) continue; seen.add(href); added++;
      const info = [...tr.querySelectorAll('.small-info')].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
      const m = (info[0] || '').match(/(\d+) of (\d+)|All (\d+)/);
      games.push({ h: href, t: a.textContent.trim(), e: m ? (m[3] ? +m[3] : +m[1]) : null, n: m ? (m[3] ? +m[3] : +m[2]) : null, d: info[1] || '', p: [...tr.querySelectorAll('.platforms .tag')].map((e) => e.textContent.trim()).join(',') });
    }
    if (!added) break;
    await sleep(1500);
  }
  const todo = games.filter((g) => g.e != null && g.n != null && g.e < g.n).map((g) => g.h);

  // 2) each unfinished game's trophy table
  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('tr')].filter((tr) => tr.querySelector('a.title[href^="/trophy/"]'));
    const trophies = rows.map((tr) => {
      const a = tr.querySelector('a.title'); const td = a.closest('td');
      const desc = td ? td.textContent.replace(a.textContent, '').replace(/\s+/g, ' ').trim() : '';
      const dm = tr.textContent.replace(/\s+/g, ' ').match(DATE_RE);
      const pcts = [...tr.querySelectorAll('.typo-top')].map((e) => e.textContent.trim()).filter((x) => /%$/.test(x)).map(parseFloat);
      const tiers = [...tr.querySelectorAll('.typo-bottom')].map((e) => e.textContent.trim()).filter((x) => /rare|common/i.test(x));
      const sig = [...tr.querySelectorAll('img,span,a')].map((e) => e.className + ' ' + (e.getAttribute('src') || '')).join(' ');
      const tm = sig.match(/\b(bronze|silver|gold|platinum)\b/i);
      return [a.textContent.trim(), desc, tm ? tm[1].toLowerCase() : null, tr.classList.contains('completed') ? 1 : 0, dm ? dm[0] : null, pcts[0] ?? null, pcts[1] ?? null, tiers[0] || null, /unobtainable/i.test(tr.className + ' ' + sig) ? 1 : 0];
    });
    const notes = [...doc.querySelectorAll('.small-title, a.small-title span')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter((t) => /^server shutdown|^delisted|unobtainable/i.test(t));
    const stats = (doc.querySelector('.stats') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
    const title = (doc.querySelector('.title-bar h3') || { textContent: '' }).textContent.replace(/\s+/g, ' ').replace(/^.*›/, '').trim();
    return { t: title, n: trophies.length, e: trophies.filter((x) => x[3]).length, notes, stats, guide: doc.querySelector('a[href*="/guide/"]')?.getAttribute('href') || null, trophies };
  }
  const P = (window.__psnp = { games, todo, i: 0, results: {}, errors: [], running: true, startedAt: Date.now() });
  for (; P.i < todo.length; P.i++) {
    const h = todo[P.i]; let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const r = await fetch(h, { credentials: 'include' });
        if (r.status === 429) { await sleep(20000 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const g = parse(await r.text()); if (!g.n) throw new Error('no rows');
        P.results[h] = g; ok = true;
      } catch (e) { if (attempt === 3) P.errors.push([h, String(e.message || e)]); else await sleep(3000); }
    }
    await sleep(2500);
  }
  P.running = false;
  console.log(`done: ${Object.keys(P.results).length} games, ${P.errors.length} errors. Run psnpDownload() to save.`);
})();
window.psnpDownload = function () {
  const P = window.__psnp; const out = { __scrapedAt: new Date().toISOString(), __games: P.games, ...P.results };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })); a.download = 'psnp-trophies.json'; a.click();
};
