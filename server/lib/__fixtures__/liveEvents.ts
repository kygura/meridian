// Test helpers for the live events store: seed events-live.json in the current DATA_DIR,
// and load the recorded Wikidata responses. No network.

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
  const file = { version: 1, fetchedAt, attemptedAt: opts.attemptedAt ?? fetchedAt, sources: [], events: events.map((e) => ({ ...e, feed: "test" })) };
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
  body?: unknown;
}

/** A fetch that records its calls and answers with `answer(url, n)`; n counts calls so far. */
export function fakeWikidata(answer: (query: string, n: number) => FakeResponse | Promise<FakeResponse>) {
  const calls: { url: string; query: string; headers: Record<string, string> }[] = [];
  let active = 0;
  let maxActive = 0;
  const fetch: Fetch = async (url, init) => {
    const query = new URL(url).searchParams.get("query") ?? "";
    calls.push({ url, query, headers: init?.headers ?? {} });
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      const r = await answer(query, calls.length);
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
        json: async () => r.body ?? {},
      };
    } finally {
      active--;
    }
  };
  return { fetch, calls, maxActive: () => maxActive };
}

/** Which source a refresh query belongs to. */
export function sourceOfQuery(q: string): "eclipses" | "dated-sports" | "dated-festivals" | "festivals" | "sports" {
  if (q.includes("wd:Q3887")) return "eclipses";
  if (q.includes("wdt:P580")) return q.includes("wd:Q16510064") ? "dated-sports" : "dated-festivals";
  return q.includes("VALUES ?class") ? "sports" : "festivals";
}

const empty = { head: { vars: [] }, results: { bindings: [] } };
const FILES = {
  eclipses: "wikidata-eclipses.json",
  "dated-sports": "wikidata-dated-sports.json",
  festivals: "wikidata-festivals.json",
  sports: "wikidata-sports.json",
} as const;

/** Answers each source's query with its recorded fixture (dated festivals: no rows). */
export const recorded = (query: string): FakeResponse => {
  const src = sourceOfQuery(query);
  return { body: src === "dated-festivals" ? empty : fixtureJson(FILES[src]) };
};
