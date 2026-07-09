import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";

let app: Hono;

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
  const { loadCities } = await import("../lib/cities.js");
  loadCities();

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
