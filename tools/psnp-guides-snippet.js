/* Second pass: PSNProfiles guide overviews ("8/10 Difficulty · 3 Playthroughs · 15 Hours"
 * plus the per-trophy Missable / Online / Difficulty-Specific tags).
 *
 * Run AFTER the main scrape, in the same tab:
 *   1. paste this file,  2. wait for __psnpg.running === false,  3. psnpgDownload()
 *   4. move psnp-guides.json into data/ and re-run  node tools/merge-psnp.mjs
 *
 * Only guides for games you have not finished are fetched, at the same polite pace.
 */
(async () => {
  const P = window.__psnp;
  if (!P) { console.error('run the main scrape first'); return; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const urls = [...new Set(Object.values(P.results).map((g) => g.guide).filter(Boolean))];
  const G = (window.__psnpg = { urls, i: 0, results: {}, errors: [], running: true, spacing: 3200, startedAt: Date.now() });
  window.psnpgState = () => ({ i: G.i, total: G.urls.length, got: Object.keys(G.results).length, err: G.errors.length, running: G.running, min: Math.round((Date.now() - G.startedAt) / 60000) });

  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const txt = doc.body.textContent.replace(/\s+/g, ' ');
    const grab = (re) => { const m = txt.match(re); return m ? m[1] : null; };
    const difficulty = grab(/([\d.]+)\s*\/\s*10\s*Difficulty/i);
    const playthroughs = grab(/(\d+)\s*Playthroughs?/i);
    const hours = grab(/([\d.]+)(?:\s*-\s*[\d.]+)?\s*Hours?/i);
    const hoursHi = (txt.match(/[\d.]+\s*-\s*([\d.]+)\s*Hours?/i) || [])[1];
    // per-trophy status tags: <td><span class="tag Status">Missable</span></td><td>…trophy links…</td>
    const tags = {};
    for (const tr of doc.querySelectorAll('tr')) {
      const tag = tr.querySelector('span.tag');
      if (!tag) continue;
      const label = tag.textContent.trim();
      if (!/missable|unmissable|online|difficulty specific|stackable|buggy|glitch/i.test(label)) continue;
      for (const a of tr.querySelectorAll('a.trophy, a[href^="#"]')) {
        const name = a.textContent.trim();
        if (!name) continue;
        (tags[name] = tags[name] || []).push(label);
      }
    }
    return { difficulty: difficulty ? Number(difficulty) : null, playthroughs: playthroughs ? Number(playthroughs) : null,
             hoursMin: hours ? Number(hours) : null, hoursMax: hoursHi ? Number(hoursHi) : (hours ? Number(hours) : null),
             tags, title: (doc.querySelector('h1, .title-bar h3') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim() };
  }

  for (; G.i < urls.length; G.i++) {
    const u = urls[G.i]; let ok = false;
    for (let a = 0; a < 4 && !ok; a++) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (r.status === 429) { G.spacing = Math.min(12000, Math.round(G.spacing * 1.5)); await sleep(30000); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        G.results[u] = parse(await r.text()); ok = true;
      } catch (e) { if (a === 3) G.errors.push([u, String(e.message || e)]); else await sleep(3000); }
    }
    try { localStorage.setItem('psnpGuides.v1', JSON.stringify(G.results)); } catch (e) {}
    await sleep(G.spacing);
  }
  G.running = false; console.log('guides done', Object.keys(G.results).length);
})();
window.psnpgDownload = function () {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(window.__psnpg.results)], { type: 'application/json' }));
  a.download = 'psnp-guides.json'; a.click();
};
