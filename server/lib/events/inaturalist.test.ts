import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { City } from "../../../src/types";
import { getCities, loadCities } from "../cities";
import { refreshLiveEvents, resetLiveEventsForTests, liveEventsStatus } from "../liveEvents";
import {
  dueChecks,
  emptyInatState,
  eventsFromChecks,
  histogramUrl,
  observationsUrl,
  parseHistogram,
  parseTaxon,
  peakMonths,
  RECHECK_MS,
  type InatState,
} from "./inaturalist";
import { PHENOMENA } from "./phenomena";
import { fakeNetwork, fixtureJson, recordedRequest, TAXON } from "../__fixtures__/liveEvents";

const NOW = new Date("2026-11-18T12:00:00Z");
const noSleep = async () => undefined;
const histogram = (name: string) => parseHistogram(fixtureJson(`events/${name}`))!;
const phen = (id: string) => PHENOMENA.find((p) => p.id === id)!;

let cities: City[];
let TMP: string;
beforeAll(() => {
  loadCities();
  cities = getCities();
});
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-inat-"));
  process.env.DATA_DIR = TMP;
  resetLiveEventsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  resetLiveEventsForTests();
  vi.restoreAllMocks();
});

describe("phenomenon definitions", () => {
  it("are definitions of what to look up, not events: no dates, months or places", () => {
    expect(PHENOMENA.map((p) => p.id)).toEqual(["cherry-blossom", "jacaranda", "lavender", "tulips", "bluebells", "humpback-whales", "grey-whales", "sea-turtles", "monarch-butterflies", "fireflies", "wildebeest"]);
    for (const p of PHENOMENA) {
      expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(["id", "title", "taxonNames", "tags", "minObservations"]));
      expect(p.taxonNames.length).toBeGreaterThan(0);
    }
    expect(phen("sea-turtles").taxonNames).toEqual(["Chelonia mydas", "Caretta caretta"]);
    expect(phen("jacaranda").annotation).toEqual({ termId: 12, termValueId: 13 });
    expect(phen("humpback-whales").annotation).toBeUndefined();
  });
});

describe("histogram and taxon parsing (recorded iNaturalist answers)", () => {
  it("reads Prunus serrulata flowering near Tokyo: March 11, April 15", () => {
    const c = histogram("inat-histogram-prunus-tokyo.json");
    expect(c).toEqual([0, 0, 11, 15, 0, 0, 0, 0, 0, 1, 0, 0]);
    expect(peakMonths(c)).toEqual([3, 4]);
  });

  it("finds the humpback whale season off Sydney: June and July", () => {
    const c = histogram("inat-histogram-humpback-sydney.json");
    expect(c.reduce((a, b) => a + b, 0)).toBe(599);
    expect(peakMonths(c)).toEqual([6, 7]);
  });

  it("reads a body that is not a histogram as undefined", () => {
    expect(parseHistogram({ results: {} })).toBeUndefined();
    expect(parseHistogram({ results: { month_of_year: { "1": -3 } } })).toBeUndefined();
    expect(parseHistogram(null)).toBeUndefined();
  });

  it("picks the exact name with the most observations, not the first result", () => {
    expect(parseTaxon(fixtureJson("events/inat-taxa-jacaranda.json"), "Jacaranda mimosifolia")).toBe(TAXON.jacaranda);
    // The recorded answer for "Caretta caretta" lists Chelonia mydas first.
    expect(parseTaxon(fixtureJson("events/inat-taxa-caretta.json"), "Caretta caretta")).toBe(TAXON.caretta);
    expect(parseTaxon(fixtureJson("events/inat-taxa-prunus-serrulata.json"), "Prunus serrulata")).toBe(TAXON.prunus);
    expect(parseTaxon({ results: [] }, "x")).toBeNull();
    expect(parseTaxon(null, "x")).toBeNull();
  });

  it("builds the histogram request with the radius, the month interval and the flowering annotation", () => {
    const u = new URL(histogramUrl([TAXON.prunus], phen("cherry-blossom"), 35.68, 139.69));
    expect(u.origin + u.pathname).toBe("https://api.inaturalist.org/v1/observations/histogram");
    expect(Object.fromEntries(u.searchParams)).toEqual({ taxon_id: "125742", lat: "35.6800", lng: "139.6900", radius: "50", interval: "month_of_year", verifiable: "true", term_id: "12", term_value_id: "13" });
    const whales = new URL(histogramUrl([TAXON.humpback], phen("humpback-whales"), 1, 2));
    expect(whales.searchParams.has("term_id")).toBe(false);
    const turtles = new URL(histogramUrl([TAXON.chelonia, TAXON.caretta], phen("sea-turtles"), 1, 2));
    expect(turtles.searchParams.get("taxon_id")).toBe("39659,39665");
    expect(observationsUrl([TAXON.prunus], phen("cherry-blossom"), 1, 2).startsWith("https://www.inaturalist.org/observations?")).toBe(true);
  });
});

describe("peak months", () => {
  it("takes the run of months holding at least 15% of the year around the busiest month", () => {
    expect(peakMonths([0, 0, 0, 0, 0, 20, 30, 7, 0, 0, 0, 0])).toEqual([6, 7]);
    // 10/60 is 16.7%, so August joins; 5/60 is 8%, so September does not.
    expect(peakMonths([0, 0, 0, 0, 0, 20, 25, 10, 5, 0, 0, 0])).toEqual([6, 7, 8]);
  });

  it("does not join a second, separate burst to the main run", () => {
    expect(peakMonths([20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30])).toEqual([11, 12, 1].filter((m) => m === 12 || m === 1));
    expect(peakMonths([0, 0, 40, 0, 0, 0, 0, 0, 0, 20, 0, 0])).toEqual([3]);
  });

  it("runs across the new year, starting at the first month of the run", () => {
    expect(peakMonths([10, 5, 0, 0, 0, 0, 0, 0, 0, 0, 20, 25])).toEqual([11, 12, 1]);
  });

  it("finds no season in a flat year or an empty one", () => {
    expect(peakMonths(new Array(12).fill(10))).toEqual([]);
    expect(peakMonths(new Array(12).fill(0))).toEqual([]);
    expect(peakMonths([1, 2, 3])).toEqual([]);
  });
});

describe("which checks are due", () => {
  const byId = (id: string) => cities.find((c) => c.id === id)!;

  it("lists never-checked pairs first in place rank and phenomenon order, and skips places outside a latitude band", () => {
    const { tasks } = dueChecks([byId("sydney-australia"), byId("lisbon-portugal")], emptyInatState(), NOW);
    const first = tasks[0]!;
    expect(first.city.id).toBe("sydney-australia");
    // Sydney at -34 is outside the cherry blossom (20 to 65) and lavender bands, inside the jacaranda one.
    expect(tasks.filter((t) => t.city.id === "sydney-australia").map((t) => t.phenomenon.id)).toEqual(expect.arrayContaining(["jacaranda", "humpback-whales"]));
    expect(tasks.some((t) => t.city.id === "sydney-australia" && t.phenomenon.id === "cherry-blossom")).toBe(false);
    expect(tasks.some((t) => t.city.id === "lisbon-portugal" && t.phenomenon.id === "wildebeest")).toBe(false);
  });

  it("leaves cherry blossom in Japan to the JMA source", () => {
    expect(dueChecks([byId("tokyo-japan")], emptyInatState(), NOW).tasks.some((t) => t.phenomenon.id === "cherry-blossom")).toBe(false);
  });

  it("keeps a check for 30 days, then puts it back, oldest first", () => {
    const state: InatState = emptyInatState();
    const day = 86_400_000;
    state.checks["lisbon-portugal|jacaranda"] = { at: new Date(NOW.getTime() - 10 * day).toISOString(), counts: new Array(12).fill(0), total: 0 };
    state.checks["lisbon-portugal|tulips"] = { at: new Date(NOW.getTime() - 31 * day).toISOString(), counts: new Array(12).fill(0), total: 0 };
    state.checks["lisbon-portugal|lavender"] = { at: new Date(NOW.getTime() - 45 * day).toISOString(), counts: new Array(12).fill(0), total: 0 };
    const { tasks } = dueChecks([byId("lisbon-portugal")], state, NOW);
    expect(tasks.some((t) => t.key === "lisbon-portugal|jacaranda")).toBe(false);
    // Never-checked pairs (empty timestamp) sort before checked ones, and the oldest check before the newer.
    const ids = tasks.map((t) => t.key);
    expect(ids.indexOf("lisbon-portugal|lavender")).toBeLessThan(ids.indexOf("lisbon-portugal|tulips"));
    expect(tasks[0]!.checkedAt).toBe("");
    expect(RECHECK_MS).toBe(30 * day);
  });

  it("skips a phenomenon in a country where it has come back empty twice", () => {
    const state = emptyInatState();
    state.zeroCountries["wildebeest|portugal"] = { n: 2, at: NOW.toISOString() };
    const africa: City = { id: "x-portugal", name: "X", country: "Portugal", lat: -5, lng: 30, population: 1 };
    const r = dueChecks([africa], state, NOW);
    expect(r.tasks.some((t) => t.phenomenon.id === "wildebeest")).toBe(false);
    expect(r.skippedZero).toBe(1);
    // An old zero record no longer skips.
    state.zeroCountries["wildebeest|portugal"] = { n: 2, at: new Date(NOW.getTime() - 40 * 86_400_000).toISOString() };
    expect(dueChecks([africa], state, NOW).tasks.some((t) => t.phenomenon.id === "wildebeest")).toBe(true);
  });
});

describe("events from stored checks", () => {
  it("makes one event per place and phenomenon with enough observations and a season", () => {
    const map = new Map(getCities().map((c) => [c.id, c]));
    const state: InatState = emptyInatState();
    state.taxa["Megaptera novaeangliae"] = { id: TAXON.humpback, resolvedAt: NOW.toISOString() };
    state.checks["sydney-australia|humpback-whales"] = { at: NOW.toISOString(), counts: histogram("inat-histogram-humpback-sydney.json"), total: 599 };
    state.checks["paris-france|jacaranda"] = { at: NOW.toISOString(), counts: new Array(12).fill(0), total: 0 };
    state.checks["lisbon-portugal|tulips"] = { at: NOW.toISOString(), counts: [0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0], total: 6 };
    state.checks["lisbon-portugal|lavender"] = { at: NOW.toISOString(), counts: new Array(12).fill(2), total: 24 };
    const events = eventsFromChecks(state, map);
    expect(events.map((e) => e.id)).toEqual(["inat-humpback-whales-sydney-australia"]);
    const e = events[0]!;
    expect(e).toMatchObject({ title: "Humpback whale season", kind: "nature", cityIds: ["sydney-australia"], month: 6, months: [6, 7], recurring: true, source: "inaturalist", feed: "inaturalist" });
    expect(e.tags).toEqual(["whales", "humpback-whales", "wildlife", "nature"]);
    expect(e.note).toContain("Jun to Jul");
    expect(e.note).toContain("599 verifiable iNaturalist observations");
    expect(e.sourceUrl).toContain("taxon_id=41566");
  });

  it("ignores checks for a place or phenomenon that no longer exists", () => {
    const state = emptyInatState();
    state.checks["atlantis|jacaranda"] = { at: NOW.toISOString(), counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0], total: 20 };
    state.checks["sydney-australia|retired"] = { at: NOW.toISOString(), counts: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], total: 20 };
    expect(eventsFromChecks(state, new Map(getCities().map((c) => [c.id, c])))).toEqual([]);
  });
});

describe("the rolling source", () => {
  const places = (ids: string[]) => ({ ownerCityIds: async () => ids, busiestCityIds: () => [] as string[] });
  const base = { now: NOW, sleep: noSleep, pauseMs: 0, hostPauseMs: 0 };
  const OWNER = ["sydney-australia", "pretoria-south-africa", "paris-france", "washington-united-states"];

  it("runs at most the check budget, saves after each check, and finds the recorded seasons", async () => {
    const w = fakeNetwork(recordedRequest);
    const file = await refreshLiveEvents({ ...base, fetch: w.fetch, places: places(OWNER), maxChecks: 10 });
    const inat = file.sources.find((s) => s.id === "inaturalist")!;
    expect(inat).toMatchObject({ ok: true });
    expect(inat.detail).toMatchObject({ ranThisRun: 10, checked: 10, owners: 4 });
    const state = file.state!["inaturalist"] as InatState;
    expect(Object.keys(state.checks)).toHaveLength(10);
    // Sydney is first in rank: its checks (jacaranda, humpback whales, grey whales, sea turtles, monarchs, fireflies) run before Pretoria's.
    expect(Object.keys(state.checks).slice(0, 5).every((k) => k.startsWith("sydney-australia"))).toBe(true);
    expect(file.events.filter((e) => e.feed === "inaturalist").map((e) => e.id)).toContain("inat-humpback-whales-sydney-australia");
  });

  it("resolves each taxon once and keeps it in the store", async () => {
    const w = fakeNetwork(recordedRequest);
    await refreshLiveEvents({ ...base, fetch: w.fetch, places: places(OWNER), maxChecks: 40 });
    const taxaCalls = w.calls.filter((c) => c.url.includes("/taxa?"));
    const names = taxaCalls.map((c) => new URL(c.url).searchParams.get("q"));
    expect(new Set(names).size).toBe(names.length);
    const second = fakeNetwork(recordedRequest);
    await refreshLiveEvents({ ...base, now: new Date(NOW.getTime() + 2 * 3_600_000), fetch: second.fetch, places: places(OWNER), maxChecks: 5 });
    expect(second.calls.filter((c) => c.url.includes("/taxa?"))).toHaveLength(0);
  });

  it("paces its requests with the host pause", async () => {
    const sleeps: number[] = [];
    const w = fakeNetwork(recordedRequest);
    await refreshLiveEvents({ ...base, hostPauseMs: 1000, sleep: async (ms) => void sleeps.push(ms), fetch: w.fetch, places: places(["sydney-australia"]), maxChecks: 3 });
    const inatCalls = w.calls.filter((c) => c.host === "api.inaturalist.org").length;
    expect(inatCalls).toBeGreaterThan(3);
    expect(sleeps.filter((ms) => ms === 1000)).toHaveLength(inatCalls - 1);
  });

  it("continues where it stopped: the next run checks the pairs the first did not, then nothing until 30 days pass", async () => {
    const ids = ["sydney-australia", "pretoria-south-africa"];
    const w1 = fakeNetwork(recordedRequest);
    await refreshLiveEvents({ ...base, fetch: w1.fetch, places: places(ids), maxChecks: 6 });
    const w2 = fakeNetwork(recordedRequest);
    const f2 = await refreshLiveEvents({ ...base, now: new Date(NOW.getTime() + 3_600_000), fetch: w2.fetch, places: places(ids), maxChecks: 100 });
    const state = f2.state!["inaturalist"] as InatState;
    // Sydney: jacaranda, humpback, grey whales, sea turtles, monarch, fireflies. Pretoria: jacaranda, humpback, grey, turtles, monarch, fireflies, wildebeest.
    expect(Object.keys(state.checks).length).toBeGreaterThanOrEqual(12);
    const w3 = fakeNetwork(recordedRequest);
    const f3 = await refreshLiveEvents({ ...base, now: new Date(NOW.getTime() + 2 * 3_600_000), fetch: w3.fetch, places: places(ids), maxChecks: 100 });
    expect(w3.calls.filter((c) => c.host === "api.inaturalist.org")).toHaveLength(0);
    expect(f3.sources.find((s) => s.id === "inaturalist")!.detail).toMatchObject({ ranThisRun: 0, due: 0 });
    // 31 days later every check is due again, oldest first.
    const w4 = fakeNetwork(recordedRequest);
    const f4 = await refreshLiveEvents({ ...base, now: new Date(NOW.getTime() + 31 * 86_400_000), fetch: w4.fetch, places: places(ids), maxChecks: 4 });
    expect(f4.sources.find((s) => s.id === "inaturalist")!.detail).toMatchObject({ ranThisRun: 4 });
    // The oldest checks go first: the ones the first run made.
    const first = Object.entries((f3.state!["inaturalist"] as InatState).checks).sort((a, b) => a[1].at.localeCompare(b[1].at))[0]!;
    expect((f4.state!["inaturalist"] as InatState).checks[first[0]]!.at).toBe(new Date(NOW.getTime() + 31 * 86_400_000).toISOString());
  });

  it("stops at the soft deadline instead of the check budget", async () => {
    const w = fakeNetwork(recordedRequest);
    const realNow = Date.now;
    let t = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 400));
    try {
      await refreshLiveEvents({ ...base, fetch: w.fetch, places: places(OWNER), maxChecks: 100, budgetMs: 12_000, concurrency: 1 });
    } finally {
      spy.mockRestore();
    }
    const checks = w.calls.filter((c) => c.url.includes("/histogram")).length;
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThan(10);
  });

  it("skips a phenomenon in a country after two empty checks there", async () => {
    // Two Australian places, none with recorded wildebeest answers (all empty): the third is skipped for it.
    const aus = getCities().filter((c) => c.country === "Australia" && c.iata).slice(0, 4).map((c) => c.id);
    const w = fakeNetwork(recordedRequest);
    const f = await refreshLiveEvents({ ...base, fetch: w.fetch, places: places(aus), maxChecks: 200 });
    const state = f.state!["inaturalist"] as InatState;
    const jac = Object.keys(state.checks).filter((k) => k.endsWith("|jacaranda"));
    expect(jac.length).toBeLessThan(aus.length);
    expect((f.sources.find((s) => s.id === "inaturalist")!.detail as Record<string, number>).skippedZeroCountry).toBeGreaterThan(0);
  });

  it("keeps what it saved and records the error when iNaturalist answers 429", async () => {
    let histograms = 0;
    const w = fakeNetwork((req) => {
      if (req.url.includes("/histogram") && ++histograms === 3) return { status: 429, headers: { "retry-after": "60" } };
      return recordedRequest(req);
    });
    const file = await refreshLiveEvents({ ...base, fetch: w.fetch, places: places(OWNER), maxChecks: 20 });
    const inat = file.sources.find((s) => s.id === "inaturalist")!;
    expect(inat.ok).toBe(false);
    const done = Number(/stopped after (\d+) checks \(429\)/.exec(inat.error ?? "")?.[1]);
    expect(done).toBeGreaterThan(0);
    // Every check before the 429 was saved; none after it.
    expect(Object.keys((file.state!["inaturalist"] as InatState).checks)).toHaveLength(done);
    expect(w.calls.filter((c) => c.url.includes("/histogram"))).toHaveLength(3);
    expect((await liveEventsStatus()).sources.find((s) => s.id === "inaturalist")!.ok).toBe(false);
  });

  it("checks only the owner's places and the busiest cities, each once", async () => {
    const w = fakeNetwork(recordedRequest);
    const f = await refreshLiveEvents({ ...base, fetch: w.fetch, places: { ownerCityIds: async () => ["sydney-australia", "nowhere-land"], busiestCityIds: (n) => (n === 150 ? ["sydney-australia", "pretoria-south-africa"] : []) }, maxChecks: 100 });
    expect(f.sources.find((s) => s.id === "inaturalist")!.detail).toMatchObject({ places: 2, owners: 2 });
  });

  it("survives a failing owner lookup", async () => {
    const w = fakeNetwork(recordedRequest);
    const f = await refreshLiveEvents({
      ...base,
      fetch: w.fetch,
      places: {
        ownerCityIds: async () => {
          throw new Error("store down");
        },
        busiestCityIds: () => ["sydney-australia"],
      },
      maxChecks: 3,
    });
    expect(f.sources.find((s) => s.id === "inaturalist")).toMatchObject({ ok: true });
  });
});
