import { beforeAll, describe, expect, it } from "vitest";
import { WEEKS_PER_MONTH, monthOfWeek, weeklyComfortBreakdown } from "../../src/lib/comfort";
import { runReplay, representativeDateOfWeek, templateWeek, thinWeeks, weekDistance, type ReplayDeps } from "./replay";
import { computeFingerprint } from "./fingerprint";
import type { WeekSeasonality } from "./seasonality";
import { buildHolidayIndex } from "./crowd";
import { fixtureFingerprintDeps, lisbonJourney, getCity, SEASONALITY, HOLIDAYS_2024, NOW } from "./__fixtures__/journal";
import type { FlightEstimateResult, Journey, ReplayQuery } from "../../src/types";

let lisbon: Journey;
beforeAll(async () => {
  lisbon = (await computeFingerprint(lisbonJourney(), fixtureFingerprintDeps().deps)).journey;
});

/** Test fixture only: a weekly profile that holds each week at its month's figures, then lets a caller edit weeks. */
function weeklyFromMonths(cityId: string, edit: (w: WeekSeasonality[]) => void = () => undefined): WeekSeasonality[] {
  const weeks: WeekSeasonality[] = Array.from({ length: 52 }, (_, i) => {
    const m = SEASONALITY[cityId]![monthOfWeek(i + 1) - 1]!;
    const precipMm = m.precipMm / WEEKS_PER_MONTH;
    return { tempC: m.tempC, precipMm, score: weeklyComfortBreakdown(m.tempC, precipMm).score };
  });
  edit(weeks);
  return weeks;
}

function deps(over: Partial<ReplayDeps> = {}): ReplayDeps {
  return {
    journeys: [lisbon],
    settings: { homeCityId: "berlin-germany" },
    seasonality: SEASONALITY,
    weekly: {
      "lisbon-portugal": weeklyFromMonths("lisbon-portugal"),
      "seville-spain": weeklyFromMonths("seville-spain"),
      "madrid-spain": weeklyFromMonths("madrid-spain"),
    },
    getCity,
    flightEstimate: async () => ({ priceAmount: 100, currency: "EUR", source: "mock" }) satisfies FlightEstimateResult,
    eurOf: (amount) => amount,
    now: () => NOW,
    holidayIndex: buildHolidayIndex({ 2024: HOLIDAYS_2024 }),
    ...over,
  };
}

const q = (over: Partial<ReplayQuery> = {}): ReplayQuery => ({
  template: { journeyId: "j-lisbon-2024" },
  bend: {},
  weights: { climate: 1, spend: 0, crowd: 0, flight: 0 },
  limit: 100,
  resolution: "week",
  ...over,
});

describe("week primitives", () => {
  it("week distance is circular over 52 weeks", () => {
    expect(weekDistance(1, 52)).toBe(1);
    expect(weekDistance(1, 27)).toBe(26);
    expect(weekDistance(10, 10)).toBe(0);
  });

  it("finds the template's week: its own, else its month's middle, shifted by the bend", () => {
    expect(templateWeek({ weekOfYear: 19 }, {})).toBe(19);
    expect(templateWeek({ weekOfYear: 53 }, {})).toBe(52); // ISO week 53 folds into 52
    expect(templateWeek({ month: 5 }, {})).toBe(20); // 15 May = day 135
    expect(templateWeek({ weekOfYear: 50 }, { monthShift: 1 })).toBe(2); // +4 or 5 weeks wraps over the new year... 50+4=54 -> 2
    expect(templateWeek({ weekOfYear: 3 }, { monthShift: -1 })).toBe(51);
    expect(templateWeek({ weekOfYear: 19 }, { monthShift: null })).toBeUndefined();
    expect(templateWeek({}, {})).toBeUndefined();
  });

  it("dates a week by its middle day in the next occurrence after now", () => {
    expect(representativeDateOfWeek(20, NOW)).toBe("2027-05-17"); // day 137
    expect(representativeDateOfWeek(52, NOW)).toBe("2026-12-27"); // day 361 of 2026 is still ahead of 2026-10-30
  });

  it("keeps a city's best weeks at least 4 apart, at most 3, earlier week on ties", () => {
    const cands = [
      { week: 10, stage1: 90 },
      { week: 11, stage1: 89 },
      { week: 12, stage1: 88 },
      { week: 20, stage1: 80 },
      { week: 30, stage1: 70 },
      { week: 40, stage1: 60 },
    ];
    expect(thinWeeks(cands).map((c) => c.week)).toEqual([10, 20, 30]);
    expect(thinWeeks([{ week: 8, stage1: 50 }, { week: 3, stage1: 50 }]).map((c) => c.week)).toEqual([3, 8]);
    // wraps over the new year: weeks 52 and 1 are one apart
    expect(thinWeeks([{ week: 52, stage1: 90 }, { week: 1, stage1: 89 }]).map((c) => c.week)).toEqual([52]);
  });
});

describe("runReplay at week resolution", () => {
  it("returns weekly cells for cities with weekly normals and month cells for the rest", async () => {
    const r = await runReplay(q({ bend: { monthShift: 0 } }), deps());
    expect(r.resolution).toBe("week");
    expect(r.weeklyUniverseSize).toBe(3);
    const weekly = r.results.filter((x) => x.week !== undefined);
    const monthly = r.results.filter((x) => x.week === undefined);
    expect(weekly.length).toBeGreaterThan(0);
    expect(monthly.length).toBeGreaterThan(0);
    for (const x of weekly) {
      expect(["lisbon-portugal", "seville-spain", "madrid-spain"]).toContain(x.cityId);
      expect(x.week).toBeGreaterThanOrEqual(1);
      expect(x.week).toBeLessThanOrEqual(52);
      expect(x.month).toBe(monthOfWeek(x.week!));
      expect(x.scoredOn).toContain("weekOfYear");
      expect(x.scoredOn).not.toContain("month");
    }
    for (const x of monthly) {
      expect(["lisbon-portugal", "seville-spain", "madrid-spain"]).not.toContain(x.cityId);
      expect(x.scoredOn).toContain("month"); // the fallback is by month, and says so
    }
  });

  it("ranks the template's own week of its own city first, and keeps weeks apart", async () => {
    const r = await runReplay(q(), deps());
    const tpl = lisbon.fingerprint!.weekOfYear;
    const lis = r.results.filter((x) => x.cityId === "lisbon-portugal");
    expect(lis.length).toBeLessThanOrEqual(3);
    expect(weekDistance(lis[0]!.week!, Math.min(52, tpl))).toBeLessThanOrEqual(4);
    for (let i = 0; i < lis.length; i++) for (let j = i + 1; j < lis.length; j++) expect(weekDistance(lis[i]!.week!, lis[j]!.week!)).toBeGreaterThanOrEqual(4);
  });

  it("separates weeks a month would blur: a mild fortnight inside a hot month wins that city's best week", async () => {
    const hot = weeklyFromMonths("seville-spain", (w) => {
      // Seville in July/August is hot; make weeks 31-32 a (hypothetical) cool, dry spell.
      for (const i of [30, 31]) w[i] = { tempC: 22, precipMm: 0, score: weeklyComfortBreakdown(22, 0).score };
    });
    const d = deps({ weekly: { "seville-spain": hot } });
    const r = await runReplay(q({ template: { fingerprint: { comfort: 100, tempC: 22, precipMm: 0 } }, bend: {} }), d);
    const sev = r.results.filter((x) => x.cityId === "seville-spain");
    expect([31, 32]).toContain(sev[0]!.week);
  });

  it("is deterministic", async () => {
    const a = await runReplay(q(), deps());
    const b = await runReplay(q(), deps());
    expect(b).toEqual(a);
  });

  it("restricts to the requested weeks, and keeps month-resolution cities whose month holds one", async () => {
    const r = await runReplay(q({ constraints: { weeks: [18, 19, 20] } }), deps());
    for (const x of r.results) {
      if (x.week !== undefined) expect([18, 19, 20]).toContain(x.week);
      else expect(x.month).toBe(5); // weeks 18-20 sit in May
    }
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("monthShift null drops the time-of-year dim, for weekly and monthly cells alike", async () => {
    const r = await runReplay(q({ bend: { monthShift: null } }), deps());
    expect(r.results.every((x) => !x.scoredOn.includes("weekOfYear") && !x.scoredOn.includes("month"))).toBe(true);
  });

  it("shifting by a month moves the target about four weeks", async () => {
    const base = await runReplay(q({ template: { fingerprint: { weekOfYear: 20, comfort: 90, tempC: 20, precipMm: 30 } } }), deps());
    const later = await runReplay(q({ template: { fingerprint: { weekOfYear: 20, comfort: 90, tempC: 20, precipMm: 30 } }, bend: { monthShift: 2 } }), deps());
    const dim = (r: typeof base) => r.results.find((x) => x.cityId === "madrid-spain")!.dims.find((d) => d.name === "weekOfYear")!;
    expect(dim(base).templateValue).toBe(20);
    expect(dim(later).templateValue).toBe(((20 - 1 + Math.round((2 * 52) / 12)) % 52) + 1);
  });

  it("reports a week grid for result cities that have weekly normals", async () => {
    const r = await runReplay(q(), deps());
    expect(r.weekGrid!.length).toBeGreaterThan(0);
    for (const g of r.weekGrid!) {
      expect(g.weeks).toHaveLength(52);
      expect(["lisbon-portugal", "seville-spain", "madrid-spain"]).toContain(g.cityId);
    }
  });

  it("leaves month resolution untouched: no week fields, same results with or without weekly data", async () => {
    const withWeekly = await runReplay(q({ resolution: undefined }), deps());
    const without = await runReplay(q({ resolution: undefined }), deps({ weekly: undefined }));
    expect(withWeekly).toEqual(without);
    expect(withWeekly.results.every((x) => x.week === undefined)).toBe(true);
    expect(withWeekly.resolution).toBeUndefined();
    expect(withWeekly.weekGrid).toBeUndefined();
  });

  it("prices a weekly cell on a date inside its week", async () => {
    const dates: string[] = [];
    await runReplay(
      q({ weights: { climate: 1, spend: 0, crowd: 0, flight: 1 } }),
      deps({ flightEstimate: async (p) => (dates.push(p.departureDate), { priceAmount: 100, currency: "EUR", source: "mock" } satisfies FlightEstimateResult) })
    );
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
