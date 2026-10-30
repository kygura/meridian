import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { gateRoutes } from "../middleware/auth";
import watches, { setWatchDepsFactory } from "./watches";
import type { Alert, ReplayQuery, ReplayResponse, Watch } from "../../src/types";

const TOKEN = "test-token";
let TMP: string;

const app = new Hono();
gateRoutes(app);
app.route("/api/watches", watches);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const QUERY: ReplayQuery = { template: { journeyId: "j1" }, bend: {}, weights: { climate: 1, spend: 0.5, crowd: 0.5, flight: 0.5 } };
const NOW = new Date("2026-10-30T12:00:00Z");
const replayResponse: ReplayResponse = {
  universeSize: 1,
  template: {},
  results: [{ cityId: "lisbon-portugal", month: 12, match: 90, dims: [], scoredOn: [], visitedBefore: false, price: { priceAmount: 80, currency: "EUR", source: "serpapi", priceEur: 80, baselineEur: 150 } }],
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-watches-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  setWatchDepsFactory(() => ({ now: () => NOW, replay: async () => replayResponse }));
});
afterEach(() => {
  setWatchDepsFactory();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("401 without a valid token on every watches route", async () => {
    const routes: [string, string][] = [
      ["POST", "/api/watches"],
      ["GET", "/api/watches"],
      ["POST", "/api/watches/run"],
      ["GET", "/api/watches/alerts"],
      ["POST", "/api/watches/alerts/x/seen"],
      ["DELETE", "/api/watches/x"],
    ];
    for (const [m, p] of routes) {
      expect((await req(m, p, undefined, null)).status, `${m} ${p}`).toBe(401);
      expect((await req(m, p, undefined, "wrong")).status, `${m} ${p} wrong`).toBe(401);
    }
  });
  it("fails closed when MERIDIAN_TOKEN is unset", async () => {
    delete process.env.MERIDIAN_TOKEN;
    const res = await req("GET", "/api/watches");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "journal_locked" });
  });
});

describe("CRUD", () => {
  it("POST 201, GET lists, DELETE removes (404 when gone)", async () => {
    const created = await req("POST", "/api/watches", { label: "Lisbon-like", query: QUERY });
    expect(created.status).toBe(201);
    const { watch } = (await created.json()) as { watch: Watch };
    expect(watch).toMatchObject({ leadWeeks: [6, 14], active: true });
    expect(((await (await req("GET", "/api/watches")).json()) as { watches: Watch[] }).watches).toHaveLength(1);
    expect((await req("DELETE", `/api/watches/${watch.id}`)).status).toBe(200);
    expect((await req("DELETE", `/api/watches/${watch.id}`)).status).toBe(404);
  });

  it("400 on invalid bodies", async () => {
    expect((await req("POST", "/api/watches", { label: "x", query: QUERY, leadWeeks: [10, 5] })).status).toBe(400);
    expect((await req("POST", "/api/watches", { label: "x", query: QUERY, priceRule: { maxEur: -3 } })).status).toBe(400);
    expect((await req("POST", "/api/watches", { query: QUERY })).status).toBe(400);
    expect((await req("POST", "/api/watches", undefined)).status).toBe(400);
  });
});

describe("run + alerts", () => {
  it("run reports new alerts, is idempotent per day; alerts list newest-first with ?unseen=1 and /seen", async () => {
    await req("POST", "/api/watches", { label: "w", query: QUERY });
    const r1 = (await (await req("POST", "/api/watches/run")).json()) as { watches: number; alerts: Alert[]; evaluated: number; skipped: number };
    expect(r1).toMatchObject({ watches: 1, evaluated: 1, skipped: 0 });
    expect(r1.alerts).toHaveLength(1);
    const r2 = (await (await req("POST", "/api/watches/run")).json()) as { alerts: Alert[] };
    expect(r2.alerts).toHaveLength(0);

    // /alerts is not swallowed by /:id
    const list = (await (await req("GET", "/api/watches/alerts")).json()) as { alerts: Alert[] };
    expect(list.alerts).toHaveLength(1);
    const id = list.alerts[0]!.id;
    expect((await req("POST", `/api/watches/alerts/${id}/seen`)).status).toBe(200);
    expect(((await (await req("GET", "/api/watches/alerts?unseen=1")).json()) as { alerts: Alert[] }).alerts).toHaveLength(0);
    expect(((await (await req("GET", "/api/watches/alerts")).json()) as { alerts: Alert[] }).alerts[0]!.seen).toBe(true);
    expect((await req("POST", "/api/watches/alerts/nope/seen")).status).toBe(404);
  });
});
