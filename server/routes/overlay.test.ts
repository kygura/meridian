import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  app = (await import("../app.js")).default as unknown as Hono;
});

describe("GET /api/overlay/climate", () => {
  it("returns 12 [comfort, tempC, precipMm] triples per covered city", async () => {
    const res = await app.request("/api/overlay/climate");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: string; cities: Record<string, number[][]> };
    const ids = Object.keys(body.cities);
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids.slice(0, 20)) {
      expect(body.cities[id]).toHaveLength(12);
      for (const t of body.cities[id]!) expect(t).toHaveLength(3);
    }
    expect(body.window).toMatch(/^\d{4}-\d{4}$/);
  });
});

describe("GET /api/overlay/metrics", () => {
  it("returns every society metric as 0-100 values keyed by city, with confidence", async () => {
    const res = await app.request("/api/overlay/metrics");
    const body = (await res.json()) as { metrics: Record<string, Record<string, number>>; confidence: Record<string, string> };
    for (const k of ["stability", "quality", "cost", "tourism", "connectivity", "density"]) {
      const values = Object.values(body.metrics[k] ?? {});
      expect(values.length, k).toBeGreaterThan(1000);
      for (const v of values.slice(0, 200)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(["high", "medium", "low"]).toContain(body.confidence[k]);
    }
  });
});

describe("GET /api/overlay/events", () => {
  it("returns valid events", async () => {
    const res = await app.request("/api/overlay/events");
    const body = (await res.json()) as { events: { id: string; month: number; cityIds: string[] }[] };
    expect(Array.isArray(body.events)).toBe(true);
    for (const e of body.events) {
      expect(e.month).toBeGreaterThanOrEqual(1);
      expect(e.cityIds.length).toBeGreaterThan(0);
    }
  });
});
