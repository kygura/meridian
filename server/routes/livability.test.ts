import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = (await import("./livability.js")).default;
});

describe("GET /api/livability", () => {
  it("lists [cityId, quality, beauty, setting, character] rows within 0-100", async () => {
    const body = (await (await app.request("/")).json()) as { rows: [string, number, number, number | null, number | null][]; sources: object };
    expect(body.rows.length).toBeGreaterThan(5000);
    for (const [id, q, b] of body.rows.slice(0, 500)) {
      expect(typeof id).toBe("string");
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(100);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(100);
    }
    expect(Object.keys(body.sources)).toContain("hdi");
  });

  it("ranks the obvious cases the right way round", async () => {
    const get = async (id: string) => (await (await app.request(`/${id}`)).json()) as { quality: number; beauty: number; setting: number; character: number };
    const [innsbruck, houston, delhi, venice] = await Promise.all(
      ["innsbruck-austria", "houston-united-states", "delhi-india", "venice-italy"].map(get)
    );
    expect(innsbruck.setting).toBeGreaterThan(houston.setting); // Alps vs flat Gulf coast
    expect(innsbruck.quality).toBeGreaterThan(delhi.quality); // clean air, high HDI
    expect(venice.character).toBeGreaterThan(houston.character);
    expect(venice.beauty).toBeGreaterThan(houston.beauty);
  });

  it("explains the breakdown and 404s unknown cities", async () => {
    const res = await app.request("/delhi-india");
    const d = (await res.json()) as { raw: { pm25: number; pm25Local: boolean }; local: number };
    expect(d.raw.pm25Local).toBe(true);
    expect(d.raw.pm25).toBeGreaterThan(30);
    expect(d.local).toBeGreaterThan(0);
    expect((await app.request("/not-a-city")).status).toBe(404);
  });
});

describe("metric surfaces", () => {
  it("serves real quality and beauty surfaces, not the old synthesized one", async () => {
    const { getSurfaceById } = await import("../lib/datasets.js");
    const q = getSurfaceById("quality")!;
    const b = getSurfaceById("beauty")!;
    expect(q.source).toBe("meridian-livability");
    expect(b.source).toBe("meridian-livability");
    expect(q.values.length).toBeGreaterThan(5000);
    expect(b.values.find((v) => v.locationId === "innsbruck-austria")!.normalized).toBeGreaterThan(70);
  });
});
