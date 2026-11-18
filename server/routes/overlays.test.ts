import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Hono } from "hono";
import type { MapAnomaly, MapEventPoint, MeridianEvent } from "../../src/types.js";

let app: Hono;
const SOURCE = "Wikidata (CC0), Japan Meteorological Agency, iNaturalist, NOAA SWPC";

beforeAll(async () => {
  // Empty DATA_DIR: anomalies fall back to the committed seed in data/; events come from a seeded live store.
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-overlays-"));
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  const { seedLiveEvents, ev } = await import("../lib/__fixtures__/liveEvents.js");
  seedLiveEvents([
    ev("wd-tet", { title: "Tet", cityIds: ["hanoi-vietnam"], month: 1, recurring: false, date: "2099-02-10", tags: ["festival", "lunar-new-year"] }),
    ev("wd-songkran", { title: "Songkran", cityIds: ["bangkok-thailand"], month: 4, tags: ["festival", "water-festival"] }),
    ev("wd-old", { title: "Old", cityIds: ["bangkok-thailand"], month: 8, recurring: false, date: "2001-08-01", tags: ["sport"] }),
    ev("wd-aug", { title: "August thing", cityIds: ["hanoi-vietnam", "bangkok-thailand"], month: 8, tags: ["sport", "marathon"] }),
    ev("jma-bloom", { title: "Cherry blossom", kind: "nature", cityIds: ["tokyo-japan"], month: 3, months: [3, 4], tags: ["cherry-blossom", "nature"], note: "Normal: first flowers Mar 24." }),
    ev("season-peak-bkk", { title: "Peak season", kind: "season", cityIds: ["bangkok-thailand"], month: 12, months: [12, 1, 2], tags: ["peak-season"] }),
  ]);
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
    const body = (await res.json()) as { events: MeridianEvent[]; asOf: string; source: string };
    expect(body.source).toBe(SOURCE);
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain("wd-tet"); // dated, a later year, still included
    expect(ids).not.toContain("wd-old"); // dated and past
    expect(body.events.find((e) => e.id === "wd-tet")!.cityIds).toEqual(["hanoi-vietnam"]);
    expect(body.events.some((e) => e.recurring && e.cityIds.includes("bangkok-thailand"))).toBe(true);
    expect(body.events.every((e) => e.recurring || !e.date || e.date >= new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it("places a month's events on their cities", async () => {
    const res = await app.request("/events?month=8");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { month: number; events: MapEventPoint[]; asOf: string; source: string };
    expect(body.month).toBe(8);
    expect(body.source).toBe(SOURCE);
    expect(body.events.map((e) => `${e.eventId}@${e.cityId}`).sort()).toEqual(["wd-aug@bangkok-thailand", "wd-aug@hanoi-vietnam"]);
    for (const e of body.events) {
      expect(Number.isFinite(e.lat) && Number.isFinite(e.lng)).toBe(true);
      expect(e.cityName).toBeTruthy();
    }
  });
});

describe("GET /api/overlays/events for a multi-month event and a tourism season", () => {
  it("matches the month against every month of the event and carries the months and the note", async () => {
    const apr = (await (await app.request("/events?month=4")).json()) as { events: MapEventPoint[] };
    const bloom = apr.events.find((e) => e.eventId === "jma-bloom")!;
    expect(bloom).toMatchObject({ kind: "nature", months: [3, 4], note: "Normal: first flowers Mar 24.", cityId: "tokyo-japan" });
    const may = (await (await app.request("/events?month=5")).json()) as { events: MapEventPoint[] };
    expect(may.events.some((e) => e.eventId === "jma-bloom")).toBe(false);
  });

  it("leaves tourism seasons off the map points unless seasons=1, and keeps them in a city's list", async () => {
    const off = (await (await app.request("/events?month=1")).json()) as { events: MapEventPoint[] };
    expect(off.events.some((e) => e.kind === "season")).toBe(false);
    const on = (await (await app.request("/events?month=1&seasons=1")).json()) as { events: MapEventPoint[] };
    expect(on.events.map((e) => e.eventId)).toContain("season-peak-bkk");
    const list = (await (await app.request("/events?cityIds=bangkok-thailand")).json()) as { events: MeridianEvent[] };
    expect(list.events.map((e) => e.id)).toContain("season-peak-bkk");
  });
});

describe("GET /api/overlays/events/tags", () => {
  it("returns the distinct tags of upcoming events with counts", async () => {
    const body = (await (await app.request("/events/tags")).json()) as { tags: { tag: string; count: number }[]; source: string };
    expect(body.source).toBe(SOURCE);
    expect(body.tags.find((t) => t.tag === "festival")).toEqual({ tag: "festival", count: 2 });
    expect(body.tags.find((t) => t.tag === "peak-season")).toEqual({ tag: "peak-season", count: 1 });
    expect(body.tags.find((t) => t.tag === "cherry-blossom")).toEqual({ tag: "cherry-blossom", count: 1 });
    expect(body.tags.find((t) => t.tag === "marathon")).toEqual({ tag: "marathon", count: 1 });
    expect(body.tags.find((t) => t.tag === "sport")).toEqual({ tag: "sport", count: 1 }); // the 2001 one is past
  });
});

describe("GET /api/overlays/events/status", () => {
  it("reports the store without secrets", async () => {
    const body = (await (await app.request("/events/status")).json()) as { source: string; total: number; fetchedAt: string | null; sources: unknown[] };
    expect(body).toMatchObject({ source: SOURCE, total: 6, sources: [] });
    expect(body.fetchedAt).toBeTruthy();
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
