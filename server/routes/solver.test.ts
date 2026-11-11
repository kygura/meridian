import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities } from "../lib/cities";
import rotation from "./rotation";
import solver from "./solver";
import { DEFAULT_SOLVER_SETTINGS } from "../../src/lib/solver/settings";

const TOKEN = "test-token";
const app = new Hono();
app.route("/api/rotation", rotation);
app.route("/api/solver", solver);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const lisbon = { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS", lat: 38.72, lng: -9.14 };

const settings = {
  ...DEFAULT_SOLVER_SETTINGS,
  months: 12,
  budgetMonthlyEur: 2200,
  pool: [
    { cityId: "lisbon-portugal", kind: "base" },
    { cityId: "tbilisi-georgia", kind: "base" },
    { cityId: "chiang-mai-thailand", kind: "base" },
    { cityId: "mexico-city-mexico", kind: "base" },
    { cityId: "bangkok-thailand", kind: "pass-through" },
  ],
};

beforeAll(() => loadCities());

describe("solver routes", () => {
  let TMP: string;
  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-solver-route-"));
    process.env.DATA_DIR = TMP;
    process.env.MERIDIAN_TOKEN = TOKEN;
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.MERIDIAN_TOKEN;
  });

  it("is owner-only", async () => {
    expect((await req("GET", "/api/solver/settings", undefined, null)).status).toBe(401);
    expect((await req("POST", "/api/solver/solve", { settings }, null)).status).toBe(401);
  });

  it("validates settings and stores them", async () => {
    expect((await req("PUT", "/api/solver/settings", { ...settings, months: 30 })).status).toBe(400);
    const r = await req("PUT", "/api/solver/settings", settings);
    expect(r.status).toBe(200);
    const got = await (await req("GET", "/api/solver/settings")).json();
    expect(got.settings.pool).toHaveLength(5);
  });

  it("asks where the owner starts when the rotation does not say", async () => {
    const r = await req("POST", "/api/solver/solve", { settings, start: "2027-01-01" });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/where you'll be/);
  });

  it("solves around a locked stay from real place data, then accepts a proposal", async () => {
    await req("PUT", "/api/rotation/stays/locked-1", { stay: { place: lisbon, kind: "base", status: "planned", start: "2027-03-01", end: "2027-04-15", locked: true } });
    await req("PUT", "/api/rotation/stays/old-idea", { stay: { place: lisbon, kind: "base", status: "planned", start: "2027-06-01", end: "2027-07-01" } });
    const r = await req("POST", "/api/solver/solve", { settings, start: "2027-01-01", fromCityId: "las-palmas-spain" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.proposals.length).toBeGreaterThanOrEqual(1);
    const best = body.proposals[0];
    const locked = best.stays.find((s: { id: string }) => s.id === "locked-1");
    expect(locked).toMatchObject({ start: "2027-03-01", end: "2027-04-15", role: "fixed" });
    // Cost figures come from the place data with their source named.
    const lis = best.stays.find((s: { cityId: string; costSource: string | null }) => s.cityId === "lisbon-portugal");
    expect(lis.costSource).toMatch(/estimate|Your/);

    // Swap re-scores the edited plan.
    const plan = { stays: best.stays.map((s: Record<string, unknown>) => ({ id: s.id, cityId: s.cityId, start: s.start, end: s.end, kind: s.kind, role: s.role })) };
    const ev = await (await req("POST", "/api/solver/evaluate", { settings, start: "2027-01-01", fromCityId: "las-palmas-spain", plan })).json();
    expect(ev.rotation.total).toBeCloseTo(best.total, 5);

    const acc = await (await req("POST", "/api/solver/accept", { plan, runId: "run1" })).json();
    expect(acc.removed.map((x: { id: string }) => x.id)).toEqual(["old-idea"]);
    expect(acc.added.length).toBe(best.stays.filter((s: { role: string }) => s.role !== "fixed").length);
    const rot = await (await req("GET", "/api/rotation?today=2026-11-10")).json();
    expect(rot.stays.find((s: { id: string }) => s.id === "locked-1")).toBeTruthy();
    expect(rot.stays.filter((s: { origin?: { kind: string } }) => s.origin?.kind === "solver").every((s: { status: string }) => s.status === "planned")).toBe(true);
  });
});
