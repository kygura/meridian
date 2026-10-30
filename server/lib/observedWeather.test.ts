import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  fetchObservedWeather,
  summarizeDaily,
  diskObservedCache,
  observedCacheKey,
  type ObservedWeatherDeps,
} from "./observedWeather";
import { fakeFetch, getCity, memObservedCache, NOW, SEASONALITY, type FakeFetchOptions } from "./__fixtures__/journal";

function deps(opts: FakeFetchOptions = {}, extra: Partial<ObservedWeatherDeps> = {}) {
  const f = fakeFetch(opts);
  const cache = memObservedCache();
  const d: ObservedWeatherDeps = { fetch: f.fn, getCity, seasonality: (id) => SEASONALITY[id], now: () => NOW, cache, ...extra };
  return { d, calls: f.calls, cache };
}

describe("summarizeDaily", () => {
  it("means temperature, scales precip to a 30.4-day month, scores comfort", () => {
    const o = summarizeDaily([20, 22], [3, 1], { score: 90, tempC: 19.5 })!;
    expect(o.tempC).toBe(21);
    expect(o.precipMm).toBe(61); // 4 / 2 * 30.4 = 60.8
    expect(o.comfort).toBe(95); // comfortScore(21, 61) = 100 - 35*31/220
    expect(o.normalComfort).toBe(90);
    expect(o.normalTempC).toBe(19.5);
  });
  it("skips null days and returns undefined when nothing usable", () => {
    expect(summarizeDaily([null, 20], [5, 0], undefined)!.tempC).toBe(20);
    expect(summarizeDaily([null, null], [0, 0], undefined)).toBeUndefined();
  });
});

describe("fetchObservedWeather", () => {
  it("scores the Lisbon May-2024 fixture stay", async () => {
    const { d, calls } = deps();
    const r = await fetchObservedWeather("lisbon-portugal", "2024-05-10", "2024-05-17", d);
    expect(r).toEqual({ ok: true, observed: { tempC: 19.2, precipMm: 10, comfort: 100, normalComfort: 98, normalTempC: 18.5 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("start_date=2024-05-10");
    expect(calls[0]).toContain("end_date=2024-05-17");
    expect(calls[0]).toContain("daily=temperature_2m_mean,precipitation_sum");
  });

  it("serves the second request from cache (one fetch)", async () => {
    const { d, calls } = deps();
    await fetchObservedWeather("lisbon-portugal", "2024-05-10", "2024-05-17", d);
    const r2 = await fetchObservedWeather("lisbon-portugal", "2024-05-10", "2024-05-17", d);
    expect(r2.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["quota", "quota"],
    ["network", "network"],
    ["timeout", "timeout"],
  ] as const)("maps %s failures to reason %s and caches nothing", async (mode, reason) => {
    const { d, cache } = deps({ weather: mode });
    expect(await fetchObservedWeather("lisbon-portugal", "2024-05-10", "2024-05-17", d)).toEqual({ ok: false, reason });
    expect(cache.data.size).toBe(0);
  });

  it("returns future for stays not yet in the archive (5-day lag)", async () => {
    const { d, calls } = deps();
    expect(await fetchObservedWeather("lisbon-portugal", "2026-10-20", "2026-10-28", d)).toEqual({ ok: false, reason: "future" });
    expect(calls).toHaveLength(0);
  });

  it("returns no_city for an unknown city", async () => {
    const { d } = deps();
    expect(await fetchObservedWeather("atlantis-x", "2024-05-10", "2024-05-17", d)).toEqual({ ok: false, reason: "no_city" });
  });

  it("falls back to the observed comfort when the city has no normals", async () => {
    const { d } = deps({}, { seasonality: () => undefined });
    const r = await fetchObservedWeather("lisbon-portugal", "2024-05-10", "2024-05-17", d);
    expect(r.ok && r.observed.normalComfort).toBe(100);
    expect(r.ok && r.observed.normalTempC).toBeUndefined();
  });
});

describe("diskObservedCache", () => {
  const prev = process.env.DATA_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
  });

  it("persists to data/cache/observed.json keyed per (cityId, arrive, depart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-observed-"));
    process.env.DATA_DIR = dir;
    const c = diskObservedCache();
    const key = observedCacheKey("lisbon-portugal", "2024-05-10", "2024-05-17");
    c.set(key, { tempC: 19.2, precipMm: 10, comfort: 100, normalComfort: 98 });
    const file = join(dir, "cache", "observed.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8"))[key].tempC).toBe(19.2);
    expect(diskObservedCache().get(key)?.comfort).toBe(100);
  });
});
