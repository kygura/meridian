import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { City, Journey, MeridianEvent } from "../../src/types";
import { getCities, loadCities } from "./cities";
import {
  bindingsOf,
  buildCityIndex,
  buildEvents,
  classify,
  cityIndexFor,
  countryKey,
  datedQuery,
  dedupeAndSort,
  getLiveEvents,
  liveEventsStatus,
  monthOf,
  parseDated,
  parseEclipses,
  parsePoint,
  parseRecurring,
  refreshLiveEvents,
  resetLiveEventsForTests,
  runSparql,
  tagOf,
  USER_AGENT,
  type StoredEvent,
} from "./liveEvents";
import { eventPointsFor, eventsForCities, eventTagCounts } from "./phenomena";
import { loadEvents } from "./replayService";
import { runReplay } from "./replay";
import { fixtureFingerprintDeps, lisbonJourney, getCity, SEASONALITY, NOW } from "./__fixtures__/journal";
import { computeFingerprint } from "./fingerprint";
import { ev, fakeWikidata, fixtureJson, recorded, seedLiveEvents, sourceOfQuery } from "./__fixtures__/liveEvents";

const fx = (name: string) => bindingsOf(fixtureJson(name));
const noSleep = async () => undefined;
const NOW_FETCH = new Date("2026-11-18T12:00:00Z");

let TMP: string;
beforeAll(() => loadCities());
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-live-events-"));
  process.env.DATA_DIR = TMP;
  resetLiveEventsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  resetLiveEventsForTests();
  vi.restoreAllMocks();
});

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

describe("recurring festivals (fixture)", () => {
  const raws = parseRecurring(fx("wikidata-festivals.json"));

  it("keeps one row per item and month and skips rows whose month is not a month item", () => {
    expect(raws).toHaveLength(6); // 8 recorded rows: Haifa (Q217782) and Oxegen (Q1998) have no month item
    expect(raws.map((r) => `${r.title}/${r.month}`).sort()).toEqual([
      "Berlin International Film Festival/2",
      "Cannes Film Festival/5",
      "Oktoberfest/10",
      "Oktoberfest/9",
      "Zanzibar International Film Festival/6",
      "Zanzibar International Film Festival/7",
    ]);
    expect(raws.every((r) => r.recurring && r.date === undefined)).toBe(true);
  });

  it("places events on cities, splits multi-month items into -m<month> ids and tags them", () => {
    const built = buildEvents("festivals", "festival", raws, cityIndexFor(getCities()));
    expect(built.unmatched).toBe(0);
    const byId = new Map(built.events.map((e) => [e.id, e]));
    expect([...byId.keys()].sort()).toEqual(["wd-Q102400-m10", "wd-Q102400-m9", "wd-Q130871", "wd-Q4023821-m6", "wd-Q4023821-m7", "wd-Q42369"]);
    expect(byId.get("wd-Q130871")).toMatchObject({ title: "Berlin International Film Festival", kind: "culture", month: 2, recurring: true, cityIds: ["berlin-germany"], source: "wikidata", sourceUrl: "https://www.wikidata.org/wiki/Q130871" });
    expect(byId.get("wd-Q130871")!.tags).toEqual(["festival", "culture", "film-festival"]);
    expect(byId.get("wd-Q102400-m9")).toMatchObject({ kind: "festival", cityIds: ["munich-germany"], tags: ["festival", "folk-festival"] });
    // Cannes is not a city in the dataset; Nice is the nearest city within 40 km.
    expect(byId.get("wd-Q42369")!.cityIds).toEqual(["nice-france"]);
  });
});

describe("recurring sports (fixture)", () => {
  it("classifies sporting events and tags marathons", () => {
    const built = buildEvents("sports", "sport", parseRecurring(fx("wikidata-sports.json")), cityIndexFor(getCities()));
    const byId = new Map(built.events.map((e) => [e.id, e]));
    expect(byId.get("wd-Q578794")).toMatchObject({ title: "London Marathon", kind: "sport", month: 4, tags: ["sport", "marathon"], cityIds: ["london-united-kingdom"] });
    expect(byId.get("wd-Q60874")!.tags).toEqual(["sport", "tennis-tournament"]);
    expect(built.events.every((e) => e.kind === "sport")).toBe(true);
    expect(built.unmatched).toBe(1); // the Dakar Rally has no fixed city
  });
});

describe("dated events (fixture)", () => {
  const raws = parseDated(fx("wikidata-dated-sports.json"));
  it("reads a 1 January date as a year and keeps the real date; one event per item", () => {
    const wwc = raws.find((r) => r.title.includes("Women's World Cup"))!;
    expect(wwc.date).toBe("2027-06-24");
    expect(wwc.month).toBe(6);
    expect(raws.map((r) => r.title).sort()).toEqual(["2027 FIFA Women's World Cup", "2027 Pan American Games", "2027 Rugby World Cup", "UFC 335"]);
    expect(raws.every((r) => !r.recurring && /^\d{4}-\d{2}-\d{2}$/.test(r.date!))).toBe(true);
  });
  it("builds non-recurring events with their date and month", () => {
    const built = buildEvents("dated-sports", "sport", raws, cityIndexFor(getCities()));
    const ufc = built.events.find((e) => e.id === "wd-Q141219932")!;
    expect(ufc).toMatchObject({ date: "2026-12-12", month: 12, recurring: false, kind: "sport", cityIds: ["las-vegas-united-states"], tags: ["sport", "mixed-martial-arts-event"] });
    expect(built.events.every((e) => e.month === Number(e.date!.slice(5, 7)))).toBe(true);
  });
  it("drops an item whose only date is 1 January", () => {
    const rows = [{ e: { value: "http://www.wikidata.org/entity/Q1" }, eLabel: { value: "Year only" }, date: { value: "2027-01-01T00:00:00Z" }, coord: { value: "Point(1 1)" }, types: { value: "" }, sl: { value: "9" } }];
    expect(parseDated(rows)).toEqual([]);
  });
  it("builds a query window from today, 18 months ahead", () => {
    const q = datedQuery("Q16510064", new Date("2026-11-18T10:00:00Z"));
    expect(q).toContain('"2026-11-18T00:00:00Z"');
    expect(q).toContain('"2028-05-18T00:00:00Z"');
  });
});

describe("eclipses (fixture)", () => {
  const raws = parseEclipses(fx("wikidata-eclipses.json"));
  it("skips partial eclipses", () => {
    expect(raws).toHaveLength(4);
    expect(raws.some((r) => r.title.includes("2029"))).toBe(false);
  });
  it("places an eclipse on its greatest-eclipse points and on each listed country's hub city", () => {
    const built = buildEvents("eclipses", "eclipse", raws, cityIndexFor(getCities()));
    const aug = built.events.find((e) => e.date === "2027-08-02")!;
    expect(aug).toMatchObject({ kind: "eclipse", tags: ["eclipse", "solar-eclipse", "total-solar-eclipse"], recurring: false });
    expect(aug.cityIds).toContain("luxor-egypt"); // near the point of greatest eclipse
    expect(aug.cityIds).toContain("cairo-egypt"); // the listed country's capital
    expect(built.events.find((e) => e.date === "2028-07-22")!.cityIds).toEqual(["canberra-australia"]);
  });
  it("keeps an eclipse with no city (annular, over the ocean) and counts it", () => {
    const built = buildEvents("eclipses", "eclipse", raws, cityIndexFor(getCities()));
    expect(built.unplaced).toBe(2);
    expect(built.events.filter((e) => e.cityIds.length === 0).map((e) => e.date)).toEqual(["2027-02-06", "2028-01-26"]);
    expect(built.unmatched).toBe(0);
  });
});

describe("classification", () => {
  it("normalizes type labels to kebab tags", () => {
    expect(tagOf("annual film festival")).toBe("film-festival");
    expect(tagOf("Recurring sporting event edition")).toBe("sporting-event");
    expect(tagOf("edition of the UEFA European Championship")).toBe("uefa-european-championship");
    expect(tagOf("Café  Fête")).toBe("cafe-fete");
  });
  it("calls film, music and arts festivals culture, the rest festival", () => {
    expect(classify("festival", ["film festival"]).kind).toBe("culture");
    expect(classify("festival", ["music festival"]).kind).toBe("culture");
    expect(classify("festival", ["carnival"]).kind).toBe("festival");
    expect(classify("festival", ["religious festival", "organization"])).toEqual({ kind: "festival", tags: ["festival", "religious-festival"] });
    expect(classify("festival", []).kind).toBe("festival");
  });
  it("drops generic labels and caps the tag count", () => {
    expect(classify("sport", ["organization", "recurring event", "sports season", "annual event", "award", "article"]).tags).toEqual(["sport"]);
    expect(classify("sport", Array.from({ length: 12 }, (_, i) => `kind ${i}`)).tags).toHaveLength(6);
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
    const out = dedupeAndSort([e("wd-Q2", "B", 3, "festivals"), e("wd-Q1", "A", 3, "eclipses"), e("wd-Q2", "B again", 3, "sports"), e("wd-Q3", "C", 1, "sports")]);
    expect(out.map((x) => `${x.id}/${x.feed}`)).toEqual(["wd-Q3/sports", "wd-Q1/eclipses", "wd-Q2/festivals"]);
  });
});

describe("runSparql", () => {
  const ok = { body: fixtureJson("wikidata-sports.json") };

  it("sends the Wikidata etiquette headers and returns the bindings", async () => {
    const w = fakeWikidata(() => ok);
    const rows = await runSparql("SELECT 1", { fetch: w.fetch, sleep: noSleep });
    expect(rows).toHaveLength(5);
    expect(w.calls[0]!.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" });
    expect(USER_AGENT).toBe("Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)");
    expect(w.calls[0]!.url.startsWith("https://query.wikidata.org/sparql?")).toBe(true);
  });

  it("waits Retry-After on 429 and retries", async () => {
    const sleeps: number[] = [];
    const w = fakeWikidata((_q, n) => (n === 1 ? { status: 429, headers: { "retry-after": "7" } } : ok));
    const rows = await runSparql("q", { fetch: w.fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(rows).toHaveLength(5);
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

describe("refreshLiveEvents", () => {
  it("runs two sources at a time by default", async () => {
    const w = fakeWikidata(async (q) => {
      await new Promise((r) => setTimeout(r, 5));
      return recorded(q);
    });
    await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, sleep: noSleep, pauseMs: 0 });
    expect(w.maxActive()).toBe(2);
    expect(w.calls).toHaveLength(5);
  });

  it("saves each source as it finishes and stops starting sources when the budget runs out", async () => {
    let calls = 0;
    const w = fakeWikidata((q) => {
      calls += 1;
      if (calls > 1) throw new Error("should not start after the budget");
      return recorded(q);
    });
    // A 5.5 s budget leaves no room to start a source after the first (sources stop 5 s before the deadline).
    const realNow = Date.now;
    let t = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 400));
    try {
      await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, sleep: noSleep, pauseMs: 0, budgetMs: 6000, concurrency: 1 });
    } finally {
      spy.mockRestore();
    }
    const status = await liveEventsStatus();
    expect(status.sources.map((x) => x.id)).toEqual(["eclipses"]);
    expect(status.total).toBe(4);
    expect(status.attemptedAt).not.toBeNull();
  });

  it("runs the five sources one at a time when asked, merges them and writes the store", async () => {
    const w = fakeWikidata(recorded);
    const sleeps: number[] = [];
    const file = await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, sleep: async (ms) => void sleeps.push(ms), concurrency: 1 });
    expect(w.calls.map((c) => sourceOfQuery(c.query))).toEqual(["eclipses", "dated-sports", "dated-festivals", "festivals", "sports"]);
    expect(w.maxActive()).toBe(1);
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
    expect(file.fetchedAt).toBe("2026-11-18T12:00:00.000Z");
    expect(file.sources.map((s) => [s.id, s.ok, s.count, s.unmatched ?? 0])).toEqual([
      ["eclipses", true, 4, 0],
      ["dated-sports", true, 3, 1],
      ["dated-festivals", true, 0, 0],
      ["festivals", true, 6, 0],
      ["sports", true, 4, 1],
    ]);
    expect(file.sources.find((s) => s.id === "eclipses")!.unplaced).toBe(2);
    expect(file.events).toHaveLength(17);
    expect(new Set(file.events.map((e) => e.id)).size).toBe(17);
    expect(file.events.every((e) => e.source === "wikidata" && e.sourceUrl!.startsWith("https://www.wikidata.org/wiki/Q"))).toBe(true);
    expect(file.events.map((e) => e.month)).toEqual([...file.events.map((e) => e.month)].sort((a, b) => a - b));
    const onDisk = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    expect(onDisk.events).toHaveLength(17);
    expect(onDisk.sources).toHaveLength(5);
  });

  it("keeps a failed source's previous events and fetchedAt, and records the error", async () => {
    await refreshLiveEvents({ fetch: fakeWikidata(recorded).fetch, now: new Date("2026-11-18T12:00:00Z"), sleep: noSleep, pauseMs: 0 });
    const w = fakeWikidata((q) => (sourceOfQuery(q) === "eclipses" ? { status: 500 } : recorded(q)));
    const file = await refreshLiveEvents({ fetch: w.fetch, now: new Date("2026-11-19T12:00:00Z"), sleep: noSleep, pauseMs: 0 });
    const ecl = file.sources.find((s) => s.id === "eclipses")!;
    expect(ecl).toMatchObject({ ok: false, count: 4, fetchedAt: "2026-11-18T12:00:00.000Z" });
    expect(ecl.error).toMatch(/500/);
    expect(file.events.filter((e) => e.kind === "eclipse")).toHaveLength(4);
    expect(file.sources.find((s) => s.id === "festivals")).toMatchObject({ ok: true, fetchedAt: "2026-11-19T12:00:00.000Z" });
    expect(file.fetchedAt).toBe("2026-11-19T12:00:00.000Z");
  });

  it("treats an empty answer from a source that had events as a failure and keeps them", async () => {
    await refreshLiveEvents({ fetch: fakeWikidata(recorded).fetch, now: NOW_FETCH, sleep: noSleep, pauseMs: 0 });
    const w = fakeWikidata((q) => (sourceOfQuery(q) === "festivals" ? { body: { results: { bindings: [] } } } : recorded(q)));
    const file = await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, sleep: noSleep, pauseMs: 0 });
    expect(file.sources.find((s) => s.id === "festivals")).toMatchObject({ ok: false, count: 6 });
    expect(file.events.filter((e) => e.tags.includes("film-festival"))).toHaveLength(4);
  });

  it("does not wipe the store or advance fetchedAt when every source fails", async () => {
    await refreshLiveEvents({ fetch: fakeWikidata(recorded).fetch, now: new Date("2026-11-18T12:00:00Z"), sleep: noSleep, pauseMs: 0 });
    const down = fakeWikidata(() => ({ status: 500 }));
    const file = await refreshLiveEvents({ fetch: down.fetch, now: new Date("2026-11-20T12:00:00Z"), sleep: noSleep, pauseMs: 0 });
    expect(file.events).toHaveLength(17);
    expect(file.sources.every((s) => !s.ok)).toBe(true);
    expect(file.fetchedAt).toBe("2026-11-18T12:00:00.000Z");
    expect(file.attemptedAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("retries a 429 on one source and carries on", async () => {
    const sleeps: number[] = [];
    let limited = false;
    const w = fakeWikidata((q) => {
      if (sourceOfQuery(q) === "festivals" && !limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "3" } };
      }
      return recorded(q);
    });
    const file = await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, pauseMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([3000]);
    expect(w.calls).toHaveLength(6);
    expect(file.sources.every((s) => s.ok)).toBe(true);
  });

  it("gives up on a source that keeps answering 429, without stopping the others", async () => {
    const w = fakeWikidata((q) => (sourceOfQuery(q) === "sports" ? { status: 429, headers: { "retry-after": "1" } } : recorded(q)));
    const file = await refreshLiveEvents({ fetch: w.fetch, now: NOW_FETCH, pauseMs: 0, sleep: noSleep });
    expect(w.calls.filter((c) => sourceOfQuery(c.query) === "sports")).toHaveLength(3);
    expect(file.sources.find((s) => s.id === "sports")).toMatchObject({ ok: false, count: 0 });
    expect(file.sources.find((s) => s.id === "festivals")!.ok).toBe(true);
  });

  it("fails every source, and keeps what it had, when the cities are not loaded", async () => {
    const file = await refreshLiveEvents({ fetch: fakeWikidata(recorded).fetch, now: NOW_FETCH, pauseMs: 0, sleep: noSleep, cities: [] });
    expect(file.sources.every((s) => !s.ok && /cities/.test(s.error!))).toBe(true);
    expect(file.events).toEqual([]);
  });

  it("refuses to run in a test without an injected fetch", async () => {
    await expect(refreshLiveEvents()).rejects.toThrow(/disabled/);
  });
});

describe("getLiveEvents", () => {
  const old = "2026-01-01T00:00:00.000Z";

  it("with an empty store, waits for one refresh and returns its events without the internal feed field", async () => {
    const w = fakeWikidata(recorded);
    const events = await getLiveEvents({ fetch: w.fetch, sleep: noSleep, pauseMs: 0 });
    expect(events).toHaveLength(17);
    expect(events.every((e) => !("feed" in e))).toBe(true);
    expect(w.calls).toHaveLength(5);
    // A second call is served from the fresh store with no new request.
    expect(await getLiveEvents({ fetch: w.fetch, sleep: noSleep, pauseMs: 0 })).toHaveLength(17);
    expect(w.calls).toHaveLength(5);
  });

  it("shares one refresh between concurrent callers", async () => {
    const w = fakeWikidata(recorded);
    const opts = { fetch: w.fetch, sleep: noSleep, pauseMs: 0 };
    const [a, b, c] = await Promise.all([getLiveEvents(opts), getLiveEvents(opts), getLiveEvents(opts)]);
    expect(w.calls).toHaveLength(5);
    expect(a).toHaveLength(17);
    expect(b).toHaveLength(17);
    expect(c).toHaveLength(17);
  });

  it("serves a stale copy at once and refreshes in the background", async () => {
    seedLiveEvents([ev("old-1")], { fetchedAt: old, attemptedAt: old });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const w = fakeWikidata(async (q) => {
      await gate;
      return recorded(q);
    });
    const served = await getLiveEvents({ fetch: w.fetch, sleep: noSleep, pauseMs: 0 });
    expect(served.map((e) => e.id)).toEqual(["old-1"]);
    expect(w.calls.length).toBeLessThanOrEqual(2);
    release();
    await vi.waitFor(async () => expect((await liveEventsStatus()).total).toBe(17), { timeout: 3000 });
    expect((await getLiveEvents({ fetch: w.fetch })).length).toBe(17);
  });

  it("does not refresh a fresh copy, and not within an hour of a failed attempt", async () => {
    seedLiveEvents([ev("fresh")]);
    const w = fakeWikidata(recorded);
    expect((await getLiveEvents({ fetch: w.fetch })).map((e) => e.id)).toEqual(["fresh"]);
    expect(w.calls).toHaveLength(0);

    const now = new Date();
    seedLiveEvents([ev("stale")], { fetchedAt: old, attemptedAt: new Date(now.getTime() - 10 * 60_000).toISOString() });
    expect((await getLiveEvents({ fetch: w.fetch })).map((e) => e.id)).toEqual(["stale"]);
    expect(w.calls).toHaveLength(0);
  });

  it("honours maxAgeDays", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const hourAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    seedLiveEvents([ev("a")], { fetchedAt: twoDaysAgo, attemptedAt: hourAgo });
    const w = fakeWikidata(recorded);
    await getLiveEvents({ fetch: w.fetch, maxAgeDays: 7 });
    expect(w.calls).toHaveLength(0);
    await getLiveEvents({ fetch: w.fetch, maxAgeDays: 1, sleep: noSleep, pauseMs: 0 });
    await vi.waitFor(() => expect(w.calls.length).toBe(5), { timeout: 3000 });
  });

  it("never throws: an empty store and a dead Wikidata give []", async () => {
    const w = fakeWikidata(() => {
      throw new Error("network down");
    });
    expect(await getLiveEvents({ fetch: w.fetch, sleep: noSleep, pauseMs: 0 })).toEqual([]);
  });

  it("never throws: a corrupt store file gives [] (or fresh data) and a missing DATA_DIR is survivable", async () => {
    writeFileSync(join(TMP, "events-live.json"), "{ not json");
    expect(await getLiveEvents()).toEqual([]);
    resetLiveEventsForTests();
    const events = await getLiveEvents({ fetch: fakeWikidata(recorded).fetch, sleep: noSleep, pauseMs: 0 });
    expect(events).toHaveLength(17);
  });

  it("drops malformed stored entries instead of throwing", async () => {
    seedLiveEvents([ev("ok")]);
    const raw = JSON.parse(readFileSync(join(TMP, "events-live.json"), "utf-8"));
    raw.events.push({ id: "no-cities", month: 6, recurring: true, tags: [] }, { id: "bad-month", title: "x", month: 13, cityIds: [], tags: [], recurring: true }, null);
    writeFileSync(join(TMP, "events-live.json"), JSON.stringify(raw));
    resetLiveEventsForTests();
    expect((await getLiveEvents()).map((e) => e.id)).toEqual(["ok"]);
  });

  it("reports sources and totals for diagnostics", async () => {
    await getLiveEvents({ fetch: fakeWikidata(recorded).fetch, sleep: noSleep, pauseMs: 0, now: NOW_FETCH });
    const s = await liveEventsStatus();
    expect(s.total).toBe(17);
    expect(s.sources).toHaveLength(5);
    expect(s.fetchedAt).toBe("2026-11-18T12:00:00.000Z");
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
