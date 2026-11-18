import { describe, it, expect, afterEach, vi } from "vitest";
import type { City } from "../../../src/types";
import { getCities, loadCities } from "../cities";
import { cityIndexFor, type SourceContext, type SourceResult } from "./common";
import { emptyInatState, dueChecks, eventsFromChecks, inaturalistSource, orderCities, readInatState, RECHECK_MS, REQUESTS_PER_CITY, speciesCountsUrl, type InatState } from "./inaturalist";
import { expandHighlight, type StoredHighlight } from "./highlights";
import { fakeNetwork, INAT_FIXTURE_CITIES, recordedRequest } from "../__fixtures__/liveEvents";

const NOW = new Date("2026-11-18T12:00:00Z");
loadCities();
const cities: City[] = getCities();
afterEach(() => vi.restoreAllMocks());

const city = (id: string) => cities.find((c) => c.id === id)!;
/** A stored highlight with `total` observations in March and April. */
const hl = (t: number, over: { total?: number; i?: string } = {}): StoredHighlight => ({ t, c: `Species ${t}`, i: over.i ?? "Plantae", m: [0, 0, (over.total ?? 60) / 2, (over.total ?? 60) / 2, 0, 0, 0, 0, 0, 0, 0, 0] });

describe("the species_counts request", () => {
  it("asks for a month at a time, within 30 km, plants of every grade (planted trees and gardens count)", () => {
    const u = new URL(speciesCountsUrl("plant", 35.68, 139.69, 3));
    expect(u.origin + u.pathname).toBe("https://api.inaturalist.org/v1/observations/species_counts");
    expect(Object.fromEntries(u.searchParams)).toEqual({ lat: "35.6800", lng: "139.6900", radius: "30", per_page: "100", month: "3", iconic_taxa: "Plantae", quality_grade: "any" });
  });

  it("asks for conspicuous animals by iconic taxon, verifiable observations only", () => {
    const u = new URL(speciesCountsUrl("animal", -33.87, 151.21, 12));
    expect(u.searchParams.get("iconic_taxa")).toBe("Aves,Mammalia,Insecta,Reptilia,Amphibia,Actinopterygii,Mollusca");
    expect(u.searchParams.get("verifiable")).toBe("true");
    expect(u.searchParams.has("quality_grade")).toBe(false);
    expect(u.searchParams.get("per_page")).toBe("150");
    expect(u.searchParams.get("month")).toBe("12");
  });
});

describe("stored state", () => {
  it("starts empty, and drops the state of the earlier phenomenon-list version", () => {
    expect(readInatState(undefined)).toEqual(emptyInatState());
    const old = { taxa: { "Prunus serrulata": { id: 125742, resolvedAt: "2026-11-01T00:00:00Z" } }, checks: { "kyoto-japan|cherry-blossom": { at: "2026-11-01T00:00:00Z", counts: new Array(12).fill(1), total: 12 } }, zeroCountries: {} };
    expect(readInatState(old)).toEqual(emptyInatState());
  });
  it("keeps a state of the current version", () => {
    const s: InatState = { version: 2, checks: { "x-y": { at: "2026-11-01T00:00:00.000Z", highlights: [hl(1)] } } };
    expect(readInatState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("coverage order", () => {
  it("lists the owner's places, then the cities by attention, then the other airport cities by population, each once", () => {
    const ordered = orderCities(cities, ["kyoto-japan", "no-such-city", "tokyo-japan"], ["lisbon-portugal", "tokyo-japan", "reykjav-k-iceland"]);
    expect(ordered.slice(0, 5).map((c) => c.id)).toEqual(["kyoto-japan", "tokyo-japan", "lisbon-portugal", "reykjav-k-iceland", expect.any(String)]);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(ordered.length);
    const rest = ordered.slice(4);
    expect(rest.every((c) => c.iata)).toBe(true);
    const pops = rest.map((c) => c.population);
    expect(pops).toEqual([...pops].sort((a, b) => b - a));
  });

  it("includes an owner's place or a city with attention that has no airport", () => {
    const noAirport = cities.find((c) => !c.iata)!;
    expect(orderCities(cities, [noAirport.id], []).map((c) => c.id)).toContain(noAirport.id);
    expect(orderCities(cities, [], [noAirport.id])[0]!.id).toBe(noAirport.id);
  });

  it("leaves a city that has no airport and no attention out", () => {
    const noAirport = cities.find((c) => !c.iata)!;
    expect(orderCities(cities, [], []).some((c) => c.id === noAirport.id)).toBe(false);
  });
});

describe("what is due", () => {
  const order = ["tokyo-japan", "kyoto-japan", "lisbon-portugal", "pretoria-south-africa"].map(city);
  const checked = (id: string, daysAgo: number): [string, { at: string; highlights: StoredHighlight[] }] => [id, { at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), highlights: [] }];

  it("makes every city due when nothing is stored, in the given order", () => {
    expect(dueChecks(order, emptyInatState(), NOW).map((t) => t.city.id)).toEqual(order.map((c) => c.id));
  });

  it("re-checks a city after 60 days, not before", () => {
    const state: InatState = { version: 2, checks: Object.fromEntries([checked("tokyo-japan", 59), checked("kyoto-japan", 61)]) };
    expect(RECHECK_MS).toBe(60 * 86_400_000);
    expect(dueChecks(order, state, NOW).map((t) => t.city.id)).toEqual(["lisbon-portugal", "pretoria-south-africa", "kyoto-japan"]);
  });

  it("puts never-checked cities before the oldest re-checks, and the oldest re-check first", () => {
    const state: InatState = { version: 2, checks: Object.fromEntries([checked("tokyo-japan", 90), checked("kyoto-japan", 120)]) };
    expect(dueChecks(order, state, NOW).map((t) => t.city.id)).toEqual(["lisbon-portugal", "pretoria-south-africa", "kyoto-japan", "tokyo-japan"]);
  });
});

describe("events from stored checks", () => {
  const tokyo = city("tokyo-japan");
  const kyoto = city("kyoto-japan");
  const map = new Map(cities.map((c) => [c.id, c]));

  it("ranks each city's highlights against the tally of all checked cities and keeps three", () => {
    const shared = hl(1, { total: 500 });
    const state: InatState = {
      version: 2,
      checks: {
        [tokyo.id]: { at: NOW.toISOString(), highlights: [shared, hl(2, { total: 100 }), hl(3, { total: 90 }), hl(4, { total: 80 }), hl(5, { total: 70 })] },
        [kyoto.id]: { at: NOW.toISOString(), highlights: [shared] },
      },
    };
    const ev = eventsFromChecks(state, map);
    const inTokyo = ev.filter((e) => e.cityIds[0] === tokyo.id).map((e) => e.id);
    expect(inTokyo).toHaveLength(3);
    // Species 1 is a highlight in both cities, so its inverse-frequency factor is lower; 500 x ln(1+1) still beats 100 x ln(1+2).
    expect(inTokyo).toContain(`inat-1-${tokyo.id}`);
    expect(ev.filter((e) => e.cityIds[0] === kyoto.id).map((e) => e.id)).toEqual([`inat-1-${kyoto.id}`]);
  });

  it("drops a species that is a highlight in more than 15% of 40 checked cities", () => {
    const common = hl(9, { total: 900 });
    const checks: InatState["checks"] = {};
    cities.slice(0, 40).forEach((c, i) => (checks[c.id] = { at: NOW.toISOString(), highlights: i < 7 ? [common, hl(100 + i, { total: 50 })] : [hl(100 + i, { total: 50 })] }));
    const ev = eventsFromChecks({ version: 2, checks }, map);
    expect(ev.some((e) => e.id.startsWith("inat-9-"))).toBe(false);
    expect(ev).toHaveLength(40);
  });

  it("skips a stored city the dataset no longer has", () => {
    expect(eventsFromChecks({ version: 2, checks: { gone: { at: NOW.toISOString(), highlights: [hl(1)] } } }, map)).toEqual([]);
  });
});

// The source run, with recorded answers for Kyoto, Honolulu and Sydney.

interface Run {
  result?: SourceResult;
  error?: Error;
  saves: SourceResult[];
  sleeps: number[];
  calls: string[];
}

async function runSource(opts: { owner: string[]; fetch?: ReturnType<typeof fakeNetwork>; maxChecks?: number; prev?: InatState; hostPauseMs?: number; deadline?: number }): Promise<Run> {
  const net = opts.fetch ?? fakeNetwork(recordedRequest);
  const out: Run = { saves: [], sleeps: [], calls: [] };
  const ctx: SourceContext = {
    fetch: net.fetch,
    sleep: async (ms) => void out.sleeps.push(ms),
    now: NOW,
    cities,
    index: cityIndexFor(cities),
    prev: { version: 1, sources: [], events: [], ...(opts.prev ? { state: { inaturalist: opts.prev } } : {}) },
    places: { ownerCityIds: async () => opts.owner, attentionCityIds: () => [] },
    maxChecks: opts.maxChecks ?? opts.owner.length,
    hostPauseMs: opts.hostPauseMs ?? 0,
    ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
    async checkpoint(r) {
      out.saves.push(structuredClone(r));
    },
  };
  try {
    out.result = await inaturalistSource.run(ctx);
  } catch (err) {
    out.error = err as Error;
  }
  out.calls = net.calls.map((c) => c.url);
  return out;
}

describe("the inaturalist source", () => {
  const owner = Object.keys(INAT_FIXTURE_CITIES);

  it("checks a city in 24 requests, twelve months for each of the two kinds, and saves after each city", async () => {
    const r = await runSource({ owner: ["kyoto-japan"] });
    expect(r.error).toBeUndefined();
    expect(r.calls).toHaveLength(REQUESTS_PER_CITY);
    const months = (kind: "Plantae" | "animals") => r.calls.filter((u) => (kind === "Plantae" ? new URL(u).searchParams.get("iconic_taxa") === "Plantae" : new URL(u).searchParams.get("iconic_taxa") !== "Plantae")).map((u) => Number(new URL(u).searchParams.get("month"))).sort((a, b) => a - b);
    expect(months("Plantae")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(months("animals")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.saves).toHaveLength(1);
    expect(r.result!.detail).toMatchObject({ checked: 1, ranThisRun: 1, requests: 24, owners: 1 });
  });

  it("spaces request starts by the host pause", async () => {
    const times: number[] = [];
    const net = fakeNetwork((req) => {
      times.push(Date.now());
      return recordedRequest(req);
    });
    // The fake sleep does not wait, so the clock stands still and each planned start is one pause after the last.
    const r = await runSource({ owner: ["kyoto-japan"], fetch: net, hostPauseMs: 1000 });
    expect(r.sleeps.length).toBe(23);
    const sorted = [...r.sleeps].sort((a, b) => a - b);
    sorted.slice(1).forEach((ms, i) => expect(ms - sorted[i]!).toBeGreaterThanOrEqual(900));
    expect(sorted.at(-1)!).toBeGreaterThanOrEqual(22_000);
  });

  it("finds seasonal species from the recorded answers for each city, with a title, months and numbers", async () => {
    const r = await runSource({ owner });
    expect(r.error).toBeUndefined();
    expect(r.result!.detail).toMatchObject({ checked: 3, ranThisRun: 3, requests: 72 });
    const events = r.result!.events;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toMatchObject({ kind: "nature", recurring: true, source: "inaturalist", feed: "inaturalist" });
      expect(e.id).toMatch(/^inat-\d+-/);
      expect(e.title).toMatch(/ (in bloom|season|migration)$/);
      expect(e.note).toMatch(/iNaturalist observations within 30 km fall in/);
      expect(e.sourceUrl).toMatch(/^https:\/\/www\.inaturalist\.org\/observations\?taxon_id=\d+/);
    }
    for (const id of owner) expect(events.filter((e) => e.cityIds[0] === id).length).toBeLessThanOrEqual(3);
  });

  it("finds the cherry blossom season of Kyoto, Mar to Apr, from the monthly counts and no species name", async () => {
    const r = await runSource({ owner: ["kyoto-japan"] });
    const stored = (r.result!.state as InatState).checks["kyoto-japan"]!.highlights;
    const cherry = stored.map(expandHighlight).find((h) => h?.c === "Japanese Cherry");
    expect(cherry).toMatchObject({ k: "plant", months: [3, 4] });
    expect(cherry!.share).toBeGreaterThan(0.8);
  });

  it("finds the Bogong Moth season of Sydney, Sep to Oct, and titles it from the common name", async () => {
    const r = await runSource({ owner: ["sydney-australia"] });
    const e = r.result!.events.find((x) => x.title === "Bogong Moth season")!;
    expect(e).toMatchObject({ month: 9, months: [9, 10], tags: ["insects", "wildlife", "bogong-moth"], kind: "nature" });
    expect(e.sourceUrl).toContain("month=9%2C10");
  });

  it("stops at maxChecks and reports the cities still pending", async () => {
    const r = await runSource({ owner, maxChecks: 1 });
    expect(r.calls).toHaveLength(24);
    expect(r.result!.detail).toMatchObject({ checked: 1, ranThisRun: 1 });
    expect(Number(r.result!.detail!["pending"])).toBeGreaterThan(5000);
  });

  it("reports no pending cities once every city in the order is checked or fresh", async () => {
    const fresh: InatState = { version: 2, checks: Object.fromEntries(orderCities(cities, owner, []).map((c) => [c.id, { at: NOW.toISOString(), highlights: [] }])) };
    const r = await runSource({ owner, prev: fresh });
    expect(r.calls).toHaveLength(0);
    expect(r.result!.detail).toMatchObject({ pending: 0, ranThisRun: 0 });
  });

  it("does not start a city that cannot finish before the run's limit", async () => {
    const r = await runSource({ owner, hostPauseMs: 1000, deadline: Date.now() + 5_000 });
    expect(r.calls).toHaveLength(0);
    expect(r.result!.detail).toMatchObject({ ranThisRun: 0 });
  });

  it("keeps the cities it saved and throws a short error when iNaturalist stops answering", async () => {
    let n = 0;
    const net = fakeNetwork((req) => {
      n++;
      return n > 24 + 5 ? { status: 429 } : recordedRequest(req);
    });
    const r = await runSource({ owner, fetch: net });
    expect(r.error?.message).toMatch(/iNaturalist stopped after 1 cities \(429\)/);
    // One save after the first city, one more with the error.
    expect(r.saves.length).toBeGreaterThanOrEqual(2);
    expect(r.saves.at(-1)!.detail).toMatchObject({ checked: 1 });
  });

  it("waits out a 429 (Retry-After) and retries the request before giving up", async () => {
    let n = 0;
    const net = fakeNetwork((req) => {
      n++;
      return n === 3 ? { status: 429, headers: { "retry-after": "7" } } : recordedRequest(req);
    });
    const r = await runSource({ owner: ["kyoto-japan"], fetch: net, hostPauseMs: 1000 });
    expect(r.error).toBeUndefined();
    // The third request is repeated: 25 requests for one city.
    expect(r.calls).toHaveLength(25);
  });

  it("gives up after two retries of a request that keeps getting 429", async () => {
    const r = await runSource({ owner: ["kyoto-japan"], fetch: fakeNetwork(() => ({ status: 429, headers: { "retry-after": "1" } })) });
    expect(r.error?.message).toMatch(/\(429\)/);
    // Two workers each try their first request three times.
    expect(r.calls).toHaveLength(6);
  });

  it("never fabricates a species for a place with no observations: an empty answer makes no event", async () => {
    const r = await runSource({ owner: ["lisbon-portugal"] });
    expect(r.error).toBeUndefined();
    expect(r.result!.events).toEqual([]);
    expect((r.result!.state as InatState).checks["lisbon-portugal"]!.highlights).toEqual([]);
  });

  it("rejects a body that is not a species_counts answer", async () => {
    const r = await runSource({ owner: ["kyoto-japan"], fetch: fakeNetwork(() => ({ body: { nope: true } })) });
    expect(r.error?.message).toMatch(/unexpected species_counts body/);
  });
});

