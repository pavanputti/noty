// Noty offline support.
// - The app itself (HTML, scripts, styles, fonts, icons) is cached, so Noty opens without a connection.
// - Notebooks, PDFs and handwriting you've opened are cached too (newest copy wins when online).
// - Saving while offline is handled by the app: changes wait on this device and sync when you're back.
const VERSION = "noty-v1";
const APP = `${VERSION}-app`;
const DATA = `${VERSION}-data`;
const FILES = `${VERSION}-files`; // built files with unique names; capped so old versions get dropped
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
// Server-only routes: sign-in, OAuth and MCP must always go to the network.
const NEVER = [/^\/(login|logout|auth|authorize|oauth|mcp|\.well-known)(\/|$)/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const networkFirst = async (req, cacheName, fallbackUrl) => {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackUrl ?? req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(fallbackUrl ?? req)) ?? (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "offline", message: "You're offline and this hasn't been opened on this device before." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const MAX_FILES = 300; // old versions of the app's files are dropped, so the cache doesn't grow forever
const cacheFirst = async (req) => {
  const cache = await caches.open(FILES); // never the app shell ("/", manifest), which lives in APP
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) await cache.delete(k);
  }
  return res;
};

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache so the app looks right offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return event.respondWith(cacheFirst(req));
  if (url.origin !== location.origin) return;
  if (NEVER.some((r) => r.test(url.pathname))) return;

  // Built files have unique names, so a cached copy is always right.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) return event.respondWith(cacheFirst(req));

  // Notebook data: fresh when online, last copy when offline. (Live updates and uploads aren't cached.)
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.endsWith("/live") || url.pathname.startsWith("/api/search")) return;
    return event.respondWith(networkFirst(req, DATA));
  }

  // Pages (/, /n/…, /p/…): the app shell.
  if (req.mode === "navigate") return event.respondWith(networkFirst(req, APP, "/"));
});
