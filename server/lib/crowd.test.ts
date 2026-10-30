import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SOURCE_MARKETS,
  peakIndex,
  holidayShare,
  holidayShareToIndex,
  combineCrowd,
  buildHolidayIndex,
  crowdProxyForMonth,
  computeCrowdProxy,
  parseNagerHolidays,
  diskHolidayCache,
  loadHolidayIndexFromCache,
  getYearHolidays,
} from "./crowd";
import { fakeFetch, memHolidayCache, nagerBody, HOLIDAYS_2024, SEASONALITY } from "./__fixtures__/journal";

const season = (id: string) => SEASONALITY[id];

describe("peakIndex (month-relative, from the city's own comfort curve)", () => {
  it("maps the best month to 100 and the worst to 0", () => {
    const m = SEASONALITY["oslo-norway"]!;
    const scores = m.map((x) => x.score);
    expect(peakIndex(m, scores.indexOf(Math.max(...scores)) + 1)).toBe(100);
    expect(peakIndex(m, scores.indexOf(Math.min(...scores)) + 1)).toBe(0);
  });
  it("keeps a near-flat curve close to 50", () => {
    const flat = Array.from({ length: 12 }, (_, i) => ({ score: 80 + (i % 2) * 4, tempC: 25, precipMm: 50 }));
    expect(peakIndex(flat, 1)).toBe(40);
    expect(peakIndex(flat, 2)).toBe(60);
  });
});

describe("holiday overlap", () => {
  it("is the mean over markets of the fraction of days that are holidays", () => {
    expect(holidayShare(["2024-05-01", "2024-05-02"], { A: ["2024-05-01"], B: [] })).toBe(0.25);
    expect(holidayShare(["2024-05-01"], {})).toBeUndefined();
  });
  it("caps the index at 100", () => {
    expect(holidayShareToIndex(0.05)).toBe(50);
    expect(holidayShareToIndex(0.5)).toBe(100);
  });
  it("combines 0.7 peak + 0.3 holiday; holiday missing → peak only", () => {
    expect(combineCrowd(80, 20)).toBe(62);
    expect(combineCrowd(80, undefined)).toBe(80);
  });
  it("parses Nager responses, keeping national holidays only", () => {
    const dates = parseNagerHolidays(nagerBody("KR"))!;
    expect(dates).toEqual(HOLIDAYS_2024.KR);
    expect(dates).not.toContain("2024-06-15");
    expect(parseNagerHolidays({ nope: 1 })).toBeUndefined();
  });
  it("uses at most 8 source markets", () => {
    expect(SOURCE_MARKETS.length).toBeLessThanOrEqual(8);
  });
});

describe("crowdProxyForMonth (sync, cache-only)", () => {
  const index = buildHolidayIndex({ 2024: HOLIDAYS_2024 })!;

  it("builds a 12-month index with more holiday share in May than in June", () => {
    expect(index).toHaveLength(12);
    expect(index[4]!).toBeGreaterThan(index[5]!);
  });
  it("combines peak and cached holiday share", () => {
    const r = crowdProxyForMonth("lisbon-portugal", 5, index, season)!;
    expect(r.value).toBe(combineCrowd(r.peak, holidayShareToIndex(index[4]!)));
    expect(r.flags).toEqual([]);
  });
  it("falls back to peak only (flagged) without an index", () => {
    const r = crowdProxyForMonth("lisbon-portugal", 5, undefined, season)!;
    expect(r.value).toBe(r.peak);
    expect(r.flags).toEqual(["holidays_unavailable"]);
  });
  it("is undefined for a city without seasonality", () => {
    expect(crowdProxyForMonth("nowhere-land", 5, index, season)).toBeUndefined();
  });
});

describe("computeCrowdProxy (async, Nager.Date)", () => {
  it("counts holidays over the exact stay and caches per (year, cc)", async () => {
    const f = fakeFetch();
    const cache = memHolidayCache();
    const r = (await computeCrowdProxy(
      { cityId: "lisbon-portugal", month: 5, year: 2024, dateRange: { from: "2024-05-10", to: "2024-05-16" } },
      { fetch: f.fn, cache, seasonality: season }
    ))!;
    // Only KR 2024-05-15 falls in the 7 days: share = (1/7)/8 → index 18.
    expect(r.holiday).toBe(18);
    expect(r.value).toBe(combineCrowd(r.peak, 18));
    expect(f.calls).toHaveLength(8);
    await computeCrowdProxy({ cityId: "lisbon-portugal", month: 5, year: 2024 }, { fetch: f.fn, cache, seasonality: season });
    expect(f.calls).toHaveLength(8); // second call fully cached
  });

  it("uses peak only and flags when Nager fails", async () => {
    const f = fakeFetch({ nager: "fail" });
    const r = (await computeCrowdProxy({ cityId: "lisbon-portugal", month: 5, year: 2024 }, { fetch: f.fn, cache: memHolidayCache(), seasonality: season }))!;
    expect(r.holiday).toBeUndefined();
    expect(r.value).toBe(r.peak);
    expect(r.flags).toEqual(["holidays_unavailable"]);
  });
});

describe("holiday disk cache", () => {
  const prev = process.env.DATA_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
  });

  it("writes data/cache/holidays/{year}-{cc}.json and loads the index without network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-holidays-"));
    process.env.DATA_DIR = dir;
    expect(loadHolidayIndexFromCache()).toBeUndefined();
    await getYearHolidays(2024, { fetch: fakeFetch().fn, cache: diskHolidayCache() });
    expect(existsSync(join(dir, "cache", "holidays", "2024-KR.json"))).toBe(true);
    expect(loadHolidayIndexFromCache()).toEqual(buildHolidayIndex({ 2024: HOLIDAYS_2024 }));
  });
});
