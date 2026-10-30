import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities } from "../lib/cities";
import { setFxFetch } from "../lib/fx";
import { gateRoutes } from "../middleware/auth";
import journal from "./journal";

const TOKEN = "test-token";
let TMP: string;

// Same wiring as server/index.ts (index.ts starts a listener on import).
const app = new Hono();
gateRoutes(app);
app.route("/api/journal", journal);

const TRIP = {
  title: "Lisbon & Porto",
  startDate: "2024-05-02",
  endDate: "2024-05-09",
  stops: [
    { cityId: "lisbon-portugal", arrive: "2024-05-02", depart: "2024-05-06" },
    { cityId: "porto-portugal", arrive: "2024-05-06", depart: "2024-05-09" },
  ],
  segments: [
    { mode: "flight", fromCityId: "london-united-kingdom", toCityId: "lisbon-portugal", departAt: "2024-05-02", cost: { amount: 120, currency: "USD" } },
    { mode: "flight", fromCityId: "porto-portugal", toCityId: "london-united-kingdom", departAt: "2024-05-09" },
  ],
};

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeAll(() => loadCities());

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-journal-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 0.9 } }) }));
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
});

describe("auth", () => {
  it("401 journal_locked when MERIDIAN_TOKEN is unset", async () => {
    delete process.env.MERIDIAN_TOKEN;
    const res = await req("GET", "/api/journal");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "journal_locked", reason: "token_not_configured" });
  });

  it("401 on missing or wrong token, for /api/journal and sub-paths", async () => {
    for (const path of ["/api/journal", "/api/journal/x", "/api/journal/settings"]) {
      expect((await req("GET", path, undefined, null)).status, path).toBe(401);
      expect((await req("GET", path, undefined, "wrong")).status, path).toBe(401);
    }
    expect((await req("POST", "/api/journal", TRIP, null)).status).toBe(401);
  });

  it("the route module gates itself even when mounted bare", async () => {
    expect((await journal.request("/")).status).toBe(401);
  });

  it("200 with the right token", async () => {
    const res = await req("GET", "/api/journal");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ journeys: [] });
  });
});

describe("CRUD", () => {
  it("create → get → list → edit → delete", async () => {
    const created = await req("POST", "/api/journal", TRIP);
    expect(created.status).toBe(201);
    const { journey } = await created.json();
    expect(journey.status).toBe("confirmed");
    expect(journey.segments[0].cost).toEqual({ amount: 120, currency: "USD", eur: 108, rateDate: "2024-05-02" });

    expect((await (await req("GET", `/api/journal/${journey.id}`)).json()).journey.title).toBe("Lisbon & Porto");
    expect((await (await req("GET", "/api/journal?year=2024")).json()).journeys).toHaveLength(1);
    expect((await (await req("GET", "/api/journal?year=2023")).json()).journeys).toHaveLength(0);

    const put = await req("PUT", `/api/journal/${journey.id}`, { ...TRIP, title: "Portugal", tags: ["food"] });
    expect(put.status).toBe(200);
    expect((await put.json()).journey).toMatchObject({ id: journey.id, title: "Portugal", tags: ["food"] });
    expect((await (await req("GET", "/api/journal?tag=food")).json()).journeys).toHaveLength(1);

    expect((await req("DELETE", `/api/journal/${journey.id}`)).status).toBe(200);
    expect((await req("GET", `/api/journal/${journey.id}`)).status).toBe(404);
  });

  it("404 for unknown ids on GET/PUT/DELETE", async () => {
    expect((await req("GET", "/api/journal/nope")).status).toBe(404);
    expect((await req("PUT", "/api/journal/nope", TRIP)).status).toBe(404);
    expect((await req("DELETE", "/api/journal/nope")).status).toBe(404);
  });

  it("ignores server-owned fields in the body", async () => {
    const { journey } = await (await req("POST", "/api/journal", { ...TRIP, id: "mine", createdAt: "1999", fingerprint: { x: 1 } })).json();
    expect(journey.id).not.toBe("mine");
    expect(journey.createdAt).not.toBe("1999");
    expect(journey.fingerprint).toBeUndefined();
  });
});

describe("validation", () => {
  it("400 with zod issues on a bad body", async () => {
    for (const body of [null, {}, { ...TRIP, stops: [] }, { ...TRIP, segments: [{ ...TRIP.segments[0], mode: "teleport" }] }, { ...TRIP, rating: 7 }]) {
      const res = await req("POST", "/api/journal", body);
      expect(res.status).toBe(400);
      expect(Array.isArray((await res.json()).issues)).toBe(true);
    }
  });

  it("400 on unknown cities and out-of-order dates", async () => {
    const res = await req("POST", "/api/journal", { ...TRIP, stops: [{ cityId: "atlantis-nowhere", arrive: "2024-05-02", depart: "2024-05-09" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0].path).toEqual(["stops", 0, "cityId"]);
    expect((await req("POST", "/api/journal", { ...TRIP, endDate: "2024-05-01" })).status).toBe(400);
  });

  it("400 on a bad list query", async () => {
    expect((await req("GET", "/api/journal?year=abc")).status).toBe(400);
  });

  it("422 when no FX rate is available", async () => {
    setFxFetch(async () => { throw new Error("offline"); });
    const res = await req("POST", "/api/journal", TRIP);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("fx_unavailable");
  });
});

describe("settings", () => {
  it("GET/PUT /api/journal/settings", async () => {
    expect(await (await req("GET", "/api/journal/settings")).json()).toEqual({ settings: {} });
    const put = await req("PUT", "/api/journal/settings", { homeCityId: "london-united-kingdom" });
    expect(put.status).toBe(200);
    expect(await (await req("GET", "/api/journal/settings")).json()).toEqual({ settings: { homeCityId: "london-united-kingdom" } });
    expect((await req("PUT", "/api/journal/settings", { homeCityId: "atlantis-nowhere" })).status).toBe(400);
    expect((await req("PUT", "/api/journal/settings", { homeCityId: 5 })).status).toBe(400);
  });
});
