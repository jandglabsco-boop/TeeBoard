// TeeBoard service worker.
//
// Three jobs, and the order matters:
//   1. always show the current app when there is signal
//   2. keep the app shell available when there isn't
//   3. never cache Supabase — scores and leaderboards must be live
//
// Score writes that fail offline are queued in the page (see app.js), not
// here, because they need the app's auth context to replay.
//
// Bump VERSION whenever the shell changes. The activate handler deletes every
// other cache, so a bump is what actually retires the old copy.
const VERSION = "teeboard-v3";

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// The files that define what the app looks like and how it behaves. These are
// fetched network-first: a cache-first shell meant a returning visitor saw the
// previous release and only got the new one on their *next* visit — and since
// index.html carries the ?v= on app.js, an old shell pinned an old script too.
// Redesigns and fixes both sat invisible behind that.
const NETWORK_FIRST = /\/(index\.html|app\.js|config\.js)(\?|$)|\/$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // Individually, so one 404 can't abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (response && response.status === 200 && response.type === "basic") {
    const copy = response.clone();
    caches.open(VERSION).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Anything that talks to Supabase or Stripe goes straight to the network.
  // A cached leaderboard would be worse than no leaderboard.
  if (url.hostname.endsWith("supabase.co") || url.hostname.includes("stripe")) return;

  const isShell = request.mode === "navigate" || NETWORK_FIRST.test(url.pathname + url.search);

  if (isShell) {
    // Network first, cache as the fallback. On a course with no signal this
    // still opens instantly from cache; with signal it is always current.
    event.respondWith(
      fetch(request)
        .then((response) => putInCache(request, response))
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Everything else — icons, fonts, libraries — changes rarely and is worth
  // serving instantly from cache, refreshing quietly behind the scenes.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => putInCache(request, response))
        .catch(() => cached);
      return cached || network;
    })
  );
});
