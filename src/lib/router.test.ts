import { describe, it, expect } from "vitest";
import { parseHash, routePath, hrefFor, canonicalRedirect, type Route } from "./router";

describe("parseHash: v3 routes", () => {
  it("parses the five destinations", () => {
    expect(parseHash("")).toEqual({ view: "map" });
    expect(parseHash("#/")).toEqual({ view: "map" });
    expect(parseHash("#/trips")).toEqual({ view: "trips", tab: "upcoming" });
    expect(parseHash("#/plan")).toEqual({ view: "plan", tab: "when" });
    expect(parseHash("#/inbox")).toEqual({ view: "inbox" });
    expect(parseHash("#/world")).toEqual({ view: "world" });
  });

  it("parses trips tabs and detail routes", () => {
    expect(parseHash("#/trips/upcoming")).toEqual({ view: "trips", tab: "upcoming" });
    expect(parseHash("#/trips/past")).toEqual({ view: "trips", tab: "past" });
    expect(parseHash("#/trips/past/")).toEqual({ view: "trips", tab: "past" });
    expect(parseHash("#/trips/plan/trip-1")).toEqual({ view: "trips", tab: "upcoming", tripId: "trip-1" });
    expect(parseHash("#/trips/past/j%201")).toEqual({ view: "trips", tab: "past", journeyId: "j 1" });
  });

  it("parses plan tabs", () => {
    expect(parseHash("#/plan/when")).toEqual({ view: "plan", tab: "when" });
    expect(parseHash("#/plan/repeat")).toEqual({ view: "plan", tab: "repeat" });
    expect(parseHash("#/plan/watches")).toEqual({ view: "plan", tab: "watches" });
    expect(parseHash("#/plan/flights")).toEqual({ view: "plan", tab: "flights" });
    expect(parseHash("#/plan/days")).toEqual({ view: "plan", tab: "days" });
    expect(parseHash("#/plan/sources")).toEqual({ view: "plan", tab: "sources" });
    expect(parseHash("#/plan/repeat/j1")).toEqual({ view: "plan", tab: "repeat", journeyId: "j1" });
    expect(parseHash("#/plan/repeat/j1/2")).toEqual({ view: "plan", tab: "repeat", journeyId: "j1", stopIndex: 2 });
    expect(parseHash("#/plan/repeat/j1/0")).toMatchObject({ stopIndex: 0 });
  });

  it("falls back to the map for unknown paths", () => {
    expect(parseHash("#/nope")).toEqual({ view: "map" });
    expect(parseHash("#/plan/nope")).toEqual({ view: "map" });
    expect(parseHash("#/journal/a/b/c")).toEqual({ view: "map" });
    expect(parseHash("#/trips/a/b/c")).toEqual({ view: "map" });
  });
});

describe("parseHash: legacy redirects", () => {
  it("maps the old journal routes", () => {
    expect(parseHash("#/journal")).toEqual({ view: "trips", tab: "past" });
    expect(parseHash("#/journal/")).toEqual({ view: "trips", tab: "past" });
    expect(parseHash("#/journal/abc-123")).toEqual({ view: "trips", tab: "past", journeyId: "abc-123" });
    expect(parseHash("#/journal/inbox")).toEqual({ view: "inbox" });
  });

  it("maps old replay routes to Repeat a trip", () => {
    expect(parseHash("#/journal/replay")).toEqual({ view: "plan", tab: "repeat" });
    expect(parseHash("#/journal/replay/j1")).toEqual({ view: "plan", tab: "repeat", journeyId: "j1" });
    expect(parseHash("#/journal/replay/j1/3")).toEqual({ view: "plan", tab: "repeat", journeyId: "j1", stopIndex: 3 });
  });

  it("a journey whose id starts with a keyword is still a journey", () => {
    expect(parseHash("#/journal/inboxes")).toEqual({ view: "trips", tab: "past", journeyId: "inboxes" });
    expect(parseHash("#/journal/replayed")).toEqual({ view: "trips", tab: "past", journeyId: "replayed" });
  });

  it("maps seasons and old trip ids", () => {
    expect(parseHash("#/seasons")).toEqual({ view: "plan", tab: "when" });
    expect(parseHash("#/trips/trip-1")).toEqual({ view: "trips", tab: "upcoming", tripId: "trip-1" });
  });
});

describe("routePath / hrefFor / canonicalRedirect", () => {
  const routes: Route[] = [
    { view: "map" },
    { view: "trips", tab: "upcoming" },
    { view: "trips", tab: "past" },
    { view: "trips", tab: "upcoming", tripId: "t 1" },
    { view: "trips", tab: "past", journeyId: "j/1" },
    { view: "plan", tab: "when" },
    { view: "plan", tab: "repeat" },
    { view: "plan", tab: "repeat", journeyId: "j1" },
    { view: "plan", tab: "repeat", journeyId: "j1", stopIndex: 0 },
    { view: "plan", tab: "watches" },
    { view: "plan", tab: "flights" },
    { view: "inbox" },
    { view: "world" },
  ];

  it("round-trips every route", () => {
    for (const r of routes) expect(parseHash(hrefFor(r))).toEqual(r);
  });

  it("builds canonical paths", () => {
    expect(routePath({ view: "map" })).toBe("/");
    expect(hrefFor({ view: "trips", tab: "upcoming", tripId: "trip-1" })).toBe("#/trips/plan/trip-1");
    expect(hrefFor({ view: "plan", tab: "repeat", journeyId: "j1", stopIndex: 2 })).toBe("#/plan/repeat/j1/2");
  });

  it("reports the redirect target for legacy hashes only", () => {
    expect(canonicalRedirect("#/journal")).toBe("/trips/past");
    expect(canonicalRedirect("#/journal/j1")).toBe("/trips/past/j1");
    expect(canonicalRedirect("#/journal/inbox")).toBe("/inbox");
    expect(canonicalRedirect("#/journal/replay/j1/2")).toBe("/plan/repeat/j1/2");
    expect(canonicalRedirect("#/seasons")).toBe("/plan/when");
    expect(canonicalRedirect("#/trips/trip-1")).toBe("/trips/plan/trip-1");
    expect(canonicalRedirect("#/plan")).toBe("/plan/when");
    expect(canonicalRedirect("#/trips/past")).toBeNull();
    expect(canonicalRedirect("")).toBeNull();
    expect(canonicalRedirect("#/")).toBeNull();
  });
});
