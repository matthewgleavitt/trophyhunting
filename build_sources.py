import json, time, urllib.parse, random
import requests
from bs4 import BeautifulSoup
from pathlib import Path

PROGRESS_PATH = Path("data/progress.json")
OUT_PATH = Path("data/sources.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://duckduckgo.com/"
}

# Use the "lite" endpoint; it tends to be less aggressively blocked than /html/
DDG_LITE = "https://lite.duckduckgo.com/lite/?q="

def ddg_search(query, max_results=3, retries=4):
    url = DDG_LITE + urllib.parse.quote(query)

    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=25)
            # If blocked, back off and retry
            if r.status_code in (403, 429):
                wait = (2 ** attempt) + random.random()
                print(f"  DDG blocked ({r.status_code}). Backing off {wait:.1f}s…")
                time.sleep(wait)
                continue

            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")

            results = []
            # DDG lite uses links like: <a rel="nofollow" class="result-link" href="...">
            for a in soup.select("a.result-link")[:max_results]:
                href = a.get("href")
                title = a.get_text(" ", strip=True)
                if href and title:
                    results.append({"title": title, "url": href})
            return results

        except Exception as e:
            last_err = e
            wait = (2 ** attempt) + random.random()
            print(f"  Error: {e} — retrying in {wait:.1f}s")
            time.sleep(wait)

    # Give up for this query
    print(f"  Giving up on query after {retries} tries: {query}")
    return []

def best_hit(game, pattern):
    q = pattern.format(game=game)
    hits = ddg_search(q, max_results=5)
    return hits[0] if hits else None

def main():
    progress = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
    games = [
    g for g, data in progress.items()
    if isinstance(data.get("unearned"), list) and len(data["unearned"]) > 0
]

    # Resume if file exists
    if OUT_PATH.exists():
        sources = json.loads(OUT_PATH.read_text(encoding="utf-8"))
    else:
        sources = {}

    total = len(games)

    for i, game in enumerate(games, 1):
        if game in sources:
            # Already done from a previous run
            continue

        print(f"[{i}/{total}] {game}")

        try:
            psnp = best_hit(game, '"{game}" site:psnprofiles.com guide trophy')
            powerpyx = best_hit(game, '"{game}" site:powerpyx.com trophy guide')
            truetrophies = best_hit(game, '"{game}" site:truetrophies.com guide trophy')
            forums = best_hit(game, '"{game}" trophy guide forum missable')
        except Exception as e:
            # Shouldn't happen often now, but never crash the run
            print(f"  Unexpected error on {game}: {e}")
            psnp = powerpyx = truetrophies = forums = None

        sources[game] = {
            "psnprofiles": psnp,
            "powerpyx": powerpyx,
            "truetrophies": truetrophies,
            "forums": forums,
        }

        # Write incrementally so you never lose progress
        OUT_PATH.write_text(json.dumps(sources, indent=2), encoding="utf-8")

        # Be polite / reduce blocks
        time.sleep(1.4 + random.random() * 0.6)

    print(f"\nWrote {OUT_PATH} (total games: {len(sources)})")

if __name__ == "__main__":
    main()
