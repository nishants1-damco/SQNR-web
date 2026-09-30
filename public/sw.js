/**
 * SQNR service worker — installability + light shell caching.
 *
 * The capture flow itself is not offline-safe (API writes, cloud LLM calls),
 * so this deliberately avoids caching data endpoints. It only:
 *   1) Marks the app as installable per PWA install-criteria (needs a fetch handler).
 *   2) Serves the app shell (HTML, JS, CSS) from cache-first on repeat visits
 *      so the catalog loads instantly even on flaky 4G.
 * Allowlist, not blocklist: only static assets and page navigations are ever
 * cached. Everything else goes straight to the network: the API (`/v1/…`, whose
 * responses carry private per-user data), and signed Blob Storage URLs
 * (frames and thumbnails: private, and they expire).
 */
// v3: the SPA on the Spatial Capture API replaces the TanStack Start app.
// Bumping the version makes `activate` delete the old app's shell cache.
const VERSION = "sqnr-shell-v3";
const SHELL = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => undefined)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API traffic, auth flows or signed (SAS) Blob URLs.
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/.well-known/")) return;
  if (url.searchParams.has("sig")) return;
  // Cache-first for static assets, network-first for page navigations.
  // Anything else is not ours to cache.
  const isAsset = /\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname);
  if (!isAsset && req.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      if (isAsset) {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return hit ?? Response.error();
        }
      }
      // HTML: network first, fall back to cached shell.
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) ?? (await cache.match("/")) ?? Response.error();
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Background Sync scaffold — when the capture page can't reach the server
// (offline or a transient network failure), it registers a `sync` event
// with tag "sqnr-upload-<captureId>". This handler is called by the
// browser when connectivity returns. Full implementation lives client-side
// (it needs the session + IndexedDB blob refs), so for now we just
// broadcast an event to any open client and let it retry.
// ---------------------------------------------------------------------------
self.addEventListener("sync", (event) => {
  if (!event.tag || !event.tag.startsWith("sqnr-upload-")) return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "sqnr:retry-upload", tag: event.tag });
      }
    })(),
  );
});
