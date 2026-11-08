import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import type { MapAnomaly, MapEventPoint, MeridianEvent } from "../../src/types.js";

let app: Hono;

beforeAll(async () => {
  // Empty DATA_DIR: both feeds fall back to the committed seeds in data/.
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-overlays-"));
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = (await import("./overlays.js")).default;
});

describe("GET /api/overlays/events", () => {
  it("rejects a missing or bad month", async () => {
    expect((await app.request("/events")).status).toBe(400);
    expect((await app.request("/events?month=13")).status).toBe(400);
  });

  it("lists every upcoming event at the asked-for cities, narrowed to them", async () => {
    expect((await app.request("/events?cityIds=")).status).toBe(400);
    const res = await app.request("/events?cityIds=hanoi-vietnam,bangkok-thailand");
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as { events: MeridianEvent[] };
    const ids = events.map((e) => e.id);
    expect(ids).toContain("tet-2028"); // dated, a later year, still included
    expect(events.find((e) => e.id === "tet-2028")!.cityIds).toEqual(["hanoi-vietnam"]);
    expect(events.some((e) => e.recurring && e.cityIds.includes("bangkok-thailand"))).toBe(true); // Songkran
    expect(events.every((e) => e.recurring || !e.date || e.date >= new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it("places a month's events on their cities", async () => {
    const res = await app.request("/events?month=8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: number; events: MapEventPoint[] };
    expect(body.month).toBe(8);
    for (const e of body.events) {
      expect(Number.isFinite(e.lat) && Number.isFinite(e.lng)).toBe(true);
      expect(e.cityName).toBeTruthy();
    }
  });
});

describe("GET /api/overlays/anomalies", () => {
  it("returns every item without a month", async () => {
    const body = (await (await app.request("/anomalies")).json()) as { items: MapAnomaly[]; asOf: string };
    expect(body.asOf).toMatch(/^\d{4}-\d{2}$/);
    expect(body.items.some((a) => a.kind === "conflict")).toBe(true);
    expect(body.items.some((a) => a.kind === "hazard")).toBe(true);
  });

  it("keeps standing conflicts and only in-season hazards for a month", async () => {
    const body = (await (await app.request("/anomalies?month=2")).json()) as { items: MapAnomaly[] };
    expect(body.items.some((a) => a.kind === "conflict")).toBe(true);
    const hazards = body.items.filter((a) => a.kind === "hazard");
    expect(hazards.length).toBeGreaterThan(0);
    expect(hazards.every((a) => a.months!.includes(2))).toBe(true);
    expect(hazards.some((a) => a.id === "hazard-atlantic-hurricanes")).toBe(false);
  });

  it("rejects a bad month", async () => {
    expect((await app.request("/anomalies?month=0")).status).toBe(400);
  });
});
