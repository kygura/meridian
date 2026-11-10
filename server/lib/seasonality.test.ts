import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { comfortScore, aggregateDailyToMonthly } from "./seasonality";

describe("comfortScore — temperature curve (monthly mean)", () => {
  it("scores 100 across the 16-20C sweet spot", () => {
    expect(comfortScore(16, 0)).toBe(100);
    expect(comfortScore(18, 0)).toBe(100);
    expect(comfortScore(20, 0)).toBe(100);
  });
  it("falls away fast above it: a 26C mean is a ~33C afternoon", () => {
    expect(comfortScore(22, 0)).toBe(85);
    expect(comfortScore(24, 0)).toBe(65);
    expect(comfortScore(26, 0)).toBe(45);
    expect(comfortScore(30, 0)).toBe(15);
  });
  it("interpolates between curve points", () => {
    // 22C -> 85, 24C -> 65: 23C sits halfway
    expect(comfortScore(23, 0)).toBe(75);
    // 9C -> 50, 13C -> 78: 11C sits halfway
    expect(comfortScore(11, 0)).toBe(64);
  });
  it("falls away more gently below it", () => {
    expect(comfortScore(13, 0)).toBe(78);
    expect(comfortScore(4, 0)).toBe(25);
  });
  it("is 0 at a 34C mean and at -10C, and clamps beyond", () => {
    expect(comfortScore(34, 0)).toBe(0);
    expect(comfortScore(45, 0)).toBe(0);
    expect(comfortScore(-10, 0)).toBe(0);
    expect(comfortScore(-30, 0)).toBe(0);
  });
});

describe("comfortScore — calibrated against real climates (2015-2024 means)", () => {
  // [mean C, rain mm] from data/seasonality.json
  it("puts Cairo's spring and summer where a visitor would", () => {
    expect(comfortScore(18.5, 9)).toBe(100); // March
    expect(comfortScore(22.4, 2)).toBeLessThan(85); // April: ~30C afternoons
    expect(comfortScore(26.5, 0)).toBeLessThan(45); // May
    expect(comfortScore(30.7, 0)).toBeLessThan(15); // July
  });
  it("does not call the Gulf pleasant from April on", () => {
    expect(comfortScore(25.9, 5)).toBeLessThan(50); // Manama, April
    expect(comfortScore(35.2, 0)).toBe(0); // Manama, July
  });
  it("marks Madrid's July down and its May up", () => {
    expect(comfortScore(27.4, 7)).toBeLessThan(40);
    expect(comfortScore(18.1, 31)).toBeGreaterThan(95);
  });
  it("still tells a tropical dry season from the monsoon", () => {
    expect(comfortScore(26.6, 24)).toBeGreaterThan(comfortScore(28.6, 195) + 30); // Bangkok Dec vs Jul
  });
});

describe("comfortScore — precipitation penalty", () => {
  it("applies no penalty at or below 30mm", () => {
    expect(comfortScore(18, 0)).toBe(100);
    expect(comfortScore(18, 30)).toBe(100);
  });
  it("applies the full -35 penalty at or above 250mm", () => {
    expect(comfortScore(18, 250)).toBe(65);
  });
  it("does not apply more than -35 penalty beyond 250mm", () => {
    expect(comfortScore(18, 1000)).toBe(65);
  });
  it("scales linearly between the free and max thresholds (140mm)", () => {
    // penalty = 35 * (140-30)/(250-30) = 17.5 -> 100-17.5 = 82.5 -> 83
    expect(comfortScore(18, 140)).toBe(83);
  });
});

describe("comfortScore — clamp and determinism", () => {
  it("never returns below 0 even with a harsh temp and heavy rain", () => {
    expect(comfortScore(-30, 500)).toBe(0);
    expect(comfortScore(55, 500)).toBe(0);
  });
  it("never returns above 100", () => {
    expect(comfortScore(18, -10)).toBeLessThanOrEqual(100);
  });
  it("is a pure function — same inputs always produce the same output", () => {
    const a = comfortScore(21.3, 87);
    const b = comfortScore(21.3, 87);
    const c = comfortScore(21.3, 87);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
  it("always returns an integer", () => {
    expect(Number.isInteger(comfortScore(19.7, 63))).toBe(true);
  });
});

describe("aggregateDailyToMonthly", () => {
  function makeDailyMonth(year: number, month: number, days: number, tempC: number, precipMm: number) {
    const mm = String(month + 1).padStart(2, "0");
    return Array.from({ length: days }, (_, d) => ({
      date: `${year}-${mm}-${String(d + 1).padStart(2, "0")}`,
      tempC,
      precipMm,
    }));
  }

  it("averages temperature across years for the same calendar month", () => {
    const daily = [
      ...makeDailyMonth(2020, 0, 31, 10, 5),
      ...makeDailyMonth(2021, 0, 31, 20, 1),
    ];
    const monthly = aggregateDailyToMonthly(daily);
    expect(monthly[0]!.tempC).toBe(15);
  });

  it("averages the yearly monthly precipitation total across years", () => {
    const daily = [
      ...makeDailyMonth(2020, 0, 31, 10, 5), // 155mm total in Jan 2020
      ...makeDailyMonth(2021, 0, 31, 20, 1), // 31mm total in Jan 2021
    ];
    const monthly = aggregateDailyToMonthly(daily);
    // (155 + 31) / 2 = 93
    expect(monthly[0]!.precipMm).toBe(93);
  });

  it("returns 12 months and defaults uncovered months to zero", () => {
    const daily = makeDailyMonth(2020, 5, 30, 25, 10); // June only
    const monthly = aggregateDailyToMonthly(daily);
    expect(monthly).toHaveLength(12);
    expect(monthly[5]!.tempC).toBe(25);
    expect(monthly[0]!.tempC).toBe(0);
    expect(monthly[0]!.precipMm).toBe(0);
  });

  it("rounds tempC to 1 decimal place", () => {
    const daily = [
      { date: "2020-03-01", tempC: 10.11, precipMm: 0 },
      { date: "2020-03-02", tempC: 10.19, precipMm: 0 },
    ];
    const monthly = aggregateDailyToMonthly(daily);
    // mean = 10.15 -> 10.1 or 10.2 depending on fp rounding, but always 1dp
    expect(monthly[2]!.tempC.toString()).toMatch(/^\d+(\.\d)?$/);
  });

  it("is deterministic for the same input", () => {
    const daily = makeDailyMonth(2020, 2, 31, 18.4, 42);
    const a = aggregateDailyToMonthly(daily);
    const b = aggregateDailyToMonthly(daily);
    expect(a).toEqual(b);
  });
});

// ── On-demand fetching (ADR-0002 amendment) ───────────────────────────────
// Seed cache (data/seasonality.json) is pristine; misses for known cities
// fetch Open-Meteo live and persist to a separate runtime cache file. All
// network calls are mocked — no real requests in tests.

describe("on-demand fetching", () => {
  let dir: string;
  let realCityId: string;
  let realCityId2: string;
  let originalFetch: typeof fetch;
  let mod: typeof import("./seasonality.js");

  function freshDataDir() {
    dir = mkdtempSync(join(tmpdir(), "meridian-seasonality-live-"));
    process.env.DATA_DIR = dir;
    const seed = {
      version: 1,
      generatedAt: new Date().toISOString(),
      window: "2015-2024",
      cities: {
        "paris-france": {
          months: Array.from({ length: 12 }, (_, i) => ({
            score: 50 + i,
            tempC: 10 + i,
            precipMm: 40,
          })),
        },
      },
    };
    writeFileSync(join(dir, "seasonality.json"), JSON.stringify(seed));
  }

  function mockOpenMeteoOk() {
    const time = ["2020-06-01", "2020-06-02", "2020-06-03"];
    return {
      daily: {
        time,
        temperature_2m_max: time.map(() => 26),
        temperature_2m_min: time.map(() => 18),
        precipitation_sum: time.map(() => 5),
      },
    };
  }

  beforeAll(async () => {
    const cities = await import("./cities.js");
    cities.loadCities();
    const all = cities.getCities();
    const other = all.find((c) => c.id !== "paris-france");
    if (!other) throw new Error("worldcities.csv has no city to use as an on-demand fixture");
    realCityId = other.id;
    const other2 = all.find((c) => c.id !== "paris-france" && c.id !== realCityId);
    if (!other2) throw new Error("worldcities.csv has no second city to use as an on-demand fixture");
    realCityId2 = other2.id;

    mod = await import("./seasonality.js");
  });

  beforeEach(() => {
    freshDataDir();
    mod.resetSeasonalityCache();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it("returns a cache hit without fetching", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await mod.resolveCitySeasonality("paris-france");
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") {
      // Stored scores are re-derived from temperature and rain on load.
      expect(result.months[0]).toEqual({ score: comfortScore(10, 40), tempC: 10, precipMm: 40 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches live on a miss, persists to the runtime cache file, and skips fetch next time", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return { ok: true, json: async () => mockOpenMeteoOk() } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await mod.resolveCitySeasonality(realCityId);
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") expect(result.months).toHaveLength(12);
    expect(calls).toBe(1);

    const runtimeRaw = JSON.parse(
      readFileSync(join(dir, "cache", "seasonality-runtime.json"), "utf-8")
    );
    expect(runtimeRaw.cities[realCityId].months).toHaveLength(12);

    const second = await mod.resolveCitySeasonality(realCityId);
    expect(second.kind).toBe("hit");
    expect(calls).toBe(1); // no second fetch — served from the runtime cache
  });

  it("dedupes concurrent in-flight fetches for the same city into a single request", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => mockOpenMeteoOk() } as unknown as Response;
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      mod.resolveCitySeasonality(realCityId2),
      mod.resolveCitySeasonality(realCityId2),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("returns unavailable on a quota/rate-limit error and never caches the failure", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: true, reason: "Minutely API request limit exceeded" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await mod.resolveCitySeasonality(realCityId);
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toBe("quota");
    expect(calls).toBe(1);

    // Not cached — a second attempt retries the fetch rather than replaying a stored failure.
    const second = await mod.resolveCitySeasonality(realCityId);
    expect(calls).toBe(2);
    expect(second.kind).toBe("unavailable");
  });

  it("returns unknown (never fetches) for a city id absent from the cities db", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await mod.resolveCitySeasonality("nowhere-nowhere");
    expect(result.kind).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();

    const months = await mod.getCitySeasonality("nowhere-nowhere");
    expect(months).toBeUndefined();
  });
});
