// Service worker — precache the app shell so Swim Coach installs and works
// offline (e.g. poolside with no signal).
//
// SCOPE: this file lives at the app root and is registered as `/sw.js`, giving
// it scope `/`. That is deliberate — the web app at /web/ imports engine
// modules from /src/ (via `../src/*.js`), so BOTH trees must be in scope and
// cached. A /web/-scoped worker could not see /src/ requests.
//
// STRATEGY: cache-first for our own (same-origin) static assets; navigations
// fall back to the cached app shell. Cross-origin calls (GitHub + Gemini APIs)
// are NOT intercepted — they hit the network and fail gracefully offline (the
// app already falls back to its template library and local catalogue).
//
// UPDATING: bump CACHE (v1 → v2 …) whenever a precached file changes. The new
// worker precaches the new set, activates immediately (skipWaiting), and the
// activate handler deletes the old cache — so a reload gets a consistent set.
//
// PATHS are RELATIVE to this script's location (the app root) — never absolute
// `/web/…` — so the app deploys to a project sub-path (e.g.
// user.github.io/swim-coach/) as cleanly as to a domain root.

const CACHE = 'swimcoach-v6';

const SHELL = [
  'web/',
  'web/index.html',
  'web/styles.css',
  'web/app.js',
  'web/manifest.webmanifest',
  'web/icons/icon.svg',
  'web/seed-catalogue.json',
  'web/seed-catalogue.demo.json',
  'web/fonts/InterVariable.woff2',
  'web/vendor/chart.umd.js',
  'docs/coaching-project-brief.md',
  'knowledge/swimming-coaching-kb.md',
  'src/schema.js',
  'src/garmin-parser.js',
  'src/phases.js',
  'src/block-state.js',
  'src/targets.js',
  'src/flags.js',
  'src/flag-rules.js',
  'src/classify.js',
  'src/validator.js',
  'src/fallback-library.js',
  'src/symptom-mapper.js',
  'src/catalogue-writer.js',
  'src/session-analysis.js',
  'src/gemini.js',
  'src/github-sync.js',
  'src/block-report.js',
  'src/orchestrator.js',
  'src/renderer.js',
  'src/series.js',
].map(p => new URL(p, self.location.href).href);

// The app shell to fall back to for navigations when offline (absolute).
const SHELL_INDEX = new URL('web/index.html', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only our own origin. GitHub/Gemini API calls go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell when the network is unavailable.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req, { ignoreSearch: true }))
          || (await cache.match(SHELL_INDEX))
          || Response.error();
      }
    })());
    return;
  }

  // Static assets: cache-first, then network (caching any new same-origin GET).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return cached || Response.error();
    }
  })());
});
