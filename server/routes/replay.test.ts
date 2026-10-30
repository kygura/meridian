import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "fs";
import { resetSeasonalityCache } from "../lib/seasonality";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities, getCityById } from "../lib/cities";
import { setFxFetch } from "../lib/fx";
import { gateRoutes } from "../middleware/auth";
import { registerJournalFingerprint, setFingerprintDepsFactory } from "../lib/journalFingerprint";
import { fixtureFingerprintDeps } from "../lib/__fixtures__/journal";
import type { FingerprintDeps } from "../lib/fingerprint";
import journal from "./journal";
import replay from "./replay";
import type { Fingerprint, Journey, ReplayResponse } from "../../src/types";

const TOKEN = "test-token";
let TMP: string;
let unregister: () => void;
const savedKeys = { DUFFEL_API_KEY: process.env.DUFFEL_API_KEY, SERPAPI_KEY: process.env.SERPAPI_KEY };

const app = new Hono();
gateRoutes(app);
app.route("/api/journal", journal);
app.route("/api/replay", replay);

const LISBON = {
  title: "Lisbon, May 2024",
  startDate: "2024-05-10",
  endDate: "2024-05-17",
  companions: 2,
  rating: 5,
  tags: ["city"],
  stops: [
    {
      cityId: "lisbon-portugal",
      arrive: "2024-05-10",
      depart: "2024-05-17",
      rating: 5,
      lodging: { name: "Alfama flat", provenance: { source: "manual", confidence: "high" }, cost: { amount: 700, currency: "EUR" } },
    },
  ],
  segments: [
    { mode: "flight", fromCityId: "berlin-germany", toCityId: "lisbon-portugal", departAt: "2024-05-10", cost: { amount: 180, currency: "EUR" }, provenance: { source: "manual", confidence: "high" } },
  ],
  experiences: [],
  bookingIds: [],
  provenance: { source: "manual", confidence: "high" },
};

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

let fpCalls: string[] = [];
function useFixtureFingerprints(opts: Parameters<typeof fixtureFingerprintDeps>[0] = {}) {
  setFingerprintDepsFactory(() => {
    const f = fixtureFingerprintDeps(opts);
    fpCalls = f.calls;
    // Real city DB (the journal validates against it), fixture weather/holidays.
    return { ...f.deps, getCity: getCityById } satisfies FingerprintDeps;
  });
}

async function createLisbon(): Promise<Journey> {
  const res = await req("POST", "/api/journal", LISBON);
  expect(res.status).toBe(201);
  return ((await res.json()) as { journey: Journey }).journey;
}

const QUERY = (journeyId: string, over: Record<string, unknown> = {}) => ({
  template: { journeyId },
  weights: { climate: 1, spend: 0.5, crowd: 0.5, flight: 0.5 },
  limit: 100,
  ...over,
});

beforeAll(() => {
  loadCities();
  unregister = registerJournalFingerprint();
});
afterAll(() => {
  unregister();
  setFingerprintDepsFactory();
});

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-replay-route-"));
  process.env.DATA_DIR = TMP;
  // Seasonality resolves under DATA_DIR: use the committed seed dataset.
  copyFileSync(join(process.cwd(), "data", "seasonality.json"), join(TMP, "seasonality.json"));
  resetSeasonalityCache();
  process.env.MERIDIAN_TOKEN = TOKEN;
  delete process.env.DUFFEL_API_KEY;
  delete process.env.SERPAPI_KEY;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-10", rates: { EUR: 0.9 } }) }));
  useFixtureFingerprints();
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
  resetSeasonalityCache();
  for (const [k, v] of Object.entries(savedKeys)) if (v !== undefined) process.env[k] = v;
});

describe("fingerprint on save", () => {
  it("the save listener fills the journey and stop fingerprints", async () => {
    const j = await createLisbon();
    expect(j.fingerprint?.month).toBe(5);
    expect(j.fingerprint?.tempC).toBe(19.2);
    expect(j.fingerprint?.status.tempC).toBe("ok");
    expect(j.stops[0]!.observed?.normalTempC).toBe(18.5);
    expect(j.stops[0]!.fingerprint?.dailySpendEur).toBe(50); // 700 / 7 / 2
  });

  it("a slow weather fetch never blocks the save past the budget (weather pending)", async () => {
    setFingerprintDepsFactory(() => {
      const f = fixtureFingerprintDeps();
      return { ...f.deps, getCity: getCityById, observedWeather: () => new Promise(() => {}) };
    }, 50);
    const j = await createLisbon();
    expect(j.fingerprint?.status.tempC).toBe("pending");
    expect(j.fingerprint?.status.dailySpendEur).toBe("ok");
  });
});

describe("GET /api/journal/:id/fingerprint", () => {
  it("is stable across two calls", async () => {
    const j = await createLisbon();
    const a = (await (await req("GET", `/api/journal/${j.id}/fingerprint`)).json()) as { fingerprint: Fingerprint; status: Fingerprint["status"]; stops: { index: number; fingerprint: Fingerprint }[] };
    const b = (await (await req("GET", `/api/journal/${j.id}/fingerprint`)).json()) as typeof a;
    expect(a.fingerprint.inputsHash).toBe(b.fingerprint.inputsHash);
    expect(a).toEqual(b);
    expect(a.status.comfort).toBe("ok");
    expect(a.stops[0]!.index).toBe(0);
  });

  it("recomputes and persists pending dims once the weather is available", async () => {
    useFixtureFingerprints({ weather: "quota" });
    const j = await createLisbon();
    expect(j.fingerprint?.status.tempC).toBe("pending");
    useFixtureFingerprints();
    const r = (await (await req("GET", `/api/journal/${j.id}/fingerprint`)).json()) as { fingerprint: Fingerprint };
    expect(r.fingerprint.status.tempC).toBe("ok");
    const stored = (await (await req("GET", `/api/journal/${j.id}`)).json()) as { journey: Journey };
    expect(stored.journey.fingerprint?.tempC).toBe(19.2);
    expect(fpCalls.some((u) => u.includes("archive-api"))).toBe(true);
  });

  it("404s an unknown journey", async () => {
    expect((await req("GET", "/api/journal/nope/fingerprint")).status).toBe(404);
  });
});

describe("POST /api/replay", () => {
  it("401 without a token", async () => {
    expect((await req("POST", "/api/replay", QUERY("x"), null)).status).toBe(401);
  });

  it("400 on a bad body", async () => {
    const res = await req("POST", "/api/replay", { template: { journeyId: "x" }, weights: { climate: 2, spend: 0, crowd: 0, flight: 0 } });
    expect(res.status).toBe(400);
    const bad = await req("POST", "/api/replay", { ...QUERY("x"), bend: { tempC: 30 } });
    expect(bad.status).toBe(400);
    const badMonth = await req("POST", "/api/replay", { ...QUERY("x"), constraints: { months: [0] } });
    expect(badMonth.status).toBe(400);
  });

  it("404 template_not_found", async () => {
    const res = await req("POST", "/api/replay", QUERY("missing"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("template_not_found");
  });

  it("ranks with scoredOn + universeSize; bend is optional; keyless → mock prices", async () => {
    const j = await createLisbon();
    await req("PUT", "/api/journal/settings", { homeCityId: "berlin-germany" });
    const res = await req("POST", "/api/replay", QUERY(j.id));
    expect(res.status).toBe(200);
    const r = (await res.json()) as ReplayResponse;
    expect(r.universeSize).toBeGreaterThanOrEqual(100);
    expect(r.fromCityId).toBe("berlin-germany");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.scoredOn).toContain("tempC");
    const priced = r.results.filter((x) => x.price);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.every((x) => x.price!.source === "mock" && !x.scoredOn.includes("flightCostEurPer1000km"))).toBe(true);
    expect(r.grid?.length).toBeGreaterThan(0);
  });

  it("bend tempC +3 changes the ordering", async () => {
    const j = await createLisbon();
    const order = async (bend: object) =>
      ((await (await req("POST", "/api/replay", QUERY(j.id, { bend }))).json()) as ReplayResponse).results.map((x) => `${x.cityId}:${x.month}`);
    const a = await order({});
    const b = await order({ tempC: 3 });
    expect(a).not.toEqual(b);
  });

  it("recomputes a stale template fingerprint before ranking", async () => {
    useFixtureFingerprints({ weather: "quota" });
    const j = await createLisbon();
    useFixtureFingerprints();
    const r = (await (await req("POST", "/api/replay", QUERY(j.id))).json()) as ReplayResponse;
    expect(r.template.tempC).toBe(19.2);
  });
});
