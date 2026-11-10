// The service worker's routing rules, kept pure so they can be tested (ADR 0016).
// sw.ts applies them; nothing here touches the Cache API or the network.

export type SwRoute =
  /** A file of the installed app: answered from the precache. */
  | "shell"
  /** A page load: the precached index.html (the app routes by hash). */
  | "navigate"
  /** Personal data: network first; a saved copy only when the network fails. Purged on lock. */
  | "private"
  /** Public reference data from the API (cities, climate, scores, news): network first, saved copy offline. */
  | "data"
  /** Map resources from other hosts (country outlines, any tile server): saved on first use, bounded. */
  | "map"
  /** Same-origin static files that are not in the precache. */
  | "static"
  /** Not ours to handle: writes, streams, other hosts. */
  | "pass";

/** API areas that hold the owner's data. Their GETs go to the private cache. */
export const PRIVATE_API_PREFIXES = [
  "/api/journal",
  "/api/trips",
  "/api/bookings",
  "/api/watches",
  "/api/import",
  "/api/notifications",
  "/api/shortlist",
  "/api/replay",
] as const;

/**
 * GETs that must not be answered from a saved copy: they do work or stream, or, for
 * /api/trips, feed a sync. Trips are already kept in the browser (localStorage) and merged
 * three ways against the server (lib/tripSync); an old server snapshot served as if it were
 * current would make that merge undo edits made since.
 */
const NEVER_CACHE = [/^\/api\/trips(\/|$)/, /^\/api\/agent(\/|$)/, /^\/api\/health$/, /^\/api\/jobs(\/|$)/, /\/run$/, /^\/api\/notifications\/test$/];

/** Hosts the map loads from besides this one. */
export const MAP_HOSTS = ["d2ad6b4ur7yvpq.cloudfront.net"] as const;
/** Slippy-map tile paths (/z/x/y.ext) and vector/glyph tiles, whatever the host. */
const TILE_PATH = /\/\d{1,2}\/\d+\/\d+(@2x)?(\.[a-z0-9]+)?$|\.(pbf|mvt)$/i;

export const CACHE_LIMITS = { private: 200, data: 400, map: 400, static: 100 } as const;

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function isPrivateApiPath(path: string): boolean {
  return PRIVATE_API_PREFIXES.some((p) => under(path, p));
}

export interface RouteInput {
  method: string;
  url: string;
  /** Request.mode; "navigate" for page loads. */
  mode?: string;
}

export interface RouteContext {
  /** The app's own origin. */
  origin: string;
  /** Origin of VITE_API_BASE_URL when the API is served elsewhere; "" otherwise. */
  apiOrigin?: string;
  /** Paths in the precache ("/index.html", "/assets/app-abc.js"). */
  precached: ReadonlySet<string>;
}

export function routeFor(req: RouteInput, ctx: RouteContext): SwRoute {
  if (req.method !== "GET") return "pass";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "pass";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "pass";
  const sameOrigin = url.origin === ctx.origin;
  const isApi = (sameOrigin || (!!ctx.apiOrigin && url.origin === ctx.apiOrigin)) && under(url.pathname, "/api");

  if (isApi) {
    if (NEVER_CACHE.some((re) => re.test(url.pathname))) return "pass";
    return isPrivateApiPath(url.pathname) ? "private" : "data";
  }
  if (sameOrigin) {
    if (req.mode === "navigate") return "navigate";
    if (ctx.precached.has(url.pathname)) return "shell";
    return "static";
  }
  if ((MAP_HOSTS as readonly string[]).includes(url.hostname) || TILE_PATH.test(url.pathname)) return "map";
  return "pass";
}

/** Which of `keys` (oldest first, as Cache.keys() returns them) to delete so at most `max` remain. */
export function overLimit<T>(keys: readonly T[], max: number): T[] {
  return keys.length > max ? keys.slice(0, keys.length - max) : [];
}

/** Only complete, successful answers are worth keeping. `opaque` covers no-cors tile images. */
export function isStorable(res: { status: number; type?: string }, route: SwRoute): boolean {
  if (res.status === 200) return true;
  return route === "map" && res.type === "opaque";
}
