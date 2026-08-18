const SHELL_CACHE = "lisa-shell-v1";
const DATA_CACHE = "lisa-data-v1";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Category data chunks: cache-first. These are large (up to ~1MB) and effectively
  // static reference data — once a category's been opened, re-fetching it every visit
  // just burns bandwidth for no benefit, so we serve the cached copy and only hit the
  // network the first time a given category is opened.
  if (url.pathname.includes("/data/categories/")) {
    event.respondWith(
      caches.open(DATA_CACHE).then((cache) =>
        cache.match(req).then((cached) => cached || fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // manifest.json: network-first, so a fresh deploy is picked up when online, but the
  // app still boots from cache the moment you're offline.
  if (url.pathname.endsWith("/data/manifest.json")) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(DATA_CACHE).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell (html/css/js/icons): cache-first so the UI paints instantly even offline,
  // with a network fallback to pick up updates and refresh the cache in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
