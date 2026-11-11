import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { dirname } from "path";
import { loadCities, getCities } from "../cities.js";
import { getDataPath } from "../paths.js";
import {
  searchPlaces,
  getPlaceImages,
  getSeasonality,
  getFlightEstimate,
} from "./tools.js";

beforeAll(() => loadCities());

describe("searchPlaces", () => {
  it("ranks deterministically by overall score, tie-broken by name", async () => {
    const a = await searchPlaces({ region: "europe", limit: 5 });
    const b = await searchPlaces({ region: "europe", limit: 5 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 1; i < a.length; i++) {
      expect(a[i - 1].score ?? -1).toBeGreaterThanOrEqual(a[i].score ?? -1);
    }
  });

  it("caps limit at 8 even when a larger limit is requested", async () => {
    const results = await searchPlaces({ limit: 50 as any });
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("filters by region to only that region's countries", async () => {
    const results = await searchPlaces({ region: "asia", limit: 8 });
    const asiaCountries = new Set([
      "Japan", "Thailand", "Vietnam", "Indonesia", "Malaysia", "India",
      "Philippines", "Korea, South", "Taiwan", "Singapore", "Georgia",
    ]);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(asiaCountries.has(r.country)).toBe(true);
    }
  });

  it("filters by country substring", async () => {
    const results = await searchPlaces({ country: "Spain", limit: 8 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.country).toBe("Spain");
  });

  it("filters by minScore", async () => {
    const results = await searchPlaces({ minScore: 90, limit: 8 });
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it("filters by budgetTier", async () => {
    const results = await searchPlaces({ budgetTier: "budget", limit: 8, region: "europe" });
    for (const r of results) expect(r.summaryLine).toContain("Budget-friendly");
  });

  it("ignores an unrecognized region instead of throwing (falls back to the full pool)", async () => {
    const results = await searchPlaces({ region: "nowhere-land", limit: 3 });
    expect(results.length).toBe(3);
  });

  it("returns [] instead of throwing when a recognized region + minScore combo has no matches", async () => {
    const results = await searchPlaces({ region: "europe", minScore: 999 });
    expect(results).toEqual([]);
  });

  it("populates required PlaceResult fields", async () => {
    const [first] = await searchPlaces({ query: "Madrid", limit: 1 });
    expect(first).toBeDefined();
    expect(first).toMatchObject({
      cityId: expect.any(String),
      name: expect.any(String),
      country: expect.any(String),
      lat: expect.any(Number),
      lng: expect.any(Number),
      population: expect.any(Number),
      score: expect.any(Number),
      summaryLine: expect.any(String),
    });
  });
});

describe("getPlaceImages", () => {
  const TEST_CITY_ID = "los-angeles-united-states";
  const cachePath = getDataPath("cache", "images", `${TEST_CITY_ID}.json`);
  let backup: string | null = null;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    backup = existsSync(cachePath) ? readFileSync(cachePath, "utf-8") : null;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (backup !== null) {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, backup);
    } else if (existsSync(cachePath)) {
      rmSync(cachePath);
    }
    global.fetch = originalFetch;
  });

  it("returns cached images without hitting the network (cache hit)", async () => {
    mkdirSync(dirname(cachePath), { recursive: true });
    const cachedImages = [
      {
        url: "https://upload.wikimedia.org/fake.jpg",
        thumbUrl: "https://upload.wikimedia.org/fake-thumb.jpg",
        title: "Los Angeles",
        attribution: "Wikipedia",
        sourcePage: "https://en.wikipedia.org/wiki/Los_Angeles",
      },
    ];
    writeFileSync(
      cachePath,
      JSON.stringify({ cachedAt: new Date().toISOString(), images: cachedImages }, null, 2)
    );

    const fetchSpy = vi.fn(() => {
      throw new Error("network should not be called on a cache hit");
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getPlaceImages({ cityId: TEST_CITY_ID });
    expect(result).toEqual(cachedImages);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails gracefully (returns []) when the network throws, never throws itself", async () => {
    if (existsSync(cachePath)) rmSync(cachePath);
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    await expect(getPlaceImages({ cityId: TEST_CITY_ID })).resolves.toEqual([]);
  });

  it("returns [] when neither cityId nor title is provided", async () => {
    const result = await getPlaceImages({});
    expect(result).toEqual([]);
  });

  it("returns [] for an unknown cityId without throwing", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("should not be reached"))) as unknown as typeof fetch;
    const result = await getPlaceImages({ cityId: "does-not-exist-anywhere" });
    expect(result).toEqual([]);
  });
});

describe("getSeasonality", () => {
  it("returns {available:false} for a city with no seasonality data (missing-data path)", async () => {
    const result = await getSeasonality({ cityId: "definitely-not-a-real-city-id" });
    expect(result.available).toBe(false);
    expect(result.months).toBeUndefined();
  });

  it("never throws even if the underlying module/data is entirely absent", async () => {
    await expect(getSeasonality({ cityId: getCities()[0]?.id ?? "x" })).resolves.toMatchObject({
      available: expect.any(Boolean),
    });
  });
});

describe("getFlightEstimate", () => {
  const originalDuffel = process.env.DUFFEL_API_KEY;
  const originalSerp = process.env.SERPAPI_KEY;

  beforeEach(() => {
    delete process.env.DUFFEL_API_KEY;
    delete process.env.SERPAPI_KEY;
  });

  afterEach(() => {
    if (originalDuffel !== undefined) process.env.DUFFEL_API_KEY = originalDuffel;
    if (originalSerp !== undefined) process.env.SERPAPI_KEY = originalSerp;
  });

  it("falls back to a deterministic mock estimate when no provider is configured", async () => {
    const a = await getFlightEstimate({ originIata: "MAD", destinationIata: "LAX", departureDate: "2026-09-01" });
    const b = await getFlightEstimate({ originIata: "MAD", destinationIata: "LAX", departureDate: "2026-09-01" });
    expect(a.source).toBe("mock");
    expect(a).toEqual(b);
    expect(a.priceAmount).toBeGreaterThan(0);
    expect(a.currency).toBe("USD");
  });

  it("never throws even with nonsense IATA codes", async () => {
    await expect(
      getFlightEstimate({ originIata: "ZZZ", destinationIata: "ZZZ" })
    ).resolves.toMatchObject({ source: "mock" });
  });
});

describe("check_visa", async () => {
  const { checkVisa } = await import("./tools");
  it("checks named passports without the owner, and refuses the owner's data while locked", async () => {
    const r = await checkVisa({ passports: ["US"], stays: [{ country: "Portugal", start: "2027-01-01", end: "2027-04-15" }, { country: "Thailand", start: "2027-05-01", end: "2027-06-15" }] }, { unlocked: false });
    if ("error" in r) throw new Error(String(r.error));
    expect(r.stays.map((s) => s.verdict)).toEqual(["over", "over"]);
    expect(r.violations.map((v) => v.limit)).toEqual(["Schengen Area", "Thailand"]);
    expect(r.stays[1].limit).toBe("30 days per entry");
    expect(r.stays[1].sources[0].url).toMatch(/^https:\/\/www\.gov\.uk\//);
    expect(r.disclaimer).toMatch(/not legal or tax advice/);
    expect(await checkVisa({ stays: [{ country: "Portugal", start: "2027-01-01", end: "2027-02-01" }] }, { unlocked: false })).toMatchObject({ error: "owner_only" });
    expect(await checkVisa({ passports: ["US"], includeMyStays: true }, { unlocked: false })).toMatchObject({ error: "owner_only" });
    expect(await checkVisa({ passports: ["US"], stays: [{ country: "Portugal", start: "2027-01-01" }] } as never, { unlocked: true })).toMatchObject({ error: "invalid_params" });
  });
});
