import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { City, Journey, MeridianEvent } from "../../src/types";
import { getCities, loadCities } from "./cities";
import {
  applySource,
  bindingsOf,
  buildCityIndex,
  cityIndexFor,
  countryKey,
  dedupeAndSort,
  hasPendingWork,
  getLiveEvents,
  isStale,
  liveEventsStatus,
  monthOf,
  parsePoint,
  refreshLiveEvents,
  resetLiveEventsForTests,
  runSparql,
  SOURCES,
  USER_AGENT,
  type LiveEventsFile,
  type StoredEvent,
} from "./liveEvents";
import type { ComputedSource } from "./events/computed";
import { eventPointsFor, eventsForCities, eventTagCounts } from "./phenomena";
import { loadEvents } from "./replayService";
import { runReplay } from "./replay";
import { fixtureFingerprintDeps, lisbonJourney, getCity, SEASONALITY, NOW } from "./__fixtures__/journal";
import { computeFingerprint } from "./fingerprint";
import { setAnthropicClient } from "./agent/claude";
import { ev, fakeClaude, fakeNetwork, fakeWikidata, fixtureJson, recordedRequest, seedLiveEvents, sourceOfRequest } from "./__fixtures__/liveEvents";

const noSleep = async () => undefined;
const NOW_FETCH = new Date("2026-11-18T12:00:00Z");
/** The owner's places for the highlights check: four, with recorded answers for three of them. A check of one city is 24 requests. */
const PLACES = {
  ownerCityIds: async () => ["kyoto-japan", "avignon-france", "lisbon-portugal"],
  attentionCityIds: () => [] as string[],
};
/** Events one full refresh of the recorded answers gives: 16 festivities, 14 national, 5 eclipses, 1 aurora and 2 highlights. */
const FULL = 38;
const run = (fetch: ReturnType<typeof fakeNetwork>["fetch"], over: Parameters<typeof refreshLiveEvents>[0] = {}) =>
  refreshLiveEvents({ fetch, now: NOW_FETCH, sleep: noSleep, pauseMs: 0, hostPauseMs: 0, places: PLACES, maxChecks: 9, ...over });

/** A model that quotes the first 14 words of the first Understand section it is sent and calls it a spring highlight. */
function springClaude() {
  return fakeClaude((req) => {
    const m = /\[wikivoyage[^\]]*\/ Understand\]\n([^\n]+)/.exec(req.messages[0]!.content);
    if (!m) return [];
    return [{ title: "Spring highlight", kind: "season", months: [3, 4], quote: m[1]!.split(" ").slice(0, 14).join(" "), source: "wikivoyage", why: "x" }];
  });
}

let TMP: string;
beforeAll(() => loadCities());
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-live-events-"));
  process.env.DATA_DIR = TMP;
  resetLiveEventsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env.ANTHROPIC_API_KEY = "test-key";
  setAnthropicClient(springClaude().client);
});
afterEach(() => {
  setAnthropicClient(null);
  delete process.env.ANTHROPIC_API_KEY;
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  resetLiveEventsForTests();
  vi.restoreAllMocks();
});

const nowOpts2 = { sleep: noSleep, pauseMs: 0, hostPauseMs: 0, places: PLACES, maxChecks: 9 };
describe("month mapping", () => {
  it("maps the twelve Wikidata month items to 1-12", () => {
    const qids = ["Q108", "Q109", "Q110", "Q118", "Q119", "Q120", "Q121", "Q122", "Q123", "Q124", "Q125", "Q126"];
    expect(qids.map((q) => monthOf(`http://www.wikidata.org/entity/${q}`))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it("accepts an English month name and ignores anything else", () => {
    expect(monthOf("September")).toBe(9);
    expect(monthOf("http://www.wikidata.org/entity/Q1998")).toBeUndefined();
    expect(monthOf("http://www.wikidata.org/entity/Q111")).toBeUndefined();
    expect(monthOf(undefined)).toBeUndefined();
  });
});


describe("parsePoint", () => {
  it("reads WKT as lat and lng, longitude first in the text", () => {
    expect(parsePoint("Point(7.018055555 43.550833333)")).toEqual({ lat: 43.550833333, lng: 7.018055555 });
    expect(parsePoint("Point(-48.5 -31.3)")).toEqual({ lat: -31.3, lng: -48.5 });
  });
  it("rejects malformed or out-of-range points", () => {
    expect(parsePoint("POLYGON(1 2)")).toBeUndefined();
    expect(parsePoint("Point(200 10)")).toBeUndefined();
    expect(parsePoint(undefined)).toBeUndefined();
  });
});


describe("city matching", () => {
  const city = (id: string, lat: number, lng: number, population: number, extra: Partial<City> = {}): City => ({ id, name: id, country: "Testland", lat, lng, population, ...extra });

  it("finds the nearest city within the radius and nothing beyond it", () => {
    const idx = buildCityIndex([city("a", 10, 10, 1000), city("b", 11, 10, 1000)]);
    expect(idx.nearest({ lat: 10.01, lng: 10 }, 40)?.id).toBe("a");
    expect(idx.nearest({ lat: 10.5, lng: 10 }, 40)).toBeUndefined(); // 55 km from both
    expect(idx.nearest({ lat: 10.5, lng: 10 }, 60)).toBeDefined();
  });
  it("prefers the bigger of two cities within 5 km of each other", () => {
    const idx = buildCityIndex([city("village", 10, 10, 2000), city("town", 10.03, 10, 90000), city("far", 10.2, 10, 5_000_000)]);
    expect(idx.nearest({ lat: 10.001, lng: 10 }, 40)?.id).toBe("town");
  });
  it("matches across the antimeridian and near the poles", () => {
    const idx = buildCityIndex([city("east", 0, 179.9, 100), city("pole", 78.2, 15.6, 100)]);
    expect(idx.nearest({ lat: 0, lng: -179.9 }, 40)?.id).toBe("east");
    expect(idx.nearest({ lat: 78.2, lng: 16.4 }, 40)?.id).toBe("pole");
  });
  it("can be limited to cities with an airport", () => {
    const idx = buildCityIndex([city("near", 10, 10, 1000), city("airport", 10.5, 10, 1000, { iata: "XXX" })]);
    expect(idx.nearest({ lat: 10, lng: 10 }, 100, true)?.id).toBe("airport");
  });
  it("picks a country's hub: the capital with an airport, else the biggest airport city", () => {
    const idx = buildCityIndex([
      city("cap", 1, 1, 10, { capital: true, iata: "CAP" }),
      city("big", 2, 2, 1000, { iata: "BIG" }),
      { ...city("c2cap", 5, 5, 10, { capital: true }), country: "Two" },
      { ...city("c2big", 6, 6, 500, { iata: "TWO" }), country: "Two" },
    ]);
    expect(idx.hubOfCountry("Testland")?.id).toBe("cap");
    expect(idx.hubOfCountry("Two")?.id).toBe("c2big");
    expect(idx.hubOfCountry("Nowhere")).toBeUndefined();
  });
  it("reads Wikidata country names as the dataset spells them", () => {
    const idx = cityIndexFor(getCities());
    expect(countryKey("United States of America")).toBe(countryKey("United States"));
    expect(idx.hubOfCountry("United States of America")?.country).toBe("United States");
    expect(idx.hubOfCountry("Ivory Coast")?.country).toBe("Côte D’Ivoire");
    expect(idx.hubOfCountry("Czech Republic")?.country).toBe("Czechia");
    expect(idx.hubOfCountry("The Bahamas")?.country).toBe("Bahamas, The");
  });
  it("answers 600 lookups against the full city set quickly", () => {
    const idx = cityIndexFor(getCities());
    const t = Date.now();
    for (let i = 0; i < 600; i++) idx.nearest({ lat: (i % 140) - 70, lng: ((i * 7) % 360) - 180 }, 40);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});


describe("dedupe", () => {
  it("keeps the first of equal ids and sorts by month, then title", () => {
    const e = (id: string, title: string, month: number, feed: string): StoredEvent => ({ ...ev(id, { title, month }), feed });
    const out = dedupeAndSort([e("wd-Q2", "B", 3, "festivities"), e("wd-Q1", "A", 3, "eclipses"), e("wd-Q2", "B again", 3, "highlights"), e("wd-Q3", "C", 1, "highlights")]);
    expect(out.map((x) => `${x.id}/${x.feed}`)).toEqual(["wd-Q3/highlights", "wd-Q1/eclipses", "wd-Q2/festivities"]);
  });
});


describe("runSparql", () => {
  const ok = { body: fixtureJson("events/wikidata-festivities.json") };

  it("sends the Wikidata etiquette headers and returns the bindings", async () => {
    const w = fakeWikidata(() => ok);
    const rows = await runSparql("SELECT 1", { fetch: w.fetch, sleep: noSleep });
    expect(rows).toHaveLength(30);
    expect(w.calls[0]!.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" });
    expect(USER_AGENT).toBe("Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)");
    expect(w.calls[0]!.url.startsWith("https://query.wikidata.org/sparql?")).toBe(true);
  });

  it("waits Retry-After on 429 and retries", async () => {
    const sleeps: number[] = [];
    const w = fakeWikidata((_q, n) => (n === 1 ? { status: 429, headers: { "retry-after": "7" } } : ok));
    const rows = await runSparql("q", { fetch: w.fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(rows).toHaveLength(30);
    expect(w.calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
  });

  it("caps Retry-After at 60 s, retries a 503 too, and gives up after two retries", async () => {
    const sleeps: number[] = [];
    const w = fakeWikidata(() => ({ status: 503, headers: { "retry-after": "600" } }));
    await expect(runSparql("q", { fetch: w.fetch, sleep: async (ms) => void sleeps.push(ms) })).rejects.toThrow(/503 after 2 retries/);
    expect(w.calls).toHaveLength(3);
    expect(sleeps).toEqual([60000, 60000]);
  });

  it("uses a short default wait when Retry-After is missing, and does not retry other errors", async () => {
    const sleeps: number[] = [];
    const w = fakeWikidata((_q, n) => (n === 1 ? { status: 429 } : { status: 500 }));
    await expect(runSparql("q", { fetch: w.fetch, sleep: async (ms) => void sleeps.push(ms) })).rejects.toThrow(/500/);
    expect(w.calls).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it("rejects a body that is not a SPARQL result", async () => {
    const w = fakeWikidata(() => ({ body: { nope: true } }));
    await expect(runSparql("q", { fetch: w.fetch, sleep: noSleep })).rejects.toThrow(/unexpected SPARQL response/);
  });
});


describe("consumers read the live store", () => {
  const list: MeridianEvent[] = [
    ev("rec", { cityIds: ["lisbon-portugal"], month: 6, tags: ["festival", "carnival"] }),
    ev("past", { cityIds: ["lisbon-portugal"], month: 3, recurring: false, date: "2020-03-01", tags: ["sport"] }),
    ev("next", { cityIds: ["lisbon-portugal", "porto-portugal"], month: 6, recurring: false, date: "2027-06-10", tags: ["sport", "marathon"] }),
    ev("later", { cityIds: ["porto-portugal"], month: 6, recurring: false, date: "2028-06-10", tags: ["sport"] }),
  ];
  beforeEach(() => seedLiveEvents(list));

  it("loadEvents keeps recurring events and a dated one only in its month's next occurrence", async () => {
    expect((await loadEvents(new Date("2026-11-18T00:00:00Z"))).map((e) => e.id)).toEqual(["rec", "next"]);
    expect((await loadEvents(new Date("2028-01-01T00:00:00Z"))).map((e) => e.id)).toEqual(["rec", "later"]);
  });

  it("eventsForCities hides past dated events and narrows cityIds", async () => {
    const out = await eventsForCities(["porto-portugal"], new Date("2026-11-18T00:00:00Z"));
    expect(out.map((e) => [e.id, e.cityIds])).toEqual([["next", ["porto-portugal"]], ["later", ["porto-portugal"]]]);
  });

  it("eventPointsFor places a month's events on their cities", async () => {
    const pts = await eventPointsFor(6, new Date("2026-11-18T00:00:00Z"));
    expect(pts.map((p) => `${p.eventId}@${p.cityId}`).sort()).toEqual(["next@lisbon-portugal", "next@porto-portugal", "rec@lisbon-portugal"].sort());
  });

  it("eventTagCounts counts upcoming events per tag, most common first", async () => {
    expect(await eventTagCounts(new Date("2026-11-18T00:00:00Z"))).toEqual([
      { tag: "sport", count: 2 },
      { tag: "carnival", count: 1 },
      { tag: "festival", count: 1 },
      { tag: "marathon", count: 1 },
    ]);
  });
});

describe("eclipse tag constraint in replay", () => {
  async function eclipseCells(today: string): Promise<string[]> {
    seedLiveEvents([
      ev("wd-eclipse-2027", { kind: "eclipse", month: 8, date: "2027-08-02", recurring: false, tags: ["eclipse"], cityIds: ["athens-greece"] }),
      ev("wd-eclipse-2028", { kind: "eclipse", month: 1, date: "2028-01-26", recurring: false, tags: ["eclipse"], cityIds: ["seville-spain"] }),
      ev("wd-eclipse-2030", { kind: "eclipse", month: 6, date: "2030-06-01", recurring: false, tags: ["eclipse"], cityIds: ["oslo-norway"] }),
    ]);
    let lisbon: Journey = lisbonJourney();
    lisbon = (await computeFingerprint(lisbon, fixtureFingerprintDeps().deps)).journey;
    const r = await runReplay(
      { template: { journeyId: lisbon.id }, bend: { monthShift: null }, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 }, constraints: { tags: ["eclipse"] }, limit: 50 },
      {
        journeys: [lisbon],
        settings: { homeCityId: "berlin-germany" },
        seasonality: SEASONALITY,
        getCity,
        flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }),
        eurOf: (a) => a,
        now: () => NOW,
        events: await loadEvents(new Date(`${today}T00:00:00Z`)),
      }
    );
    for (const x of r.results) expect(x.events!.some((e) => e.tags.includes("eclipse"))).toBe(true);
    return r.results.map((x) => `${x.cityId}/${x.month}`).sort();
  }

  it("tags a month only with the eclipse in its next occurrence, never one years away", async () => {
    // 2027-10-01: the 2028-01 eclipse is January's next occurrence (Seville); the 2030-06 one is not June's.
    expect(await eclipseCells("2027-10-01")).toEqual(["seville-spain/1"]);
    // 2026-10-30: only the 2027-08 eclipse (Athens) is ahead for August; the 2028 and 2030 ones tag no 2027 month.
    expect(await eclipseCells("2026-10-30")).toEqual(["athens-greece/8"]);
  });
});


const IDS = ["festivities", "national-festivities", "eclipses", "highlights", "aurora"];

describe("the source list", () => {
  it("lists the sources the owner asked for, with their own due intervals", () => {
    expect(SOURCES.map((s) => s.id)).toEqual(IDS);
    const hours = Object.fromEntries(SOURCES.map((s) => [s.id, s.intervalMs / 3_600_000]));
    expect(hours).toEqual({ festivities: 168, "national-festivities": 168, eclipses: 168, highlights: 1, aurora: 3 });
  });
});

describe("refreshLiveEvents", () => {
  it("runs two sources at a time by default and asks each host for what it needs", async () => {
    const w = fakeNetwork(async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      return recordedRequest(req);
    });
    await run(w.fetch);
    expect(w.maxActive()).toBe(2);
    const hosts = new Set(w.calls.map((c) => c.host));
    expect(hosts).toEqual(new Set(["query.wikidata.org", "en.wikipedia.org", "en.wikivoyage.org", "www.wikidata.org", "services.swpc.noaa.gov"]));
  });

  it("runs every source one at a time when asked, merges them and writes the store", async () => {
    const w = fakeNetwork(recordedRequest);
    const sleeps: number[] = [];
    const file = await run(w.fetch, { concurrency: 1, pauseMs: 1000, sleep: async (ms) => void sleeps.push(ms) });
    // One source at a time; the highlights source alone keeps two requests in flight.
    expect(w.maxActive()).toBeLessThanOrEqual(2);
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(4);
    expect(file.fetchedAt).toBe("2026-11-18T12:00:00.000Z");
    expect(file.sources.map((s) => [s.id, s.ok])).toEqual(IDS.map((id) => [id, true]));
    const count = (id: string) => file.sources.find((s) => s.id === id)!;
    expect(count("festivities")).toMatchObject({ count: 16, unmatched: 2 });
    expect(count("national-festivities")).toMatchObject({ count: 14, unmatched: 1 });
    expect(count("eclipses")).toMatchObject({ count: 5, unplaced: 3 });
    expect(count("highlights")).toMatchObject({ detail: { model: "claude-haiku-5-5" } });
    expect(Number(count("highlights").detail!.ranThisRun)).toBeGreaterThanOrEqual(3);
    expect(Number(count("highlights").detail!.inputTokens)).toBeGreaterThan(0);
    expect(count("highlights").count).toBeGreaterThan(0);
    expect(count("aurora").count).toBe(1);
    const total = 16 + 14 + 5 + count("highlights").count + 1;
    expect(file.events).toHaveLength(total);
    expect(new Set(file.events.map((e) => e.id)).size).toBe(total);
    expect(file.events.map((e) => e.month)).toEqual([...file.events.map((e) => e.month)].sort((a, b) => a - b));
    const onDisk = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    expect(onDisk.events).toHaveLength(total);
    expect(onDisk.sources).toHaveLength(5);
    expect(Object.keys(onDisk.state)).toEqual(["highlights"]);
    expect(JSON.stringify(onDisk.state)).not.toMatch(/inaturalist/);
  });

  it("never fetches film festivals, music festivals, sports or dated festivals any more", async () => {
    const w = fakeNetwork(recordedRequest);
    await run(w.fetch);
    const queries = w.calls.filter((c) => c.host === "query.wikidata.org").map((c) => c.query);
    expect(queries).toHaveLength(5);
    expect(queries.some((q) => q.includes("wd:Q16510064 ;") || q.includes("VALUES ?class") || q.includes("wdt:P580"))).toBe(false);
  });

  it("saves each source as it finishes and stops starting sources when the budget runs out", async () => {
    let calls = 0;
    const w = fakeNetwork((req) => {
      calls += 1;
      if (calls > 2) throw new Error("should not start after the budget");
      return recordedRequest(req);
    });
    // The clock moves 400 ms per read, so a 1 s budget is spent once the first source has run.
    const realNow = Date.now;
    let t = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 400));
    try {
      await run(w.fetch, { budgetMs: 1000, concurrency: 1 });
    } finally {
      spy.mockRestore();
    }
    const status = await liveEventsStatus();
    expect(status.sources.map((x) => x.id)).toEqual(["festivities"]);
    expect(status.total).toBe(16);
    expect(status.attemptedAt).not.toBeNull();
  });

  const readStoredFile = async () => JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8")) as LiveEventsFile;

  it("keeps a failed source's previous events and fetchedAt, and records the error", async () => {
    await run(fakeNetwork(recordedRequest).fetch, { now: new Date("2026-11-18T12:00:00Z") });
    const first = (await readStoredFile()).sources.find((x) => x.id === "highlights")!;
    setAnthropicClient(fakeClaude(() => new Error("overloaded")).client);
    const w = fakeNetwork(recordedRequest);
    // 200 days later every city is due again.
    const file = await run(w.fetch, { now: new Date("2027-06-06T12:00:00Z"), cities: getCities().filter((c) => ["kyoto-japan", "avignon-france"].includes(c.id)) });
    const inat = file.sources.find((s) => s.id === "highlights")!;
    expect(inat).toMatchObject({ ok: false, count: first.count, fetchedAt: "2026-11-18T12:00:00.000Z" });
    expect(inat.error).toMatch(/highlights stopped after 0 cities: overloaded/);
    expect(file.events.filter((e) => e.feed === "highlights")).toHaveLength(first.count);
    expect(file.sources.find((s) => s.id === "festivities")).toMatchObject({ ok: true, fetchedAt: "2027-06-06T12:00:00.000Z" });
    expect(file.fetchedAt).toBe("2027-06-06T12:00:00.000Z");
  });

  it("treats an empty answer from a source that had events as a failure and keeps them", async () => {
    await run(fakeNetwork(recordedRequest).fetch);
    const w = fakeNetwork((req) => (sourceOfRequest(req) === "wikidata" && req.query.includes("Q132241") && !req.query.includes("VALUES ?e") && !req.query.includes("P837") ? { body: { results: { bindings: [] } } } : recordedRequest(req)));
    const file = await run(w.fetch);
    expect(file.sources.find((s) => s.id === "festivities")).toMatchObject({ ok: false, count: 16 });
    expect(file.events.filter((e) => e.feed === "festivities")).toHaveLength(16);
  });

  it("reports 'no Anthropic key' for the highlights source and emits nothing from it, while the other sources land", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const file = await run(fakeNetwork(recordedRequest).fetch);
    expect(file.sources.find((s) => s.id === "highlights")).toMatchObject({ ok: false, count: 0, error: "no Anthropic key" });
    expect(file.events.filter((e) => e.feed === "highlights")).toEqual([]);
    expect(file.sources.filter((s) => s.id !== "highlights").every((s) => s.ok)).toBe(true);
    expect(file.events).toHaveLength(36);
  });

  it("lets a source that may be empty (highlights, aurora) be empty without an error", async () => {
    const w = fakeNetwork(recordedRequest);
    const file = await run(w.fetch, { places: { ownerCityIds: async () => ["lisbon-portugal"], attentionCityIds: () => [] }, maxChecks: 9 });
    expect(file.sources.find((s) => s.id === "highlights")).toMatchObject({ ok: true, count: 0 });
  });

  it("does not wipe the store or advance fetchedAt when every source fails", async () => {
    await run(fakeNetwork(recordedRequest).fetch, { now: new Date("2026-11-18T12:00:00Z") });
    const down = fakeNetwork(() => ({ status: 500 }));
    const file = await run(down.fetch, { now: new Date("2026-11-20T12:00:00Z") });
    expect(file.events.length).toBeGreaterThan(30);
    // The aurora seasons are computed, so that source still lands when SWPC is down; the highlights source finds no text and lands empty; the others fail.
    expect(file.sources.filter((s) => !s.ok).map((s) => s.id)).toEqual(["festivities", "national-festivities", "eclipses"]);
    expect(file.sources.find((s) => s.id === "aurora")!.detail).toMatchObject({ liveError: expect.stringMatching(/500/) });
    expect(file.attemptedAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("retries a 429 on one Wikidata source and carries on", async () => {
    const sleeps: number[] = [];
    let limited = false;
    const w = fakeNetwork((req) => {
      if (req.host === "query.wikidata.org" && req.query.includes("P837") && !limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "3" } };
      }
      return recordedRequest(req);
    });
    const file = await run(w.fetch, { sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps.filter((ms) => ms >= 1000)).toEqual([3000]);
    expect(file.sources.every((s) => s.ok)).toBe(true);
  });

  it("gives up on a source that keeps answering 429, without stopping the others", async () => {
    const w = fakeNetwork((req) => (req.host === "query.wikidata.org" && req.query.includes("wd:Q3887") ? { status: 429, headers: { "retry-after": "1" } } : recordedRequest(req)));
    const file = await run(w.fetch);
    expect(w.calls.filter((c) => c.query.includes("wd:Q3887"))).toHaveLength(3);
    expect(file.sources.find((s) => s.id === "eclipses")).toMatchObject({ ok: false, count: 0 });
    expect(file.sources.find((s) => s.id === "festivities")!.ok).toBe(true);
  });

  it("keeps the solar eclipses when only the lunar query fails", async () => {
    const w = fakeNetwork((req) => (req.query.includes("wd:Q19693318") ? { status: 500 } : recordedRequest(req)));
    const file = await run(w.fetch);
    const ecl = file.sources.find((s) => s.id === "eclipses")!;
    expect(ecl).toMatchObject({ ok: true, count: 4 });
    expect(ecl.detail).toMatchObject({ solar: 4, lunar: 0 });
    expect(String(ecl.detail?.lunarError)).toMatch(/500/);
  });

  it("fails every source, and keeps what it had, when the cities are not loaded", async () => {
    const file = await run(fakeNetwork(recordedRequest).fetch, { cities: [] });
    expect(file.sources.every((s) => !s.ok && /cities/.test(s.error!))).toBe(true);
    expect(file.events).toEqual([]);
  });

  it("refuses to run in a test without an injected fetch", async () => {
    await expect(refreshLiveEvents()).rejects.toThrow(/disabled/);
  });
});

describe("applySource", () => {
  const file = (): LiveEventsFile => ({ version: 1, sources: [], events: [] });
  const e = (id: string, feed: string, month = 6): StoredEvent => ({ ...ev(id, { month }), feed });

  it("replaces a source's events and keeps another source's, and the earlier source wins a duplicate id", () => {
    const f = file();
    applySource(f, { id: "eclipses", ok: true, count: 0, fetchedAt: "2026-11-18T00:00:00.000Z" }, [e("a", "eclipses"), e("dup", "eclipses")]);
    applySource(f, { id: "festivities", ok: true, count: 0, fetchedAt: "2026-11-18T00:00:00.000Z" }, [e("dup", "festivities"), e("b", "festivities")]);
    expect(f.events.map((x) => `${x.id}/${x.feed}`).sort()).toEqual(["a/eclipses", "b/festivities", "dup/festivities"]);
    applySource(f, { id: "eclipses", ok: true, count: 0, fetchedAt: "2026-11-19T00:00:00.000Z" }, []);
    expect(f.events.map((x) => x.id).sort()).toEqual(["b", "dup"]);
    expect(f.sources.map((s) => [s.id, s.count])).toEqual([["festivities", 2], ["eclipses", 0]]);
  });

  it("drops events and statuses of feeds no source produces any more (film festivals, sports)", () => {
    const f: LiveEventsFile = { version: 1, sources: [{ id: "sports", ok: true, count: 3 }], events: [e("old-sport", "sports"), e("old-dated", "dated-sports"), e("keep", "eclipses")] };
    applySource(f, { id: "eclipses", ok: true, count: 0, fetchedAt: "2026-11-18T00:00:00.000Z" }, [e("keep", "eclipses")]);
    expect(f.events.map((x) => x.id)).toEqual(["keep"]);
    expect(f.sources.map((s) => s.id)).toEqual(["eclipses"]);
  });

  it("stores a source's working state under its id without touching the others", () => {
    const f = file();
    applySource(f, { id: "highlights", ok: true, count: 0 }, [], { checks: 1 });
    applySource(f, { id: "eclipses", ok: true, count: 0 }, []);
    expect(f.state).toEqual({ highlights: { checks: 1 } });
  });
});

describe("getLiveEvents", () => {
  const old = "2026-01-01T00:00:00.000Z";
  const nowOpts = { sleep: noSleep, pauseMs: 0, hostPauseMs: 0, places: PLACES, maxChecks: 9 };

  it("with an empty store, waits for one refresh and returns its events without the internal feed field", async () => {
    const w = fakeNetwork(recordedRequest);
    const events = await getLiveEvents({ fetch: w.fetch, ...nowOpts });
    expect(events).toHaveLength(FULL);
    expect(events.every((e) => !("feed" in e))).toBe(true);
    const calls = w.calls.length;
    // A second call is served from the fresh store with no new request.
    expect(await getLiveEvents({ fetch: w.fetch, ...nowOpts })).toHaveLength(FULL);
    expect(w.calls).toHaveLength(calls);
  });

  it("shares one refresh between concurrent callers", async () => {
    const w = fakeNetwork(recordedRequest);
    const opts = { fetch: w.fetch, ...nowOpts };
    const [a, b, c] = await Promise.all([getLiveEvents(opts), getLiveEvents(opts), getLiveEvents(opts)]);
    expect(w.calls.filter((x) => x.query.includes("wd:Q3887"))).toHaveLength(1);
    expect([a.length, b.length, c.length]).toEqual([FULL, FULL, FULL]);
  });

  it("serves a stale copy at once and refreshes in the background", async () => {
    seedLiveEvents([ev("old-1")], { fetchedAt: old, attemptedAt: old });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const w = fakeNetwork(async (req) => {
      await gate;
      return recordedRequest(req);
    });
    const served = await getLiveEvents({ fetch: w.fetch, ...nowOpts });
    expect(served.map((e) => e.id)).toEqual(["old-1"]);
    expect(w.calls.length).toBeLessThanOrEqual(2);
    release();
    // Wait for the whole refresh, not only the first events, so it does not run on into the next test.
    await vi.waitFor(async () => expect((await liveEventsStatus()).sources.find((x) => x.id === "highlights")?.detail).toMatchObject({ checked: 9 }), { timeout: 5000 });
    await vi.waitFor(async () => expect((await liveEventsStatus()).sources).toHaveLength(5), { timeout: 5000 });
    expect((await liveEventsStatus()).total).toBe(FULL);
  });

  it("does not refresh a fresh copy, and not within an hour of a failed attempt", async () => {
    seedLiveEvents([ev("fresh")], { fetchedAt: new Date().toISOString() });
    const w = fakeNetwork(recordedRequest);
    // Seeded files carry no per-source lines, so mark every source as landed just now.
    const raw = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    raw.sources = SOURCES.map((s) => ({ id: s.id, ok: true, count: 0, fetchedAt: new Date().toISOString() }));
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(raw));
    resetLiveEventsForTests();
    expect((await getLiveEvents({ fetch: w.fetch })).map((e) => e.id)).toEqual(["fresh"]);
    expect(w.calls).toHaveLength(0);

    const now = new Date();
    seedLiveEvents([ev("stale")], { fetchedAt: old, attemptedAt: new Date(now.getTime() - 10 * 60_000).toISOString() });
    // Every source landed long ago and the last attempt, ten minutes ago, failed: wait the hour.
    const failed = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    failed.sources = SOURCES.map((s) => ({ id: s.id, ok: false, count: 0, error: "timeout", fetchedAt: old }));
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(failed));
    resetLiveEventsForTests();
    expect((await getLiveEvents({ fetch: w.fetch })).map((e) => e.id)).toEqual(["stale"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.calls).toHaveLength(0);
  });

  it("never throws: an empty store and dead services give only what is computed locally (the aurora seasons)", async () => {
    const w = fakeNetwork(() => {
      throw new Error("network down");
    });
    const events = await getLiveEvents({ fetch: w.fetch, ...nowOpts });
    expect(events.map((e) => e.id)).toEqual(["aurora-season-north"]);
  });

  it("never throws: a corrupt store file gives [] (or fresh data)", async () => {
    writeFileSync(join(TMP, "events-live.json"), "{ not json");
    expect(await getLiveEvents()).toEqual([]);
    resetLiveEventsForTests();
    const events = await getLiveEvents({ fetch: fakeNetwork(recordedRequest).fetch, ...nowOpts });
    expect(events).toHaveLength(FULL);
  });

  it("drops malformed stored entries instead of throwing", async () => {
    seedLiveEvents([ev("ok")]);
    const raw = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    raw.events.push(
      { id: "no-cities", month: 6, recurring: true, tags: [], feed: "festivities" },
      { id: "bad-month", title: "x", month: 13, cityIds: [], tags: [], recurring: true, feed: "festivities" },
      { id: "bad-months", title: "x", month: 6, months: [6, 14], cityIds: [], tags: [], recurring: true, feed: "festivities" },
      null
    );
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(raw));
    resetLiveEventsForTests();
    expect((await getLiveEvents()).map((e) => e.id)).toEqual(["ok"]);
  });

  it("filters out events of feeds that no source produces (a stored copy from before the refocus)", async () => {
    seedLiveEvents([ev("keeps")]);
    const raw = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    raw.events.push(
      { ...ev("old-film"), feed: "festivals", tags: ["film-festival"] },
      { ...ev("old-sport"), feed: "sports", kind: "sport" },
      { ...ev("old-dated-sport"), feed: "dated-sports", kind: "sport" },
      { ...ev("no-feed") }
    );
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(raw));
    resetLiveEventsForTests();
    expect((await getLiveEvents()).map((e) => e.id)).toEqual(["keeps"]);
    expect((await liveEventsStatus()).total).toBe(1);
  });

  it("drops the Japan Meteorological Agency feed and the earlier phenomenon-list nature events from a stored copy, on read and in the status", async () => {
    seedLiveEvents([ev("keeps")]);
    const raw = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    raw.sources.push({ id: "jma", ok: true, count: 2, fetchedAt: "2026-11-10T00:00:00.000Z" }, { id: "inaturalist", ok: true, count: 2, fetchedAt: "2026-11-10T00:00:00.000Z" });
    raw.events.push(
      { ...ev("jma-sakura-tokyo", { kind: "nature", cityIds: ["kyoto-japan"], tags: ["cherry-blossom"] }), feed: "jma", source: "jma" },
      { ...ev("inat-jacaranda-pretoria-south-africa", { kind: "nature", cityIds: ["pretoria-south-africa"], tags: ["jacaranda"] }), feed: "inaturalist" },
      { ...ev("inat-77541-pretoria-south-africa", { kind: "nature", cityIds: ["pretoria-south-africa"], tags: ["bloom"] }), feed: "inaturalist" },
      { ...ev("hl-kyoto-japan-cherry-blossom", { kind: "nature", cityIds: ["kyoto-japan"], tags: ["nature"] }), feed: "highlights" }
    );
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(raw));
    resetLiveEventsForTests();
    expect((await getLiveEvents()).map((e) => e.id)).toEqual(["keeps", "hl-kyoto-japan-cherry-blossom"]);
    const status = await liveEventsStatus();
    expect(status.sources.map((x) => x.id)).toEqual([]);
    expect(status.total).toBe(2);
  });

  it("adds events computed from Meridian's own data, with a status line, without storing them", async () => {
    seedLiveEvents([ev("stored")]);
    const computed: ComputedSource = {
      id: "tourism-seasons",
      compute: () => ({ events: [{ ...ev("season-peak-x", { kind: "season", tags: ["peak-season"] }), feed: "tourism-seasons" }], detail: { measuredCities: 1 } }),
    };
    expect((await getLiveEvents({ computed: [computed] })).map((e) => e.id)).toEqual(["stored", "season-peak-x"]);
    const s = await liveEventsStatus({ computed: [computed] });
    expect(s.total).toBe(2);
    expect(s.sources.find((x) => x.id === "tourism-seasons")).toMatchObject({ ok: true, count: 1, detail: { measuredCities: 1 } });
    expect(JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8")).events).toHaveLength(1);
  });

  it("survives a computed source that throws", async () => {
    seedLiveEvents([ev("stored")]);
    const bad: ComputedSource = { id: "tourism-seasons", compute: () => { throw new Error("no place data"); } };
    expect((await getLiveEvents({ computed: [bad] })).map((e) => e.id)).toEqual(["stored"]);
    expect((await liveEventsStatus({ computed: [bad] })).sources.find((x) => x.id === "tourism-seasons")).toMatchObject({ ok: false, error: "no place data" });
  });

  it("reports sources and totals for diagnostics", async () => {
    await getLiveEvents({ fetch: fakeNetwork(recordedRequest).fetch, ...nowOpts, now: NOW_FETCH });
    const s = await liveEventsStatus();
    expect(s.total).toBe(FULL);
    expect(s.sources.map((x) => x.id)).toEqual(IDS);
    expect(s.fetchedAt).toBe("2026-11-18T12:00:00.000Z");
  });
});


describe("multi-month events in the consumers", () => {
  const list: MeridianEvent[] = [
    ev("bloom", { kind: "nature", cityIds: ["lisbon-portugal"], month: 3, months: [3, 4], tags: ["cherry-blossom", "nature"] }),
    ev("wrap", { kind: "sky", cityIds: ["lisbon-portugal"], month: 12, months: [12, 1, 2], tags: ["aurora"] }),
    ev("peak", { kind: "season", cityIds: ["lisbon-portugal"], month: 7, months: [7, 8], tags: ["peak-season"] }),
  ];
  beforeEach(() => seedLiveEvents(list));

  it("matches the map month against every month of the event, not only the first", async () => {
    expect((await eventPointsFor(4, new Date("2026-11-18T00:00:00Z"))).map((p) => p.eventId)).toEqual(["bloom"]);
    expect((await eventPointsFor(1, new Date("2026-11-18T00:00:00Z"))).map((p) => p.eventId)).toEqual(["wrap"]);
    expect((await eventPointsFor(12, new Date("2026-11-18T00:00:00Z"))).map((p) => p.eventId)).toEqual(["wrap"]);
  });

  it("carries the months on the map point", async () => {
    const [p] = await eventPointsFor(3, new Date("2026-11-18T00:00:00Z"));
    expect(p).toMatchObject({ eventId: "bloom", months: [3, 4], kind: "nature" });
  });

  it("leaves tourism seasons off the map unless asked, and keeps them in a city's list", async () => {
    expect(await eventPointsFor(7, new Date("2026-11-18T00:00:00Z"))).toEqual([]);
    expect((await eventPointsFor(8, new Date("2026-11-18T00:00:00Z"), { includeSeasons: true })).map((p) => p.eventId)).toEqual(["peak"]);
    expect((await eventsForCities(["lisbon-portugal"], new Date("2026-11-18T00:00:00Z"))).map((e) => e.id).sort()).toEqual(["bloom", "peak", "wrap"]);
  });

  it("still lists the season tags for the Repeat a trip chips", async () => {
    const tags = (await eventTagCounts(new Date("2026-11-18T00:00:00Z"))).map((t) => t.tag);
    expect(tags).toEqual(expect.arrayContaining(["peak-season", "cherry-blossom", "aurora"]));
  });

  it("tags a Replay month with an event that covers it in any of its months", async () => {
    const lisbon = await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps().deps);
    const r = await runReplay(
      { template: { journeyId: lisbon.journey.id }, bend: { monthShift: null }, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 }, constraints: { tags: ["cherry-blossom"] }, limit: 50 },
      {
        journeys: [lisbon.journey],
        settings: { homeCityId: "berlin-germany" },
        seasonality: SEASONALITY,
        getCity,
        flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }),
        eurOf: (a) => a,
        now: () => NOW,
        events: await loadEvents(new Date("2026-11-18T00:00:00Z")),
      }
    );
    expect(r.results.length).toBeGreaterThan(0);
    for (const x of r.results) {
      expect([3, 4]).toContain(x.month);
      expect(x.cityId).toBe("lisbon-portugal");
    }
  });
});

describe("eclipse tag constraint in replay", () => {
  async function eclipseCells(today: string): Promise<string[]> {
    seedLiveEvents([
      ev("wd-eclipse-2027", { kind: "eclipse", month: 8, date: "2027-08-02", recurring: false, tags: ["eclipse"], cityIds: ["athens-greece"] }),
      ev("wd-eclipse-2028", { kind: "eclipse", month: 1, date: "2028-01-26", recurring: false, tags: ["eclipse"], cityIds: ["seville-spain"] }),
      ev("wd-eclipse-2030", { kind: "eclipse", month: 6, date: "2030-06-01", recurring: false, tags: ["eclipse"], cityIds: ["oslo-norway"] }),
    ]);
    let lisbon: Journey = lisbonJourney();
    lisbon = (await computeFingerprint(lisbon, fixtureFingerprintDeps().deps)).journey;
    const r = await runReplay(
      { template: { journeyId: lisbon.id }, bend: { monthShift: null }, weights: { climate: 1, spend: 0, crowd: 0, flight: 0 }, constraints: { tags: ["eclipse"] }, limit: 50 },
      {
        journeys: [lisbon],
        settings: { homeCityId: "berlin-germany" },
        seasonality: SEASONALITY,
        getCity,
        flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }),
        eurOf: (a) => a,
        now: () => NOW,
        events: await loadEvents(new Date(`${today}T00:00:00Z`)),
      }
    );
    for (const x of r.results) expect(x.events!.some((e) => e.tags.includes("eclipse"))).toBe(true);
    return r.results.map((x) => `${x.cityId}/${x.month}`).sort();
  }

  it("tags a month only with the eclipse in its next occurrence, never one years away", async () => {
    // 2027-10-01: the 2028-01 eclipse is January's next occurrence (Seville); the 2030-06 one is not June's.
    expect(await eclipseCells("2027-10-01")).toEqual(["seville-spain/1"]);
    // 2026-10-30: only the 2027-08 eclipse (Athens) is ahead for August; the 2028 and 2030 ones tag no 2027 month.
    expect(await eclipseCells("2026-10-30")).toEqual(["athens-greece/8"]);
  });
});

describe("isStale", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const allSources = (fetchedAt: string) => SOURCES.map((s) => ({ id: s.id, ok: true, count: 1, fetchedAt }));

  it("is fresh when every source landed within its own interval", () => {
    expect(isStale({ version: 1, sources: allSources(at(30 * 60_000)), events: [], attemptedAt: at(30 * 60_000) }, now)).toBe(false);
  });

  it("treats the three-hour aurora source and the hourly highlights check as due sooner than the weekly ones", () => {
    const sources = allSources(at(60_000));
    const aurora = sources.find((s) => s.id === "aurora")!;
    aurora.fetchedAt = at(4 * 3_600_000);
    expect(isStale({ version: 1, sources, events: [], attemptedAt: at(30 * 60_000) }, now)).toBe(false);
    expect(isStale({ version: 1, sources, events: [], attemptedAt: at(61 * 60_000) }, now)).toBe(true);
    aurora.fetchedAt = at(2 * 3_600_000);
    expect(isStale({ version: 1, sources, events: [], attemptedAt: at(61 * 60_000) }, now)).toBe(false);
  });

  it("keeps the weekly sources fresh for six days and stale after eight", () => {
    const sources = allSources(at(60_000));
    sources.find((s) => s.id === "eclipses")!.fetchedAt = at(6 * 86_400_000);
    expect(isStale({ version: 1, sources, events: [], attemptedAt: at(2 * 3_600_000) }, now)).toBe(false);
    sources.find((s) => s.id === "eclipses")!.fetchedAt = at(8 * 86_400_000);
    expect(isStale({ version: 1, sources, events: [], attemptedAt: at(2 * 3_600_000) }, now)).toBe(true);
  });

  it("honours maxAgeDays as a cap on every interval", () => {
    const sources = allSources(at(2 * 86_400_000));
    const file = { version: 1 as const, sources, events: [], attemptedAt: at(2 * 3_600_000) };
    expect(isStale(file, now, 7)).toBe(true); // the hourly and three-hour sources are long overdue
    const weeklyOnly = { ...file, sources: sources.map((s) => ({ ...s, fetchedAt: ["highlights", "aurora"].includes(s.id) ? at(60_000) : s.fetchedAt })) };
    expect(isStale(weeklyOnly, now, 7)).toBe(false);
    expect(isStale(weeklyOnly, now, 1)).toBe(true);
  });

  it("retries a source that never landed after two minutes, not an hour", () => {
    const some = allSources(at(60_000)).slice(0, 2);
    expect(isStale({ version: 1, sources: some, events: [], attemptedAt: at(60_000) }, now)).toBe(false);
    expect(isStale({ version: 1, sources: some, events: [], attemptedAt: at(3 * 60_000) }, now)).toBe(true);
  });

  it("retries after two minutes while the highlights source still has cities to check, and not once it has none", () => {
    const sources = (pending: number, ok = true) => SOURCES.map((s) => (s.id === "highlights" ? { id: s.id, ok, count: 3, fetchedAt: at(10 * 60_000), detail: { pending } } : { id: s.id, ok: true, count: 1, fetchedAt: at(10 * 60_000) }));
    const file = (pending: number, ok = true, attemptedAt = at(3 * 60_000)) => ({ version: 1 as const, sources: sources(pending, ok), events: [], attemptedAt });
    expect(isStale(file(40), now)).toBe(true);
    expect(isStale(file(40, true, at(60_000)), now)).toBe(false);
    expect(isStale(file(0), now)).toBe(false);
    // A run that failed does not count as pending work: it waits the hour like any failure.
    expect(isStale(file(40, false), now)).toBe(false);
  });

  it("reads pending work only from a source whose last run succeeded", () => {
    const f = (ok: boolean, pending: unknown) => ({ version: 1 as const, sources: [{ id: "highlights", ok, count: 0, detail: { pending } as Record<string, number | string> }], events: [] });
    expect(hasPendingWork("highlights", f(true, 12))).toBe(true);
    expect(hasPendingWork("highlights", f(true, 0))).toBe(false);
    expect(hasPendingWork("highlights", f(false, 12))).toBe(false);
    expect(hasPendingWork("highlights", f(true, "12"))).toBe(false);
    expect(hasPendingWork("aurora", f(true, 12))).toBe(false);
  });

  it("waits an hour, not two minutes, before retrying a source that failed", () => {
    const tenMinAgo = at(10 * 60_000);
    const sources = SOURCES.map((s) => (s.id === "eclipses" ? { id: s.id, ok: false, count: 0, error: "timeout" } : { id: s.id, ok: true, count: 1, fetchedAt: tenMinAgo }));
    expect(isStale({ version: 1, sources, events: [], attemptedAt: tenMinAgo }, now)).toBe(false);
  });
});

describe("keeping a background refresh alive on Vercel", () => {
  it("hands the refresh to the request context's waitUntil", async () => {
    seedLiveEvents([ev("old-1")], { fetchedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), attemptedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const waited: Promise<unknown>[] = [];
    const key = Symbol.for("@vercel/request-context");
    (globalThis as Record<symbol, unknown>)[key] = { get: () => ({ waitUntil: (p: Promise<unknown>) => waited.push(p) }) };
    try {
      await getLiveEvents({ fetch: fakeNetwork(recordedRequest).fetch, ...nowOpts2 });
      expect(waited).toHaveLength(1);
      await waited[0];
    } finally {
      delete (globalThis as Record<symbol, unknown>)[key];
    }
  });
});

describe("refreshing only what is due", () => {
  it("runs the highlights source again at once while it has pending cities, though it landed minutes ago", async () => {
    const recent = new Date(NOW_FETCH.getTime() - 5 * 60_000).toISOString();
    seedLiveEvents([], { fetchedAt: recent, attemptedAt: recent });
    const seeded = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf8"));
    seeded.sources = SOURCES.map((s) => ({ id: s.id, ok: true, count: 0, fetchedAt: recent, ...(s.id === "highlights" ? { detail: { pending: 120 } } : {}) }));
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(seeded));
    resetLiveEventsForTests();
    const w = fakeNetwork(recordedRequest);
    const claude = springClaude();
    setAnthropicClient(claude.client);
    await run(w.fetch, { onlyDue: true, maxChecks: 9 });
    expect(new Set(w.calls.map((c) => c.host))).toEqual(new Set(["en.wikipedia.org", "en.wikivoyage.org", "www.wikidata.org"]));
    expect(claude.calls.length).toBeGreaterThan(0);
  });

  it("runs only sources that never landed or are older than their own interval", async () => {
    const recent = new Date(NOW_FETCH.getTime() - 3_600_000).toISOString();
    seedLiveEvents([], { fetchedAt: recent, attemptedAt: recent });
    // Seed sources: all but eclipses landed an hour ago.
    const seeded = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf8"));
    seeded.sources = SOURCES.filter((s) => s.id !== "eclipses").map((s) => ({ id: s.id, ok: true, count: 0, fetchedAt: recent }));
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(seeded));
    resetLiveEventsForTests();
    const w = fakeNetwork(recordedRequest);
    await run(w.fetch, { onlyDue: true });
    // The eclipse source never landed; the hourly source is not yet due after exactly an hour (it is due after more).
    expect(w.calls.filter((c) => c.host === "query.wikidata.org").map((c) => c.query.includes("Q19693318") ? "lunar" : "solar")).toEqual(["solar", "lunar"]);
    expect(w.calls.some((c) => c.host === "en.wikivoyage.org")).toBe(false);
    expect(w.calls.some((c) => c.host === "services.swpc.noaa.gov")).toBe(false);
  });

  it("refreshes the aurora source every three hours and leaves the weekly sources alone", async () => {
    const lastWeek = new Date(NOW_FETCH.getTime() - 3_600_000).toISOString();
    const stale = new Date(NOW_FETCH.getTime() - 4 * 3_600_000).toISOString();
    seedLiveEvents([], { fetchedAt: lastWeek, attemptedAt: stale });
    const seeded = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf8"));
    seeded.sources = SOURCES.map((s) => ({ id: s.id, ok: true, count: 0, fetchedAt: s.id === "aurora" ? stale : lastWeek }));
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(seeded));
    resetLiveEventsForTests();
    const w = fakeNetwork(recordedRequest);
    await run(w.fetch, { onlyDue: true });
    expect(w.calls.map((c) => c.host)).toEqual(["services.swpc.noaa.gov"]);
  });
});
