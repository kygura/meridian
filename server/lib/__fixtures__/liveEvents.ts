// Test helpers for the live events store: seed events-live.json in the current DATA_DIR,
// and answer the sources' requests (Wikidata, Wikipedia and Wikivoyage, NOAA SWPC) from recorded
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
export function sourceOfRequest(req: FakeRequest): "wikidata" | "mediawiki" | "swpc" | "other" {
  if (req.host === "query.wikidata.org") return "wikidata";
  if (["en.wikipedia.org", "en.wikivoyage.org", "www.wikidata.org"].includes(req.host)) return "mediawiki";
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

/** Recorded MediaWiki answers (Wikipedia, Wikivoyage, Wikidata) by request URL, one file per city, trimmed to the sections Claude reads. */
const PLACE_FILES: Record<string, string> = {
  "kyoto-japan": "events/mediawiki-kyoto.json",
  "avignon-france": "events/mediawiki-avignon.json",
};
let placeAnswers: Record<string, unknown> | undefined;
function recordedPlaceAnswer(url: string): unknown {
  const all = (placeAnswers ??= Object.assign({}, ...Object.values(PLACE_FILES).map((f) => fixtureJson(f) as Record<string, unknown>)) as Record<string, unknown>);
  return all[url];
}

/** The recorded answer for a Wikipedia, Wikivoyage or Wikidata request; an unrecorded one finds nothing. */
export function recordedMediaWiki(url: string): FakeResponse {
  const hit = recordedPlaceAnswer(url);
  if (hit !== undefined) return { body: hit };
  return { body: new URL(url).host === "www.wikidata.org" ? { entities: {}, claims: {} } : { query: { pages: [] } } };
}

/** Answers every source's requests with its recorded fixture. */
export const recordedRequest = (req: FakeRequest): FakeResponse => {
  switch (sourceOfRequest(req)) {
    case "wikidata":
      return { body: fixtureJson(WIKIDATA_FILES[sourceOfQuery(req.query)]) };
    case "mediawiki":
      return recordedMediaWiki(req.url);
    case "swpc":
      return { body: fixtureJson("events/swpc-kp-forecast.json") };
    default:
      throw new Error(`unexpected request to ${req.host}`);
  }
};

/** The parts of a Messages request the highlights source sends, as the fake client sees them. */
export interface FakeClaudeRequest {
  model: string;
  system: string;
  max_tokens: number;
  tool_choice: { type: string; name: string };
  tools: { name: string; input_schema: unknown }[];
  messages: { role: string; content: string }[];
}

/**
 * A stand-in for the Anthropic client: answers every call with the one tool and the highlights
 * `answer` returns for the request (the text is in the user message), and counts the calls.
 */
export function fakeClaude(answer: (req: FakeClaudeRequest, n: number) => unknown[] | { stop_reason: string } | Error, usage = { input_tokens: 5000, output_tokens: 400 }) {
  const calls: FakeClaudeRequest[] = [];
  const client = {
    messages: {
      create: async (req: FakeClaudeRequest) => {
        calls.push(req);
        const out = answer(req, calls.length);
        if (out instanceof Error) throw out;
        if (!Array.isArray(out)) return { stop_reason: out.stop_reason, content: [], usage };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${calls.length}`, name: "record_highlights", input: { highlights: out } }], usage };
      },
    },
  };
  return { client: client as unknown as import("@anthropic-ai/sdk").default, calls };
}
