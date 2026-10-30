import { describe, it, expect, beforeAll } from "vitest";
import {
  runReplay,
  applyBend,
  monthDistance,
  representativeDate,
  scoreDims,
  priceSimilarity,
  ReplayError,
  type ReplayDeps,
} from "./replay";
import { computeFingerprint } from "./fingerprint";
import { buildHolidayIndex } from "./crowd";
import { fixtureFingerprintDeps, lisbonJourney, getCity, SEASONALITY, HOLIDAYS_2024, NOW } from "./__fixtures__/journal";
import type { FlightEstimateResult, Journey, ReplayQuery, ReplayResult } from "../../src/types";

let lisbon: Journey;

beforeAll(async () => {
  lisbon = (await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps().deps)).journey;
});

function deps(over: Partial<ReplayDeps> = {}): ReplayDeps & { flightCalls: string[] } {
  const flightCalls: string[] = [];
  return {
    journeys: [lisbon],
    settings: { homeCityId: "berlin-germany" },
    seasonality: SEASONALITY,
    getCity,
    flightEstimate: async (p) => {
      flightCalls.push(`${p.originIata}-${p.destinationIata}-${p.departureDate}`);
      return { priceAmount: 100, currency: "EUR", source: "mock" } satisfies FlightEstimateResult;
    },
    eurOf: (amount) => amount,
    now: () => NOW,
    holidayIndex: buildHolidayIndex({ 2024: HOLIDAYS_2024 }),
    flightCalls,
    ...over,
  };
}

const W = { climate: 1, spend: 0.5, crowd: 0.5, flight: 0.5 };
const q = (over: Partial<ReplayQuery> = {}): ReplayQuery => ({
  template: { journeyId: "j-lisbon-2024" },
  bend: {},
  weights: W,
  limit: 60,
  ...over,
});
const pos = (rs: ReplayResult[], cityId: string, month: number) => rs.findIndex((r) => r.cityId === cityId && r.month === month);

describe("primitives", () => {
  it("month distance is circular", () => {
    expect(monthDistance(12, 1)).toBe(1);
    expect(monthDistance(1, 7)).toBe(6);
    expect(monthDistance(3, 3)).toBe(0);
  });
  it("bend shifts month circularly, null drops it, temp re-scores comfort", () => {
    expect(applyBend({ month: 11 }, { monthShift: 3 }).month).toBe(2);
    expect(applyBend({ month: 2 }, { monthShift: -3 }).month).toBe(11);
    expect("month" in applyBend({ month: 5 }, { monthShift: null })).toBe(false);
    const t = applyBend({ tempC: 30, precipMm: 10, comfort: 71, dailySpendEur: 100, crowdProxy: 90 }, { tempC: -8, spendPct: -50, crowd: 30 });
    expect(t).toMatchObject({ tempC: 22, comfort: 100, dailySpendEur: 50, crowdProxy: 100 });
  });
  it("representative date is the 15th of the next occurrence after now", () => {
    expect(representativeDate(11, NOW)).toBe("2026-11-15");
    expect(representativeDate(10, NOW)).toBe("2027-10-15");
    expect(representativeDate(5, NOW)).toBe("2027-05-15");
  });
  it("price similarity: cheaper caps at 1, 2x baseline → 0", () => {
    expect(priceSimilarity(50, 100)).toBe(1);
    expect(priceSimilarity(150, 100)).toBe(0.5);
    expect(priceSimilarity(250, 100)).toBe(0);
  });
  it("renormalizes weights over present dims and reports contributions", () => {
    const s = scoreDims([
      { name: "tempC", value: 20, templateValue: 20, similarity: 1, weight: 0.25 },
      { name: "crowdProxy", value: 0, templateValue: 50, similarity: 0, weight: 0.25 },
      { name: "dailySpendEur", value: 1, templateValue: 1, similarity: 1, weight: 0 },
    ]);
    expect(s.match).toBe(50);
    expect(s.scoredOn).toEqual(["tempC", "crowdProxy"]);
    expect(s.dims.reduce((a, d) => a + d.contribution, 0)).toBeCloseTo(1);
  });
});

describe("runReplay", () => {
  it("reports universe size and the bent template; an identical cell scores 100", async () => {
    const r = await runReplay(q({ template: { fingerprint: { month: 5, tempC: 18.5, precipMm: 45 } } }), deps());
    expect(r.universeSize).toBe(Object.keys(SEASONALITY).length);
    expect(r.fromCityId).toBe("berlin-germany");
    expect(r.results[0]).toMatchObject({ cityId: "lisbon-portugal", month: 5, match: 100 });
  });

  it("drops missing dims and renormalizes: a temp-only template scores on tempC alone", async () => {
    const r = await runReplay(q({ template: { fingerprint: { tempC: 22 } } }), deps());
    for (const res of r.results) {
      expect(res.scoredOn).toEqual(["tempC"]);
      expect(res.dims[0]!.contribution).toBe(1);
    }
  });

  it("bend tempC +3 moves a warmer city up", async () => {
    const before = (await runReplay(q(), deps())).results;
    const after = (await runReplay(q({ bend: { tempC: 3 } }), deps())).results;
    expect(pos(before, "porto-portugal", 5)).toBeLessThan(pos(before, "seville-spain", 5));
    expect(pos(after, "seville-spain", 5)).toBeLessThan(pos(after, "porto-portugal", 5));
    expect(pos(after, "seville-spain", 5)).toBeLessThan(pos(before, "seville-spain", 5));
  });

  it("monthShift null matches any month (month dim dropped)", async () => {
    const r = await runReplay(q({ bend: { monthShift: null } }), deps());
    expect(r.template.month).toBeUndefined();
    expect(r.results.every((x) => !x.scoredOn.includes("month"))).toBe(true);
    expect(new Set(r.results.map((x) => x.month)).size).toBeGreaterThan(3);
  });

  it("respects constraints.months", async () => {
    const r = await runReplay(q({ constraints: { months: [3, 4, 5] } }), deps());
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((x) => [3, 4, 5].includes(x.month))).toBe(true);
  });

  it("excludeVisited drops cities from confirmed journeys; otherwise flags visitedBefore", async () => {
    const all = await runReplay(q(), deps());
    expect(all.results.find((x) => x.cityId === "lisbon-portugal")?.visitedBefore).toBe(true);
    const ex = await runReplay(q({ constraints: { excludeVisited: true } }), deps());
    expect(ex.results.some((x) => x.cityId === "lisbon-portugal")).toBe(false);
  });

  it("filters by region and max flight hours; never suggests the origin", async () => {
    const eu = await runReplay(q({ constraints: { regions: ["europe"] } }), deps());
    expect(eu.results.some((x) => x.cityId === "bangkok-thailand" || x.cityId === "oslo-norway")).toBe(false);
    const near = await runReplay(q({ bend: { monthShift: null }, constraints: { maxFlightHours: 4 } }), deps());
    expect(near.results.some((x) => x.cityId === "bangkok-thailand")).toBe(false);
    expect(near.results.some((x) => x.cityId === "berlin-germany")).toBe(false);
  });

  it("attaches mock prices but excludes them from the flight dim", async () => {
    const d = deps();
    const r = await runReplay(q(), d);
    const priced = r.results.filter((x) => x.price);
    expect(priced.length).toBeGreaterThan(0);
    expect(d.flightCalls.length).toBeLessThanOrEqual(20);
    for (const p of priced) {
      expect(p.price!.source).toBe("mock");
      expect(p.scoredOn).not.toContain("flightCostEurPer1000km");
    }
  });

  it("scores real prices against the user's median baseline", async () => {
    const d = deps({ flightEstimate: async () => ({ priceAmount: 50, currency: "EUR", source: "serpapi" }) });
    const r = await runReplay(q(), d);
    const p = r.results.find((x) => x.price && x.price.source === "serpapi")!;
    expect(p.scoredOn).toContain("flightCostEurPer1000km");
    expect(p.price!.baselineEur).toBe(Math.round((lisbon.fingerprint!.flightCostEurPer1000km! * p.price!.distanceKm!) / 1000));
    expect(p.price!.priceEur).toBe(50);
  });

  it("falls back to dealRating when there is no baseline", async () => {
    const noFlights: Journey = { ...lisbon, fingerprint: { ...lisbon.fingerprint!, flightCostEurPer1000km: undefined } };
    const d = deps({ journeys: [noFlights], flightEstimate: async () => ({ priceAmount: 90, currency: "EUR", source: "serpapi", dealRating: "high" }) });
    const r = await runReplay(q(), d);
    const p = r.results.find((x) => x.price)!;
    expect(p.price!.baselineEur).toBeUndefined();
    const flight = p.dims.find((x) => x.name === "flightCostEurPer1000km");
    expect(flight).toBeDefined();
  });

  it("skips pricing without IATA on both ends", async () => {
    const d = deps({ settings: { homeCityId: "nowhere-land" } });
    const r = await runReplay(q(), d);
    expect(d.flightCalls).toHaveLength(0);
    expect(r.results.every((x) => !x.price)).toBe(true);
  });

  it("scores spend from the user's own city/country history only", async () => {
    const r = await runReplay(q({ weights: { climate: 1, spend: 1, crowd: 0, flight: 0 } }), deps());
    const porto = r.results.find((x) => x.cityId === "porto-portugal")!;
    expect(porto.scoredOn).toContain("dailySpendEur"); // same country as the Lisbon journey
    const athens = r.results.find((x) => x.cityId === "athens-greece");
    if (athens) expect(athens.scoredOn).not.toContain("dailySpendEur");
  });

  it("attaches events by city+month and filters by event tag", async () => {
    const events = [{ id: "e1", title: "Festa", kind: "festival" as const, cityIds: ["porto-portugal"], month: 6, recurring: true, tags: ["sao-joao"] }];
    const r = await runReplay(q({ constraints: { tags: ["sao-joao"] } }), deps({ events }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ cityId: "porto-portugal", month: 6 });
    expect(r.results[0]!.events?.[0]!.id).toBe("e1");
  });

  it("restricts the universe to constraints.cityIds", async () => {
    const r = await runReplay(q({ bend: { monthShift: null }, constraints: { cityIds: ["porto-portugal", "athens-greece"] } }), deps());
    expect(new Set(r.results.map((x) => x.cityId))).toEqual(new Set(["porto-portugal", "athens-greece"]));
  });

  it("returns a dense 12-month stage-1 grid row per result city, even outside constraints.months", async () => {
    const r = await runReplay(q({ constraints: { months: [5] } }), deps());
    const cityIds = [...new Set(r.results.map((x) => x.cityId))];
    expect(r.grid!.map((g) => g.cityId)).toEqual(cityIds);
    for (const row of r.grid!) {
      expect(row.months).toHaveLength(12);
      expect(row.months.every((m) => typeof m === "number" && m >= 0 && m <= 100)).toBe(true);
    }
    const lis = r.grid!.find((g) => g.cityId === "lisbon-portugal")!;
    expect(lis.months[4]).toBeGreaterThan(lis.months[0]!);
  });

  it("applies the default limit of 30", async () => {
    const r = await runReplay({ ...q(), limit: undefined }, deps());
    expect(r.results).toHaveLength(30);
  });

  it("throws typed errors for a missing template", async () => {
    await expect(runReplay(q({ template: { journeyId: "nope" } }), deps())).rejects.toBeInstanceOf(ReplayError);
    await expect(runReplay(q({ template: { journeyId: "j-lisbon-2024", stopIndex: 4 } }), deps())).rejects.toMatchObject({ code: "template_not_found" });
  });
});
