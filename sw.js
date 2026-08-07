// TeeBoard service worker.
//
// Two jobs, and the second is the one that matters on a course:
//   1. keep the app shell available with no signal
//   2. never cache Supabase — scores and leaderboards must always be live
//
// Score writes that fail offline are queued in the page (see app.js), not
// here, because they need the app's auth context to replay.

const VERSION = "teeboard-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Anything that talks to Supabase or Stripe goes straight to the network.
  // A cached leaderboard would be worse than no leaderboard.
  if (url.hostname.endsWith("supabase.co") || url.hostname.includes("stripe")) return;

  // Everything else: serve from cache first so the app opens instantly and
  // works with no signal, refreshing the copy in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
