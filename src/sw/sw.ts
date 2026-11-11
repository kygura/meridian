/// <reference lib="webworker" />
// Meridian's service worker (ADR 0016). Bundled to /sw.js by scripts/vite-plugin-sw.ts,
// which fills in the precache list and version. Routing rules live in strategy.ts.
//
// Caches:
//   meridian-shell-<version>  the built app (index.html, JS, CSS, fonts, icons, map glyphs)
//   meridian-data-v1          public API answers (cities, climate, scores, news)
//   meridian-map-v1           map resources from other hosts, bounded
//   meridian-static-v1        other same-origin files, on first use
//   meridian-private-v1       the owner's data (trips, journal, bookings, watches, notices)
//
// The private cache is only ever a fallback for a failed network request, is emptied
// when the page says the journal was locked ("purge-private") and whenever a personal
// route answers 401, and never stores anything but a 200.

import { CACHE_LIMITS, isPrivateApiPath, isStorable, overLimit, routeFor, type SwRoute } from "./strategy";

declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __SW_VERSION__: string;
declare const __API_ORIGIN__: string;

const SHELL = `meridian-shell-${__SW_VERSION__}`;
const DATA = "meridian-data-v1";
const MAP = "meridian-map-v1";
const STATIC = "meridian-static-v1";
const PRIVATE = "meridian-private-v1";
const KEEP = new Set([SHELL, DATA, MAP, STATIC, PRIVATE]);

const PRECACHED = new Set(__PRECACHE__);
const CACHE_FOR: Partial<Record<SwRoute, { name: string; max: number }>> = {
  private: { name: PRIVATE, max: CACHE_LIMITS.private },
  data: { name: DATA, max: CACHE_LIMITS.data },
  map: { name: MAP, max: CACHE_LIMITS.map },
  static: { name: STATIC, max: CACHE_LIMITS.static },
};

/** Public data worth having before the first offline visit; fetched after install, best effort. */
const WARM = ["/api/cities?limit=10000", "/api/seasonality/cities", "/api/seasonality/regions", "/api/livability"].map((p) => (__API_ORIGIN__ || self.location.origin) + p);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // cache: "reload" so a stale HTTP cache can't hand us an old file under a new version.
      await cache.addAll(__PRECACHE__.map((path) => new Request(path, { cache: "reload" })));
      // First install has nothing to protect: take over straight away. An update waits
      // until the page asks (the "Reload" prompt), so a tab never runs half old, half new.
      if (!self.registration.active) await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("meridian-") && !KEEP.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
      void warm();
    })()
  );
});

async function warm(): Promise<void> {
  // Country outlines ship with the app (public/geo), so the precache already has them.
  const cache = await caches.open(DATA);
  for (const url of WARM) {
    try {
      if (await cache.match(url)) continue;
      const res = await fetch(url);
      if (res.status === 200) await cache.put(url, res);
    } catch {
      // Offline or blocked: the page's own request will fill it later.
    }
  }
}

async function trim(name: string, max: number): Promise<void> {
  const cache = await caches.open(name);
  for (const key of overLimit(await cache.keys(), max)) await cache.delete(key);
}

async function save(route: SwRoute, request: Request, response: Response): Promise<void> {
  const target = CACHE_FOR[route];
  if (!target || !isStorable(response, route)) return;
  const cache = await caches.open(target.name);
  // Re-inserting moves the entry to the end, so trimming drops the least recently fetched.
  await cache.delete(request.url);
  await cache.put(request.url, response);
  await trim(target.name, target.max);
}

let lastNetOk: boolean | undefined;
/** Tell open pages when API requests start failing or working again (the offline indicator). */
async function reportNet(ok: boolean): Promise<void> {
  if (lastNetOk === ok) return;
  lastNetOk = ok;
  for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "net", ok });
}

/** Network first; the saved copy only when the network fails. */
async function networkFirst(event: FetchEvent, route: "private" | "data"): Promise<Response> {
  const { request } = event;
  try {
    const response = await fetch(request);
    void reportNet(true);
    if (route === "private" && response.status === 401) {
      // Locked, logged out or a rejected token: nothing personal stays on the device.
      event.waitUntil(caches.delete(PRIVATE));
    } else {
      event.waitUntil(save(route, request, response.clone()));
    }
    return response;
  } catch (err) {
    void reportNet(false);
    const cached = await (await caches.open(CACHE_FOR[route]!.name)).match(request.url);
    if (cached) return cached;
    throw err;
  }
}

/** Saved copy first (these files don't change under one URL); fetch and keep on a miss. */
async function cacheFirst(event: FetchEvent, route: "map" | "static"): Promise<Response> {
  const { request } = event;
  const cached = await (await caches.open(CACHE_FOR[route]!.name)).match(request.url);
  if (cached) return cached;
  const response = await fetch(request);
  event.waitUntil(save(route, request, response.clone()));
  return response;
}

async function fromShell(request: Request, path: string): Promise<Response> {
  const cached = await (await caches.open(SHELL)).match(path);
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const route = routeFor(
    { method: request.method, url: request.url, mode: request.mode },
    { origin: self.location.origin, apiOrigin: __API_ORIGIN__, precached: PRECACHED }
  );
  switch (route) {
    case "navigate":
      return event.respondWith(fromShell(request, "/index.html"));
    case "shell":
      return event.respondWith(fromShell(request, new URL(request.url).pathname));
    case "private":
    case "data":
      return event.respondWith(networkFirst(event, route));
    case "map":
    case "static":
      return event.respondWith(cacheFirst(event, route));
    default:
      // Writes and everything else go straight to the network. A write to a personal
      // route that comes back 401 still means the device should forget what it kept.
      if (request.method !== "GET" && isPrivateApiPath(new URL(request.url).pathname)) {
        event.respondWith(
          fetch(request).then((response) => {
            if (response.status === 401) event.waitUntil(caches.delete(PRIVATE));
            return response;
          })
        );
      }
  }
});

self.addEventListener("message", (event) => {
  const type = (event.data as { type?: string } | null)?.type;
  if (type === "skip-waiting") void self.skipWaiting();
  if (type === "purge-private") event.waitUntil(caches.delete(PRIVATE));
});

// ── Web Push ────────────────────────────────────────────────────────

interface PushPayload {
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    payload = { title: "Meridian", body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Meridian", {
      body: payload.body ?? "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: payload.id,
      data: { url: payload.url ?? "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | null)?.url ?? "/";
  // Only ever open this app.
  const target = new URL(raw, self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
        open.postMessage({ type: "navigate", url });
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
