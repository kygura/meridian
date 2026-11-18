// Test helpers for the live events store: seed events-live.json in the current DATA_DIR,
// and answer the sources' requests (Wikidata, iNaturalist, NOAA SWPC) from recorded
// responses. No network.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Fetch } from "../liveEvents.js";
import { resetLiveEventsForTests } from "../liveEvents.js";
import type { MeridianEvent } from "../../../src/types.js";

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8"));
}

/** Writes a fresh events-live.json into DATA_DIR (which the caller has set) and drops the in-memory copy. */
export function seedLiveEvents(events: MeridianEvent[], opts: { fetchedAt?: string; attemptedAt?: string } = {}): void {
  const dir = process.env.DATA_DIR;
  if (!dir) throw new Error("set DATA_DIR before seeding events");
  const fetchedAt = opts.fetchedAt ?? new Date().toISOString();
  const file = { version: 1, fetchedAt, attemptedAt: opts.attemptedAt ?? fetchedAt, sources: [], events: events.map((e) => ({ ...e, feed: "festivities" })) };
  writeFileSync(join(dir, "events-live.json"), JSON.stringify(file));
  resetLiveEventsForTests();
}

export const ev = (id: string, over: Partial<MeridianEvent> = {}): MeridianEvent => ({
  id,
  title: id,
  kind: "festival",
  cityIds: ["porto-portugal"],
  month: 6,
  recurring: true,
  tags: ["festival"],
  ...over,
});

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body. */
  body?: unknown;
  /** Text body (HTML), used instead of `body` when set. */
  text?: string;
}

export interface FakeRequest {
  url: string;
  host: string;
  /** The SPARQL query, for Wikidata requests. */
  query: string;
  headers: Record<string, string>;
}

/** A fetch that records its calls and answers with `answer(request, n)`; n counts calls so far. */
export function fakeNetwork(answer: (req: FakeRequest, n: number) => FakeResponse | Promise<FakeResponse>) {
  const calls: FakeRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const req: FakeRequest = { url, host: u.host, query: u.searchParams.get("query") ?? "", headers: init?.headers ?? {} };
    calls.push(req);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const r = await answer(req, calls.length);
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
        json: async () => r.body ?? {},
        text: async () => r.text ?? JSON.stringify(r.body ?? {}),
      };
    } finally {
      active--;
    }
  };
  return { fetch, calls, maxActive: () => maxActive };
}

/** A fetch for Wikidata only: `answer(query, n)`. Any other host is a test error. */
export function fakeWikidata(answer: (query: string, n: number) => FakeResponse | Promise<FakeResponse>) {
  return fakeNetwork((req, n) => {
    if (req.host !== "query.wikidata.org") throw new Error(`unexpected request to ${req.host}`);
    return answer(req.query, n);
  });
}

export type WikidataSource = "festivities" | "festivity-exclusions" | "national-festivities" | "eclipses" | "lunar-eclipses";

/** Which Wikidata query a request carries. */
export function sourceOfQuery(q: string): WikidataSource {
  if (q.includes("wd:Q19693318")) return "lunar-eclipses";
  if (q.includes("wd:Q3887")) return "eclipses";
  if (q.includes("wdt:P837")) return "national-festivities";
  if (q.includes("VALUES ?e {")) return "festivity-exclusions";
  return "festivities";
}

/** The source a request belongs to, by host. */
export function sourceOfRequest(req: FakeRequest): "wikidata" | "inaturalist" | "swpc" | "other" {
  if (req.host === "query.wikidata.org") return "wikidata";
  if (req.host === "api.inaturalist.org") return "inaturalist";
  if (req.host === "services.swpc.noaa.gov") return "swpc";
  return "other";
}

const WIKIDATA_FILES: Record<WikidataSource, string> = {
  festivities: "events/wikidata-festivities.json",
  "festivity-exclusions": "events/wikidata-festivity-exclusions.json",
  "national-festivities": "events/wikidata-national.json",
  eclipses: "events/wikidata-eclipses.json",
  "lunar-eclipses": "events/wikidata-lunar-eclipses.json",
};

/** Where the recorded iNaturalist species_counts answers were taken: one file per city, pages keyed "plant-3" or "animal-11" (kind and month). */
export const INAT_FIXTURE_CITIES: Record<string, { file: string; lat: number; lng: number }> = {
  "kyoto-japan": { file: "events/inat-species-counts-kyoto.json", lat: 35.0116, lng: 135.7681 },
  "sydney-australia": { file: "events/inat-species-counts-sydney.json", lat: -33.8688, lng: 151.2093 },
  "honolulu-united-states": { file: "events/inat-species-counts-honolulu.json", lat: 21.3069, lng: -157.8583 },
};

const EMPTY_PAGE = { total_results: 0, page: 1, per_page: 100, results: [] };

/** The recorded species_counts answer for a request; a place or month with no recording has no observations. */
export function recordedInat(url: string): FakeResponse {
  const u = new URL(url);
  const lat = Number(u.searchParams.get("lat"));
  const lng = Number(u.searchParams.get("lng"));
  const hit = Object.values(INAT_FIXTURE_CITIES).find((c) => Math.abs(c.lat - lat) < 0.5 && Math.abs(c.lng - lng) < 0.5);
  if (!u.pathname.endsWith("/observations/species_counts")) throw new Error(`unexpected iNaturalist request ${u.pathname}`);
  if (!hit) return { body: EMPTY_PAGE };
  const kind = u.searchParams.get("iconic_taxa") === "Plantae" ? "plant" : "animal";
  const pages = fixtureJson(hit.file) as Record<string, unknown>;
  return { body: pages[`${kind}-${u.searchParams.get("month")}`] ?? EMPTY_PAGE };
}

/** Answers every source's requests with its recorded fixture. */
export const recordedRequest = (req: FakeRequest): FakeResponse => {
  switch (sourceOfRequest(req)) {
    case "wikidata":
      return { body: fixtureJson(WIKIDATA_FILES[sourceOfQuery(req.query)]) };
    case "inaturalist":
      return recordedInat(req.url);
    case "swpc":
      return { body: fixtureJson("events/swpc-kp-forecast.json") };
    default:
      throw new Error(`unexpected request to ${req.host}`);
  }
};
