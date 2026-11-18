// Test helpers for the live events store: seed events-live.json in the current DATA_DIR,
// and answer the sources' requests (Wikidata, JMA, iNaturalist, NOAA SWPC) from recorded
// responses. No network.

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Fetch } from "../liveEvents.js";
import { resetLiveEventsForTests } from "../liveEvents.js";
import type { MeridianEvent } from "../../../src/types.js";

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf-8"));
}

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf-8");
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
export function sourceOfRequest(req: FakeRequest): "wikidata" | "jma" | "inaturalist" | "swpc" | "other" {
  if (req.host === "query.wikidata.org") return "wikidata";
  if (req.host === "www.data.jma.go.jp") return "jma";
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

const JMA_FILES: Record<string, string> = {
  "index.html": "events/jma-index.html",
  "sakura003_07.html": "events/jma-sakura-flowering.html",
  "sakura004_07.html": "events/jma-sakura-fullbloom.html",
  "phn_014.html": "events/jma-maple.html",
};

/** Taxon ids the recorded iNaturalist answers use. */
export const TAXON = { prunus: 125742, jacaranda: 77541, humpback: 41566, chelonia: 39659, caretta: 39665 } as const;

const TAXA_FILES: Record<string, string> = {
  "prunus serrulata": "events/inat-taxa-prunus-serrulata.json",
  "jacaranda mimosifolia": "events/inat-taxa-jacaranda.json",
  "megaptera novaeangliae": "events/inat-taxa-humpback.json",
  "caretta caretta": "events/inat-taxa-caretta.json",
};

const EMPTY_HISTOGRAM = { total_results: 12, page: 1, per_page: 12, results: { month_of_year: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), 0])) } };

/** The recorded iNaturalist answer for a taxa or histogram request; places with no recording have no observations. */
export function recordedInat(url: string): FakeResponse {
  const u = new URL(url);
  if (u.pathname.endsWith("/taxa")) {
    const file = TAXA_FILES[(u.searchParams.get("q") ?? "").toLowerCase()];
    return file ? { body: fixtureJson(file) } : { body: { total_results: 0, results: [] } };
  }
  const taxon = u.searchParams.get("taxon_id");
  const lat = Number(u.searchParams.get("lat"));
  const lng = Number(u.searchParams.get("lng"));
  const near = (a: number, b: number) => Math.abs(lat - a) < 0.2 && Math.abs(lng - b) < 0.2;
  if (taxon === String(TAXON.prunus) && near(35.68, 139.69)) return { body: fixtureJson("events/inat-histogram-prunus-tokyo.json") };
  if (taxon === String(TAXON.prunus) && near(38.9, -77.04)) return { body: fixtureJson("events/inat-histogram-prunus-washington.json") };
  if (taxon === String(TAXON.jacaranda) && near(-25.75, 28.23)) return { body: fixtureJson("events/inat-histogram-jacaranda-pretoria.json") };
  if (taxon === String(TAXON.jacaranda) && near(48.86, 2.35)) return { body: fixtureJson("events/inat-histogram-jacaranda-paris.json") };
  if (taxon === String(TAXON.humpback) && near(-33.87, 151.21)) return { body: fixtureJson("events/inat-histogram-humpback-sydney.json") };
  return { body: EMPTY_HISTOGRAM };
}

/** Answers every source's requests with its recorded fixture. */
export const recordedRequest = (req: FakeRequest): FakeResponse => {
  switch (sourceOfRequest(req)) {
    case "wikidata":
      return { body: fixtureJson(WIKIDATA_FILES[sourceOfQuery(req.query)]) };
    case "jma": {
      const file = JMA_FILES[new URL(req.url).pathname.split("/").pop() ?? ""];
      return file ? { text: fixtureText(file) } : { status: 404 };
    }
    case "inaturalist":
      return recordedInat(req.url);
    case "swpc":
      return { body: fixtureJson("events/swpc-kp-forecast.json") };
    default:
      throw new Error(`unexpected request to ${req.host}`);
  }
};
