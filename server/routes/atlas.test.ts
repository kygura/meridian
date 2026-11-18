import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { gateRoutes } from "../middleware/auth";
import { resetAuthMemory } from "../lib/authStore";

const TOKEN = "test-token";
let TMP: string;
let app: Hono;

beforeAll(async () => {
  const { loadCities } = await import("../lib/cities.js");
  loadCities();
  app = new Hono();
  gateRoutes(app);
  app.route("/api/atlas", (await import("./atlas.js")).default);
  app.route("/api/trips", (await import("./trips.js")).default);
  app.route("/api/notifications", (await import("./notifications.js")).default);
  app.route("/api/rotation", (await import("./rotation.js")).default);
});

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-atlas-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  // No channel is configured, so notify() only writes the log.
  for (const k of ["TELEGRAM_BOT_TOKEN", "ALERT_WEBHOOK_URL", "NTFY_TOPIC", "RESEND_API_KEY", "SMTP_URL", "VAPID_PUBLIC_KEY"]) delete process.env[k];
  resetAuthMemory();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
});

async function call<T = Record<string, any>>(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

const flight = (id: string, priceEur: number, extra: Record<string, unknown> = {}) => ({
  id,
  source: "kiwi",
  origin: "MAD",
  destination: "LIS",
  destinationName: "Lisbon",
  departDate: "2026-12-10",
  returnDate: "2026-12-17",
  priceEur,
  stops: 0,
  layover: null,
  travelHours: 1.3,
  bookingUrl: "https://www.kiwi.com/en/search/results/madrid-spain/lisbon-portugal",
  ...extra,
});
const note = (flightId: string, extra: Record<string, unknown> = {}) => ({
  flightId,
  weather: 4,
  crowd: "low",
  events: [],
  distortion: false,
  surf: 4,
  isolation: 3,
  personalFlag: "Quiet December week",
  reasoning: "Mild, dry forecast; off-season.",
  ...extra,
});

describe("/api/atlas gate", () => {
  it("refuses without the owner", async () => {
    expect((await call("GET", "/api/atlas/config", undefined, null)).status).toBe(401);
  });
});

describe("config", () => {
  it("serves defaults, deep-merges a patch and rejects an invalid one", async () => {
    const first = await call("GET", "/api/atlas/config");
    expect(first.body.config.hardFilters.maxStops).toBe(2);
    expect(first.body.updatedAt).toBeNull();

    const patched = await call("PATCH", "/api/atlas/config", { hardFilters: { maxStops: 1 }, windows: { a: { minDays: 10 } } });
    expect(patched.status).toBe(200);
    expect(patched.body.config.hardFilters.maxStops).toBe(1);
    expect(patched.body.config.hardFilters.maxTravelTimeHours).toBe(50);
    expect(patched.body.config.windows.a).toEqual({ minDays: 10, maxDays: 28 });

    const bad = await call("PATCH", "/api/atlas/config", { hardFilters: { maxStops: -1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_config");
  });
});

describe("wishlist", () => {
  it("resolves places by code, id and name, reports what it cannot, and keeps a wished place wished", async () => {
    const r = await call("POST", "/api/atlas/wishlist", {
      entries: [
        { place: { iata: "lis" }, intentTags: ["surf"], watch: { targetBudgetEur: { max: 120 } } },
        { place: { cityId: "madrid-spain" }, source: "scouted" },
        { place: { query: "Nowhere-at-all-xyz" } },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e: any) => e.cityId)).toEqual(["lisbon-portugal", "madrid-spain"]);
    expect(r.body.unresolved).toHaveLength(1);

    // A discovery run scouting Lisbon again must not demote it or drop its watch.
    await call("POST", "/api/atlas/wishlist", { entries: [{ place: { cityId: "lisbon-portugal" }, source: "scouted", intentTags: ["coastal"] }] });
    const list = await call("GET", "/api/atlas/wishlist");
    const lisbon = list.body.entries.find((e: any) => e.cityId === "lisbon-portugal");
    expect(lisbon.source).toBe("wished");
    expect(lisbon.watch).toMatchObject({ active: true, targetBudgetEur: { max: 120 } });
    expect(lisbon.intentTags).toEqual(["surf", "coastal"]);

    expect((await call("DELETE", "/api/atlas/wishlist/madrid-spain")).body.removed).toBe(true);
    expect((await call("GET", "/api/atlas/wishlist")).body.entries).toHaveLength(1);
  });
});

describe("context", () => {
  it("falls back to the configured airports with no rotation and adds season to each place", async () => {
    await call("POST", "/api/atlas/wishlist", { entries: [{ place: { cityId: "lisbon-portugal" }, avoidMonths: [8] }] });
    const r = await call("GET", "/api/atlas/context?today=2026-11-18");
    expect(r.status).toBe(200);
    expect(r.body.origin).toMatchObject({ source: "fallback", iata: "AGP" });
    expect(r.body.windows.a).toEqual({ from: "2026-12-02", to: "2026-12-16" });
    expect(r.body.windows.b).toEqual({ from: "2026-12-30", to: "2027-01-27" });
    const lisbon = r.body.wishlist[0];
    expect(lisbon.season.months.map((m: any) => m.month)).toEqual([12, 1]);
    expect(typeof lisbon.season.months[0].comfort).toBe("number");
    expect(lisbon.season.bestMonths).toHaveLength(3);
    expect(lisbon.season.bestMonths).not.toContain(8);
  });

  it("flies from where the rotation says the owner is", async () => {
    const stay = {
      stay: {
        place: { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS", lat: 38.72, lng: -9.14 },
        kind: "base",
        status: "booked",
        start: "2026-11-01",
        end: "2027-01-31",
      },
    };
    expect((await call("PUT", "/api/rotation/stays/s1", stay)).status).toBe(200);
    const r = await call("GET", "/api/atlas/context?today=2026-11-18");
    expect(r.body.origin).toMatchObject({ source: "rotation-current", iata: "LIS", stayId: "s1" });
    expect(r.body.rotation.current.cityId).toBe("lisbon-portugal");
  });
});

describe("seasonal", () => {
  it("ranks cities with an airport for the months asked", async () => {
    const r = await call("GET", "/api/atlas/seasonal?months=1,2&limit=5");
    expect(r.status).toBe(200);
    expect(r.body.cities).toHaveLength(5);
    const scores = r.body.cities.map((c: any) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(r.body.cities.every((c: any) => /^[A-Z]{3}$/.test(c.iata))).toBe(true);
  });

  it("rejects a bad month and an unknown profile", async () => {
    expect((await call("GET", "/api/atlas/seasonal?months=13")).status).toBe(400);
    expect((await call("GET", "/api/atlas/seasonal?months=1&profile=nope")).body.error).toBe("unknown_profile");
  });
});

describe("scans", () => {
  it("builds a baseline over runs, flags deals and watch hits, filters and gates", async () => {
    await call("POST", "/api/atlas/wishlist", { entries: [{ place: { iata: "LIS" }, intentTags: ["surf"], watch: { chatId: "42" } }] });

    // Three runs at 200 EUR make the route's baseline.
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/atlas/scans", { mode: "scheduled", origin: "MAD", flights: [flight(`f${i}`, 200)], annotations: [note(`f${i}`)] });
      expect(r.status).toBe(201);
      expect(r.body.scored[0].baseline.thin).toBe(true);
    }

    const r = await call("POST", "/api/atlas/scans", {
      mode: "scheduled",
      origin: "MAD",
      flights: [flight("cheap", 150), flight("stops", 90, { stops: 3 }), flight("event", 100, { departDate: "2026-12-20", returnDate: "2026-12-27" }), flight("peak", 160, { destination: "OPO", destinationName: "Porto" })],
      annotations: [note("cheap"), note("stops"), note("event", { distortion: true, distortionReason: "Festival" }), note("peak", { crowd: "peak" })],
    });
    expect(r.status).toBe(201);
    const cheap = r.body.scored.find((s: any) => s.flight.id === "cheap");
    expect(cheap.baseline).toMatchObject({ median: 200, count: 3, thin: false });
    expect(cheap.priceVsMedianPct).toBe(-25);
    expect(cheap.baselineDeal).toBe(true);
    expect(cheap.gates.passed).toBe(true);

    expect(r.body.rejected).toEqual([expect.objectContaining({ reasons: ["3 stops, limit 2"] })]);
    const event = r.body.scored.find((s: any) => s.flight.id === "event");
    expect(event.gates.passed).toBe(false);
    const peak = r.body.scored.find((s: any) => s.flight.id === "peak");
    expect(peak.gates.failures).toContain("peak crowds");

    expect(r.body.selection.top).toBe("cheap");
    expect(r.body.watchHits).toEqual([expect.objectContaining({ cityId: "lisbon-portugal", flightId: "cheap", chatId: "42" })]);

    // The distorted fare stays out of the baseline; the rejected one counts.
    const fares = await call("GET", "/api/atlas/fares?route=MAD-LIS");
    expect(fares.body.fares.map((f: any) => f.priceEur).sort()).toEqual([150, 200, 200, 200, 90]);

    const runs = await call("GET", "/api/atlas/runs?limit=2");
    expect(runs.body.runs[0]).toMatchObject({ kind: "scan", counts: { flights: 4, rejected: 1, watchHits: 1 } });
  });

  it("turns failed gates into warnings when asked to relax them", async () => {
    const r = await call("POST", "/api/atlas/scans", { mode: "query", origin: "MAD", relaxGates: true, flights: [flight("a", 150)], annotations: [note("a", { weather: 1 })] });
    expect(r.body.scored[0].gates).toEqual({ passed: true, failures: [], warnings: ["weather 1/5 under 3"] });
  });

  it("refuses a flight with no annotation", async () => {
    const r = await call("POST", "/api/atlas/scans", { mode: "scheduled", origin: "MAD", flights: [flight("a", 150)], annotations: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("missing_annotations");
  });
});

describe("discoveries", () => {
  const candidate = (place: object, extra: Record<string, unknown> = {}) => ({
    place,
    profileId: "surf",
    reason: "Winter swell, shoulder season",
    intentTags: ["surf"],
    weather: 4,
    conditions: 5,
    tourismSeason: 4,
    priceSignalEur: 120,
    priceSignalNote: "web estimate",
    ...extra,
  });

  it("scores, keeps the passing ones as scouted places and penalises a repeat", async () => {
    const first = await call("POST", "/api/atlas/discoveries", {
      activityTypes: ["surf"],
      origin: "MAD",
      candidates: [candidate({ iata: "LIS" }), candidate({ cityId: "madrid-spain" }, { weather: 1, conditions: 1, tourismSeason: 1, priceSignalEur: 2000 })],
    });
    expect(first.status).toBe(201);
    const [lis, mad] = first.body.scored;
    expect(lis).toMatchObject({ cityId: "lisbon-portugal", passed: true, repeatPenalty: false });
    expect(typeof lis.comfortNow).toBe("number");
    expect(mad.passed).toBe(false);
    const wl = await call("GET", "/api/atlas/wishlist");
    expect(wl.body.entries.map((e: any) => [e.cityId, e.source])).toEqual([["lisbon-portugal", "scouted"]]);

    const again = await call("POST", "/api/atlas/discoveries", { candidates: [candidate({ iata: "LIS" })] });
    expect(again.body.scored[0].repeatPenalty).toBe(true);
    expect(again.body.scored[0].composite).toBeCloseTo(lis.composite - 1.5, 2);
  });
});

describe("trips and notices", () => {
  it("creates a dated scouting trip that /api/trips serves, and replaces it on the same dates", async () => {
    const plan = {
      origin: { iata: "MAD" },
      destination: { iata: "LIS" },
      departDate: "2026-12-10",
      returnDate: "2026-12-14",
      flight: { priceEur: 150, bookingUrl: "https://www.kiwi.com/x", stops: 0, travelHours: 1.3 },
      stay: { name: "Casa do Mar", kind: "hotel", pricePerNightEur: 90, rating: 4.6, summary: "Quiet, near the river.", link: "https://example.com/casa" },
      activities: [{ date: "2026-12-11", time: "09:00", title: "Surf lesson in Carcavelos", costEur: 45, durationHours: 2, link: "https://www.viator.com/x" }],
      totals: { flightEur: 150, stayEur: 360, activitiesEur: 45, totalEur: 555 },
      notes: "Prices and availability checked 2026-11-18 08:00 UTC.",
    };
    const r = await call("POST", "/api/atlas/trips", plan);
    expect(r.status).toBe(201);
    expect(r.body.trip).toMatchObject({ id: "atlas-lisbon-portugal-2026-12-10", status: "scouting", year: 2026 });
    const stop = r.body.trip.nodes[0];
    expect(stop).toMatchObject({ cityId: "lisbon-portugal", arrive: "2026-12-10", depart: "2026-12-14", lodging: { name: "Casa do Mar", cost: { amount: 360, currency: "EUR" } } });
    expect(stop.activities[0]).toMatchObject({ title: "Surf lesson in Carcavelos", time: "09:00", note: "2 h" });
    expect(stop.notes).toContain("Book the flight: https://www.kiwi.com/x");
    expect(r.body.url).toBe("/#/trips/plan/atlas-lisbon-portugal-2026-12-10");

    await call("POST", "/api/atlas/trips", { ...plan, flight: { ...plan.flight, priceEur: 140 } });
    const trips = await call("GET", "/api/trips");
    expect(trips.body.trips).toHaveLength(1);
  });

  it("raises a notice once per content", async () => {
    const n = { kind: "digest", title: "Atlas: 2 places in season", body: "Lisbon 150 EUR, 25% under its median." };
    const a = await call("POST", "/api/atlas/notify", n);
    expect(a.status).toBe(201);
    expect(a.body.notice.kind).toBe("atlas-digest");
    expect((await call("POST", "/api/atlas/notify", n)).body.deduped).toBe(true);
    expect((await call("GET", "/api/notifications")).body.notices).toHaveLength(1);
  });
});

describe("import", () => {
  it("loads legacy config, wishlist and fares, skipping fares it already holds", async () => {
    const payload = {
      config: { hardFilters: { fallbackOrigins: ["LPA"] }, tripProfiles: [{ id: "surf", label: "Old surf", criteria: [] }] },
      wishlist: [{ place: { iata: "LIS" }, source: "scouted", intentTags: ["surf"] }],
      fares: [
        { origin: "MAD", destination: "LIS", priceEur: 100, departDate: "2026-05-10", snapshotDate: "2026-04-25" },
        { origin: "MAD", destination: "LIS", priceEur: 110, departDate: "2026-05-12", snapshotDate: "2026-04-25" },
      ],
    };
    const r = await call("POST", "/api/atlas/import", payload);
    expect(r.body).toEqual({ config: true, wishlist: { added: 1, unresolved: 0 }, fares: { added: 2, skipped: 0 } });
    expect((await call("POST", "/api/atlas/import", { fares: payload.fares })).body.fares).toEqual({ added: 0, skipped: 2 });
    const config = (await call("GET", "/api/atlas/config")).body.config;
    expect(config.hardFilters.fallbackOrigins).toEqual(["LPA"]);
    expect(config.tripProfiles[0]).toMatchObject({ id: "surf", label: "Old surf", vibes: ["coast", "tropical-coast"] });
    expect(config.tripProfiles.map((p: any) => p.id)).toContain("winter-sun");
    // Imported places are not "recently scouted".
    expect((await call("GET", "/api/atlas/context?today=2026-11-18")).body.recentlyScouted).toEqual([]);
  });
});
