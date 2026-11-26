import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { City } from "../../src/types";
import {
  AIR_WEIGHT,
  SKY_END,
  SKY_START,
  SKY_WEIGHT,
  SKY_WINDOW,
  WEATHER_WEIGHT,
  cellFromWeather,
  planBackfill,
  runBackfill,
  waitFor,
  weightOf,
  withAir,
  withSky,
  type ClimateSink,
} from "./climateBackfill";
import { cellKeyFor, decodeMonths, decodeWeeks, type ClimateCell } from "./climateNormals";

const city = (id: string, lat: number, lng: number, population: number, extra: Partial<City> = {}): City => ({ id, name: id, lat, lng, country: "X", population, ...extra });

const LIMITS = { minutely: 100_000, hourly: 100_000, daily: 100_000 };

/** A fake Open-Meteo: ten years of daily weather, three years of hourly air, three years of daily sunshine. */
function fakeApi(opts: { airFails?: boolean; skyFails?: boolean; limitAfter?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    if (opts.limitAfter !== undefined && calls.length > opts.limitAfter) {
      return { ok: false, status: 429, json: async () => ({ error: true, reason: "Hourly API request limit exceeded. Please try again in the next hour." }) } as unknown as Response;
    }
    if (url.includes("air-quality-api")) {
      if (opts.airFails) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      const time: string[] = [];
      for (let y = 2023; y <= 2025; y++) for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = new Date(d.getTime() + 86_400_000)) for (let h = 0; h < 24; h++) time.push(`${d.toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:00`);
      return { ok: true, status: 200, json: async () => ({ hourly: { time, pm2_5: time.map((t) => (t.slice(5, 7) === "03" ? 60 : 8)) } }) } as unknown as Response;
    }
    if (url.includes("daily=sunshine_duration")) {
      if (opts.skyFails) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      const time: string[] = [];
      for (let y = 2022; y <= 2024; y++) for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = new Date(d.getTime() + 86_400_000)) time.push(d.toISOString().slice(0, 10));
      // 3 h of sun a day in March, 9 h otherwise (seconds, as Open-Meteo reports it)
      return { ok: true, status: 200, json: async () => ({ daily: { time, sunshine_duration: time.map((t) => (t.slice(5, 7) === "03" ? 10_800 : 32_400)) } }) } as unknown as Response;
    }
    const time: string[] = [];
    for (let y = 2015; y <= 2024; y++) for (let d = new Date(Date.UTC(y, 0, 1)); d.getUTCFullYear() === y; d = new Date(d.getTime() + 86_400_000)) time.push(d.toISOString().slice(0, 10));
    return {
      ok: true,
      status: 200,
      json: async () => ({ daily: { time, temperature_2m_max: time.map(() => 26), temperature_2m_min: time.map(() => 18), precipitation_sum: time.map(() => 2) } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function memorySink(initial: Record<string, ClimateCell> = {}): ClimateSink & { cells: Record<string, ClimateCell> } {
  const cells = { ...initial };
  return { cells, get: (k) => cells[k], save: (k, c) => void (cells[k] = c) };
}

describe("quota arithmetic", () => {
  it("weighs a call by variables and days like Open-Meteo does", () => {
    expect(weightOf(3, 3653)).toBeCloseTo(78.3, 1);
    expect(weightOf(10, 14)).toBe(1);
    expect(WEATHER_WEIGHT).toBeCloseTo(78.3, 1);
    expect(AIR_WEIGHT).toBeCloseTo(7.9, 1);
    expect(SKY_WEIGHT).toBeCloseTo(7.9, 1); // one variable, 3 years: 1/10 x 1096/14
  });

  it("waits until enough old calls age out of the hour, and never for a call that can't fit", () => {
    const now = 10_000_000;
    const ledger = { spent: [[now - 3_000_000, 60], [now - 600_000, 30]] as Array<[number, number]> };
    const limits = { minutely: 1000, hourly: 100, daily: 1000 };
    expect(waitFor(ledger, now, 5, limits)).toBe(0); // 90 used, 5 fits
    expect(waitFor(ledger, now, 20, limits)).toBe(3_600_000 - 3_000_000 + 1000); // the 60 must age out
    expect(waitFor(ledger, now, 500, limits)).toBe(Infinity);
    expect(waitFor({ spent: [], blockedUntil: now + 5000 }, now, 1, limits)).toBe(5000);
  });
});

describe("planBackfill", () => {
  const cities = [
    city("big", 10.0, 10.0, 5_000_000),
    city("twin", 10.05, 10.05, 1000), // same 0.25 degree cell as "big"
    city("capital", 20, 20, 100, { capital: true }),
    city("small", 30, 30, 900_000),
    city("seeded", 40, 40, 10),
  ];

  it("dedupes cities that share a climate cell and queries the most populous", () => {
    const plan = planBackfill(cities, {});
    expect(plan).toHaveLength(4);
    const cell = plan.find((p) => p.key === cellKeyFor(10, 10))!;
    expect(cell.cityCount).toBe(2);
    expect(cell.rep.id).toBe("big");
  });

  it("orders seed cities, then capitals, then the rest by population", () => {
    const plan = planBackfill(cities, {}, { seedIds: new Set(["seeded"]) });
    expect(plan.map((p) => p.rep.id)).toEqual(["seeded", "capital", "big", "small"]);
    expect(planBackfill(cities, {}, { firstIds: new Set(["small"]) })[0]!.rep.id).toBe("small");
  });

  it("does air quality alone for a cell that has weather, then the oldest stale cells last", () => {
    const week = { t: Array(52).fill(1), p: Array(52).fill(1) };
    const m = { t: Array(12).fill(1), p: Array(12).fill(1) };
    const cells: Record<string, ClimateCell> = {
      [cellKeyFor(10, 10)]: { at: "2026-06-01", m, w: week }, // weather fresh, no air
      [cellKeyFor(20, 20)]: { at: "2020-01-01", aq: "2020-01-01", sq: "2020-01-01", m, w: week }, // stale
      [cellKeyFor(30, 30)]: { at: "2019-01-01", aq: "2019-01-01", sq: "2019-01-01", m, w: week }, // staler
      [cellKeyFor(40, 40)]: { at: "2026-06-01", aq: "2026-06-01", sq: "2026-06-01", m, w: week }, // complete
    };
    const plan = planBackfill(cities, cells, { today: "2026-11-10" });
    expect(plan.map((p) => [p.rep.id, p.needsWeather, p.needsAir])).toEqual([
      ["big", false, true],
      ["small", true, true],
      ["capital", true, true],
    ]);
  });

  it("plans sunshine alone, after the air and stale gaps, for a cell with weather and air but no `s`", () => {
    const week = { t: Array(52).fill(1), p: Array(52).fill(1) };
    const m = { t: Array(12).fill(1), p: Array(12).fill(1) };
    const cells: Record<string, ClimateCell> = {
      [cellKeyFor(10, 10)]: { at: "2026-06-01", aq: "2026-06-01", m, w: week }, // weather + air, no sky
      [cellKeyFor(20, 20)]: { at: "2026-06-01", m, w: week }, // no air, no sky
      [cellKeyFor(30, 30)]: { at: "2020-01-01", aq: "2020-01-01", sq: "2020-01-01", m, w: week }, // stale
      [cellKeyFor(40, 40)]: { at: "2026-06-01", aq: "2026-06-01", m: { ...m, s: Array(12).fill(70) }, w: week }, // has s: complete
    };
    const plan = planBackfill(cities, cells, { today: "2026-11-10" });
    expect(plan.map((p) => [p.rep.id, p.needsWeather, p.needsAir, p.needsSky])).toEqual([
      ["capital", false, true, true], // air gap first
      ["small", true, true, true], // then stale
      ["big", false, false, true], // then sky alone
    ]);
    const sky = plan.find((p) => p.rep.id === "big")!;
    // dry-run arithmetic: a sky-only cell costs exactly SKY_WEIGHT
    expect((sky.needsWeather ? WEATHER_WEIGHT : 0) + (sky.needsAir ? AIR_WEIGHT : 0) + (sky.needsSky ? SKY_WEIGHT : 0)).toBe(SKY_WEIGHT);
  });

  it("treats a cell with months but no weekly profile as a gap", () => {
    const cells = { [cellKeyFor(10, 10)]: { at: "2026-11-01", aq: "2026-11-01", m: { t: Array(12).fill(1), p: Array(12).fill(1) } } };
    expect(planBackfill([city("big", 10, 10, 1)], cells, { today: "2026-11-10" })[0]!.needsWeather).toBe(true);
  });
});

describe("cell building", () => {
  it("builds months, weeks and air from fetched series", async () => {
    const { fetchFn } = fakeApi();
    const { fetchWeatherDaily, fetchAirDaily } = await import("./climateBackfill");
    const w = await fetchWeatherDaily(10, 10, fetchFn);
    const a = await fetchAirDaily(10, 10, fetchFn);
    if (!w.ok || !a.ok) throw new Error("fake api failed");
    const cell = withAir(cellFromWeather(w.data, "2026-11-10"), a.data, "2026-11-10");
    const before = decodeMonths(cell)!;
    expect(before[0]).not.toHaveProperty("sunH");
    const months = decodeMonths(cell)!;
    expect(months[0]).toMatchObject({ tempC: 22, precipMm: 62, pm25: 8 });
    expect(months[2]!.pm25).toBe(60); // March
    expect(months[2]!.score).toBeLessThan(months[0]!.score);
    const weeks = decodeWeeks(cell)!;
    expect(weeks).toHaveLength(52);
    expect(weeks[0]).toMatchObject({ tempC: 22, precipMm: 14, pm25: 8 });
    expect(cell.at).toBe("2026-11-10");
    expect(cell.aq).toBe("2026-11-10");
  });

  it("adds sunshine hours a day (monthly and weekly) and keeps them through a weather refresh", async () => {
    const { fetchFn } = fakeApi();
    const { fetchWeatherDaily, fetchSkyDaily } = await import("./climateBackfill");
    const w = await fetchWeatherDaily(10, 10, fetchFn);
    const s = await fetchSkyDaily(10, 10, fetchFn);
    if (!w.ok || !s.ok) throw new Error("fake api failed");
    const cell = withSky(cellFromWeather(w.data, "2026-11-10"), s.data, "2026-11-10");
    expect(cell.sq).toBe("2026-11-10");
    expect(cell.m!.s).toHaveLength(12);
    expect(cell.m!.s![0]).toBe(90); // 9 h x10
    expect(cell.m!.s![2]).toBe(30); // March: 3 h
    expect(cell.w!.s).toHaveLength(52);
    const months = decodeMonths(cell)!;
    expect(months[0]).toMatchObject({ sunH: 9 });
    expect(months[2]).toMatchObject({ sunH: 3 });
    expect(months[2]!.score).toBeLessThan(months[0]!.score);
    expect(decodeWeeks(cell)![0]).toMatchObject({ sunH: 9 });
    const refreshed = cellFromWeather(w.data, "2027-01-01", cell);
    expect(refreshed.m!.s).toEqual(cell.m!.s);
    expect(refreshed.w!.s).toEqual(cell.w!.s);
    expect(refreshed.sq).toBe("2026-11-10");
  });

  it("asks the archive API for sunshine_duration alone over the 2022-2024 window, converting seconds to hours", async () => {
    const { fetchFn, calls } = fakeApi();
    const { fetchSkyDaily } = await import("./climateBackfill");
    const r = await fetchSkyDaily(-12.0464, -77.0428, fetchFn);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(url.searchParams.get("daily")).toBe("sunshine_duration");
    expect(url.searchParams.get("start_date")).toBe(SKY_START);
    expect(url.searchParams.get("end_date")).toBe(SKY_END);
    expect([SKY_START, SKY_END, SKY_WINDOW]).toEqual(["2022-01-01", "2024-12-31", "2022-2024"]);
    expect(url.searchParams.get("latitude")).toBe("-12.0464");
    if (!r.ok) throw new Error("fake api failed");
    expect(r.data[0]).toEqual({ date: "2022-01-01", v: 9 });
  });

  it("fails cleanly on a response without sunshine data", async () => {
    const { fetchSkyDaily } = await import("./climateBackfill");
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ daily: { time: ["2022-01-01"] } }) })) as unknown as typeof fetch;
    expect(await fetchSkyDaily(0, 0, fetchFn)).toMatchObject({ ok: false, reason: "bad" });
  });
});

describe("runBackfill", () => {
  beforeEach(() => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "meridian-backfill-"));
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  const noSleep = async () => undefined;
  const cities = [city("a", 10, 10, 300), city("b", 20, 20, 200), city("c", 30, 30, 100)];

  it("fetches weather, air and sunshine for each gap and saves every cell as it lands", async () => {
    const { fetchFn, calls } = fakeApi();
    const sink = memorySink();
    const res = await runBackfill({ sink, plan: planBackfill(cities, {}), runBudget: 1e6, limits: LIMITS, fetchFn, sleep: noSleep });
    expect(res.cellsCompleted).toBe(3);
    expect(res.stoppedBy).toBe("done");
    expect(calls).toHaveLength(9);
    expect(Object.keys(sink.cells)).toHaveLength(3);
    expect(sink.cells[cellKeyFor(10, 10)]!.aq).toBeDefined();
    expect(sink.cells[cellKeyFor(10, 10)]!.sq).toBeDefined();
    expect(sink.cells[cellKeyFor(10, 10)]!.m!.s).toHaveLength(12);
    expect(res.spent).toBeCloseTo(3 * (WEATHER_WEIGHT + AIR_WEIGHT + SKY_WEIGHT), 5);
  });

  it("stops at the per-run budget and resumes where it left off", async () => {
    const sink = memorySink();
    const one = WEATHER_WEIGHT + AIR_WEIGHT + SKY_WEIGHT;
    const first = await runBackfill({ sink, plan: planBackfill(cities, sink.cells), runBudget: one * 1.5, limits: LIMITS, fetchFn: fakeApi().fetchFn, sleep: noSleep });
    expect(first.stoppedBy).toBe("run-budget");
    expect(first.cellsCompleted).toBe(1);

    const second = fakeApi();
    const rest = await runBackfill({ sink, plan: planBackfill(cities, sink.cells), runBudget: 1e6, limits: LIMITS, fetchFn: second.fetchFn, sleep: noSleep });
    expect(rest.cellsCompleted).toBe(2);
    expect(second.calls).toHaveLength(6); // the finished cell is not fetched again
  });

  it("keeps weather when air quality fails, and completes only the air next time", async () => {
    const sink = memorySink();
    await runBackfill({ sink, plan: planBackfill(cities.slice(0, 1), {}), runBudget: 1e6, limits: LIMITS, fetchFn: fakeApi({ airFails: true }).fetchFn, sleep: noSleep });
    const cell = sink.cells[cellKeyFor(10, 10)]!;
    expect(cell.m).toBeDefined();
    expect(cell.aq).toBeUndefined();

    const plan = planBackfill(cities.slice(0, 1), sink.cells);
    expect(plan[0]).toMatchObject({ needsWeather: false, needsAir: true, needsSky: true });
    const api = fakeApi();
    await runBackfill({ sink, plan, runBudget: 1e6, limits: LIMITS, fetchFn: api.fetchFn, sleep: noSleep });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]).toContain("air-quality-api");
    expect(api.calls[1]).toContain("sunshine_duration");
    expect(sink.cells[cellKeyFor(10, 10)]!.aq).toBeDefined();
  });

  it("keeps weather and air when sunshine fails, writes no sky, and fetches only sunshine next time", async () => {
    const sink = memorySink();
    const res = await runBackfill({ sink, plan: planBackfill(cities.slice(0, 1), {}), runBudget: 1e6, limits: LIMITS, fetchFn: fakeApi({ skyFails: true }).fetchFn, sleep: noSleep });
    const cell = sink.cells[cellKeyFor(10, 10)]!;
    expect(cell.m).toBeDefined();
    expect(cell.aq).toBeDefined();
    expect(cell.sq).toBeUndefined();
    expect(cell.m!.s).toBeUndefined();
    expect(res.lastError).toContain("sky");

    const plan = planBackfill(cities.slice(0, 1), sink.cells);
    expect(plan[0]).toMatchObject({ needsWeather: false, needsAir: false, needsSky: true });
    const api = fakeApi();
    const rest = await runBackfill({ sink, plan, runBudget: 1e6, limits: LIMITS, fetchFn: api.fetchFn, sleep: noSleep });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toContain("sunshine_duration");
    expect(rest.spent).toBeCloseTo(SKY_WEIGHT, 5);
    expect(sink.cells[cellKeyFor(10, 10)]!.m!.s).toHaveLength(12);
  });

  it("writes nothing for sunshine when the provider answers with a limit", async () => {
    const sink = memorySink();
    const res = await runBackfill({ sink, plan: planBackfill(cities.slice(0, 1), {}), runBudget: 1e6, limits: LIMITS, fetchFn: fakeApi({ limitAfter: 2 }).fetchFn, sleep: noSleep });
    expect(res.stoppedBy).toBe("limit");
    const cell = sink.cells[cellKeyFor(10, 10)]!;
    expect(cell.aq).toBeDefined();
    expect(cell.sq).toBeUndefined();
    expect(cell.m!.s).toBeUndefined();
  });

  it("stops when the provider says a limit is reached and never fabricates a cell", async () => {
    const sink = memorySink();
    const res = await runBackfill({ sink, plan: planBackfill(cities, {}), runBudget: 1e6, limits: LIMITS, fetchFn: fakeApi({ limitAfter: 3 }).fetchFn, sleep: noSleep });
    expect(res.stoppedBy).toBe("limit");
    expect(res.cellsCompleted).toBe(1);
    expect(Object.keys(sink.cells)).toHaveLength(1);
    expect(res.lastError).toContain("limit");
  });

  it("refuses to start a call the rolling hourly ceiling does not allow", async () => {
    const sink = memorySink();
    const api = fakeApi();
    const res = await runBackfill({ sink, plan: planBackfill(cities, {}), runBudget: 1e6, limits: { minutely: 1000, hourly: WEATHER_WEIGHT + AIR_WEIGHT + SKY_WEIGHT + 1, daily: 1e6 }, fetchFn: api.fetchFn, sleep: noSleep });
    expect(res.cellsCompleted).toBe(1);
    expect(res.stoppedBy).toBe("quota-wait");
    expect(api.calls).toHaveLength(3);
  });
});
