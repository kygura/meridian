import { useEffect, useSyncExternalStore } from "react";

// Meridian v3 routes (DESIGN-v3.md §2). Hash based. Legacy hashes parse to their
// new route; useRoute() also rewrites the address bar to the canonical hash.

export type TripsTab = "upcoming" | "past";
export type PlanTab = "when" | "live" | "repeat" | "watches" | "flights" | "days";

export type Route =
  | { view: "map" }
  | { view: "trips"; tab: TripsTab; tripId?: string; journeyId?: string }
  | { view: "plan"; tab: PlanTab; journeyId?: string; stopIndex?: number }
  | { view: "inbox" }
  | { view: "world" }
  | { view: "rotation" };

export type View = Route["view"];

const PLAN_TABS: PlanTab[] = ["when", "live", "repeat", "watches", "flights", "days"];

const seg = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const enc = encodeURIComponent;

function repeatRoute(journeyId?: string, stopIndex?: string): Route {
  const r: Route = { view: "plan", tab: "repeat" };
  if (journeyId) r.journeyId = seg(journeyId);
  if (journeyId && stopIndex !== undefined) r.stopIndex = Number(stopIndex);
  return r;
}

/** Parse a location hash ("#/trips/past/j1", "", "#/") into a Route. Unknown paths go to the map. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "") || "/";
  let m: RegExpMatchArray | null;

  if (path === "/") return { view: "map" };
  if (path === "/inbox") return { view: "inbox" };
  if (path === "/world") return { view: "world" };
  if (path === "/rotation") return { view: "rotation" };

  // Trips
  if (path === "/trips" || path === "/trips/upcoming" || path === "/trips/plan") {
    return { view: "trips", tab: "upcoming" };
  }
  if (path === "/trips/past") return { view: "trips", tab: "past" };
  if ((m = path.match(/^\/trips\/plan\/([^/]+)$/))) return { view: "trips", tab: "upcoming", tripId: seg(m[1]) };
  if ((m = path.match(/^\/trips\/past\/([^/]+)$/))) return { view: "trips", tab: "past", journeyId: seg(m[1]) };
  // Legacy #/trips/<id>
  if ((m = path.match(/^\/trips\/([^/]+)$/))) return { view: "trips", tab: "upcoming", tripId: seg(m[1]) };

  // Plan
  if (path === "/plan") return { view: "plan", tab: "when" };
  if ((m = path.match(/^\/plan\/repeat(?:\/([^/]+)(?:\/(\d+))?)?$/))) return repeatRoute(m[1], m[2]);
  if ((m = path.match(/^\/plan\/([^/]+)$/)) && (PLAN_TABS as string[]).includes(m[1])) {
    return { view: "plan", tab: m[1] as PlanTab };
  }

  // Legacy redirects
  if (path === "/seasons") return { view: "plan", tab: "when" };
  if (path === "/journal") return { view: "trips", tab: "past" };
  if (path === "/journal/inbox") return { view: "inbox" };
  if ((m = path.match(/^\/journal\/replay(?:\/([^/]+)(?:\/(\d+))?)?$/))) return repeatRoute(m[1], m[2]);
  if ((m = path.match(/^\/journal\/([^/]+)$/))) return { view: "trips", tab: "past", journeyId: seg(m[1]) };

  return { view: "map" };
}

/** Canonical path for a route, without the leading "#" ("/" for the map). */
export function routePath(route: Route): string {
  switch (route.view) {
    case "map":
      return "/";
    case "inbox":
      return "/inbox";
    case "world":
      return "/world";
    case "rotation":
      return "/rotation";
    case "trips":
      if (route.tab === "upcoming") return route.tripId ? `/trips/plan/${enc(route.tripId)}` : "/trips";
      return route.journeyId ? `/trips/past/${enc(route.journeyId)}` : "/trips/past";
    case "plan":
      if (route.tab === "repeat" && route.journeyId) {
        return `/plan/repeat/${enc(route.journeyId)}${route.stopIndex !== undefined ? `/${route.stopIndex}` : ""}`;
      }
      return `/plan/${route.tab}`;
  }
}

/** href for an <a>: "#/trips/past". The map is "#/". */
export function hrefFor(route: Route): string {
  return `#${routePath(route)}`;
}

/** Canonical path of a raw hash, or null when the hash already is canonical. */
export function canonicalRedirect(hash: string): string | null {
  const raw = hash.replace(/^#/, "") || "/";
  const canonical = routePath(parseHash(hash));
  return raw === canonical ? null : canonical;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

function replaceHash(path: string): void {
  const { pathname, search } = window.location;
  const url = path === "/" ? `${pathname}${search}` : `${pathname}${search}#${path}`;
  window.history.replaceState(window.history.state, "", url);
}

/** Current route. Legacy or non-canonical hashes are replaced in place (no history entry). */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  useEffect(() => {
    const target = canonicalRedirect(hash);
    if (target !== null && hash !== "") replaceHash(target);
  }, [hash]);
  return parseHash(hash);
}

/** Navigate to a path ("/trips/past") or a Route. Adds a history entry. */
export function navigate(to: string | Route): void {
  const path = typeof to === "string" ? to : routePath(to);
  window.location.hash = path === "/" ? "" : path;
}
