import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import { resetSeasonalityCache } from "../lib/seasonality.js";

let app: Hono;
let realCityIds: string[];

/**
 * Points DATA_DIR at a brand-new temp dir with a minimal seed containing
 * only "paris-france", so every realCityIds lookup starts as a genuine miss
 * — no runtime-cache leakage between on-demand tests sharing this file.
 */
function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "meridian-seasonality-route-"));
  process.env.DATA_DIR = dir;
  const fixture = {
    version: 1,
    generatedAt: new Date().toISOString(),
    window: "2015-2024",
    cities: {
      "paris-france": {
        months: Array.from({ length: 12 }, (_, i) => ({ score: 50 + i, tempC: 10 + i, precipMm: 40 })),
      },
    },
  };
  writeFileSync(join(dir, "seasonality.json"), JSON.stringify(fixture));
  return dir;
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
  // Point DATA_DIR at an isolated fixture *before* dynamically importing
  // anything that reads it (paths.ts reads DATA_DIR at module-eval time, so
  // this must happen ahead of the dynamic import below, not a static one).
  const dir = mkdtempSync(join(tmpdir(), "meridian-seasonality-"));
  process.env.DATA_DIR = dir;

  const fixture = {
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
  writeFileSync(join(dir, "seasonality.json"), JSON.stringify(fixture));

  // cities.ts loads worldcities.csv from process.cwd() regardless of
  // DATA_DIR, so this always sees the real, committed city database —
  // "paris-france" (Paris, France) is a real entry there.
  const { loadCities, getCities } = await import("../lib/cities.js");
  loadCities();

  // Real cities that are NOT in the seasonality fixture above, used to
  // exercise the on-demand fetch path without hitting the network (fetch is
  // mocked per-test below).
  realCityIds = getCities()
    .filter((c) => c.id !== "paris-france")
    .slice(0, 8)
    .map((c) => c.id);

  const mod = await import("./seasonality.js");
  app = mod.default;
});

describe("GET /api/seasonality/:cityId", () => {
  it("returns 12 months for a covered city", async () => {
    const res = await app.request("/paris-france");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cityId).toBe("paris-france");
    expect(body.months).toHaveLength(12);
    expect(body.months[0]).toEqual({ score: 50, tempC: 10, precipMm: 40 });
  });

  it("returns 404 for an uncovered city", async () => {
    const res = await app.request("/nowhere-nowhere");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/seasonality/regions", () => {
  it("is matched ahead of the /:cityId wildcard and returns aggregates", async () => {
    const res = await app.request("/regions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.regions)).toBe(true);
    const france = body.regions.find((r: { region: string }) => r.region === "France");
    expect(france).toBeDefined();
    expect(france.months).toHaveLength(12);
    expect(france.months[0].score).toBe(50);
  });
});

describe("GET /api/seasonality?cityIds=", () => {
  it("returns a batch with covered cities populated and uncovered ones null", async () => {
    const res = await app.request("/?cityIds=paris-france,nowhere-nowhere");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cities["paris-france"]).toHaveLength(12);
    expect(body.cities["nowhere-nowhere"]).toBeNull();
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `city-${i}`).join(",");
    const res = await app.request(`/?cityIds=${ids}`);
    expect(res.status).toBe(400);
  });

  it("rejects a missing/empty cityIds param", async () => {
    const res = await app.request("/?cityIds=");
    expect(res.status).toBe(400);
  });
});

// ── On-demand fetching (ADR-0002 amendment) ───────────────────────────────
// realCityIds are real cities absent from the seed fixture, so every hit
// against them here is a cache miss that must go through the (mocked) fetch.

describe("GET /api/seasonality/:cityId — on-demand fetch", () => {
  let originalFetch: typeof fetch;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    freshDataDir();
    resetSeasonalityCache();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DATA_DIR = originalDataDir;
    resetSeasonalityCache();
  });

  it("fetches live and returns 200 with 12 months for an unseeded but real city", async () => {
    global.fetch = vi.fn(async () => {
      return { ok: true, json: async () => mockOpenMeteoOk() } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await app.request(`/${realCityIds[0]}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cityId).toBe(realCityIds[0]);
    expect(body.months).toHaveLength(12);
  });

  it("maps a fetch/quota failure to 503 seasonality_unavailable", async () => {
    global.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: true, reason: "Minutely API request limit exceeded" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await app.request(`/${realCityIds[1]}`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      error: "seasonality_unavailable",
      message: "climate provider quota or network — retry later",
    });
  });
});

describe("GET /api/seasonality?cityIds= — on-demand batch cap", () => {
  let originalFetch: typeof fetch;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
    freshDataDir();
    resetSeasonalityCache();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.DATA_DIR = originalDataDir;
    resetSeasonalityCache();
  });

  it("fetches on-demand for at most 4 misses and returns null for the rest", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return { ok: true, json: async () => mockOpenMeteoOk() } as unknown as Response;
    }) as unknown as typeof fetch;

    // 8 real, uncached cities — well past the cap of 4 on-demand fetches.
    const res = await app.request(`/?cityIds=${realCityIds.join(",")}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(calls).toBe(4);
    const populated = realCityIds.filter((id) => body.cities[id] !== null);
    const skipped = realCityIds.filter((id) => body.cities[id] === null);
    expect(populated).toHaveLength(4);
    expect(skipped).toHaveLength(realCityIds.length - 4);
    for (const id of populated) {
      expect(body.cities[id]).toHaveLength(12);
    }
  });

  it("never returns 503 for the batch endpoint — fetch failures become null", async () => {
    global.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: true, reason: "quota" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const res = await app.request(`/?cityIds=${realCityIds.slice(0, 2).join(",")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const id of realCityIds.slice(0, 2)) {
      expect(body.cities[id]).toBeNull();
    }
  });
});
