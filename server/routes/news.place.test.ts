import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import type { MapAnomaly } from "../../src/types.js";

let app: Hono;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-news-place-"));
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = (await import("./news.js")).default;
});

afterEach(async () => {
  vi.restoreAllMocks();
  (await import("../lib/placeNews.js")).resetPlaceNewsCache();
});

describe("GET /api/news/place", () => {
  it("404s an unknown city", async () => {
    expect((await app.request("/place?cityId=nowhere-nowhere")).status).toBe(404);
  });

  it("returns Spain's rail advisory for a Spanish city even when news search is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const res = await app.request("/place?cityId=madrid-spain");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; advisories: MapAnomaly[]; country: string };
    expect(body.available).toBe(false);
    expect(body.country).toBe("Spain");
    expect(body.advisories.map((a) => a.id)).toContain("advisory-spain-high-speed-rail");
  });

  it("returns no advisories for a country without any", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const body = (await (await app.request("/place?cityId=tokyo-japan")).json()) as { advisories: MapAnomaly[] };
    expect(body.advisories).toEqual([]);
  });
});
