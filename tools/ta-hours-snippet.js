/* ta-hours-snippet.js — cross-reference Xbox achievement data for PS games.
 *
 * Matt's idea: multiplatform games usually share an identical achievement/trophy list, and
 * TrueAchievements (the larger, older sibling of TrueTrophies) carries a time estimate and
 * a walkthrough for far more games than PSNProfiles or PowerPyx do.
 *
 * Run on https://www.trueachievements.com (any page), in your own Chrome:
 *   1. paste this file        2. wait for __ta.running === false        3. taDownload()
 *   4. move ta-hours.json into data/ and run: node tools/merge-ta.mjs
 *
 * It only reads public game pages, one every ~1.5s. Call taDownload() periodically.
 *
 * DO NOT use TrueAchievements' search endpoint to resolve names. It rate-limits to 403
 * almost immediately, and its results page is padded with unrelated recommendations — a
 * search pass here matched "Fruit Ninja VR" to Marvel Rivals and "Trine 2" to CyberBot
 * Zero. Direct /game/<slug>/achievements URLs return a clean 404 when a game is absent,
 * which is the honest answer. Many PlayStation titles simply are not on Xbox.
 */
(async () => {
  const LIST = window.__taList;        // [[progressKey, slug], ...]
  if (!LIST) { console.error('set window.__taList first'); return; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = (window.__ta = { list: LIST, i: 0, results: {}, misses: [], running: true, startedAt: Date.now() });
  window.taState = () => ({ i: T.i, total: T.list.length, got: Object.keys(T.results).length, missed: T.misses.length, running: T.running, min: Math.round((Date.now() - T.startedAt) / 60000) });

  for (; T.i < LIST.length; T.i++) {
    const [key, slug] = LIST[T.i];
    try {
      const res = await fetch('/game/' + slug + '/achievements', { credentials: 'include' });
      if (!res.ok) { T.misses.push([key, slug, res.status]); await sleep(900); continue; }
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const txt = (doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ' ');
      const hrs = txt.match(/takes around ([\d.]+)(?:-([\d.]+))?\s*hours?/i);
      const n = txt.match(/Full list of all (\d+)/i);
      const hasWalk = [...doc.querySelectorAll('a')].some((a) => new RegExp('/game/' + slug + '/walkthrough', 'i').test(a.getAttribute('href') || ''));
      if (!hrs && !hasWalk) { T.misses.push([key, slug, 'no data']); await sleep(900); continue; }
      T.results[key] = {
        slug,
        hoursMin: hrs ? Number(hrs[1]) : null,
        hoursMax: hrs ? Number(hrs[2] || hrs[1]) : null,
        achievements: n ? +n[1] : null,
        walkthrough: hasWalk ? 'https://www.trueachievements.com/game/' + slug + '/walkthrough' : null,
        url: 'https://www.trueachievements.com/game/' + slug + '/achievements',
      };
    } catch (e) { T.misses.push([key, slug, String(e.message).slice(0, 40)]); }
    try { localStorage.setItem('taHours.v1', JSON.stringify(T.results)); } catch (e) {}
    await sleep(1500);
  }
  T.running = false;
  console.log('done:', Object.keys(T.results).length, 'found,', T.misses.length, 'missed. Run taDownload()');
})();
window.taDownload = function () {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(window.__ta.results)], { type: 'application/json' }));
  a.download = 'ta-hours.json'; a.click();
  return Object.keys(window.__ta.results).length + ' games';
};
