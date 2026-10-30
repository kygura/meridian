// Observed conditions for an actual stay (spec-journal §5, R6): Open-Meteo
// archive daily data for the exact dates, scored with the existing
// comfortScore. Failures never produce a number — the caller marks the
// weather dims "pending" and retries on the next fingerprint request.

import { readFileSync, writeFileSync, renameSync } from "fs";
import { comfortScore, getCitySeasonality, type MonthSeasonality } from "./seasonality.js";
import { getCityById } from "./cities.js";
import { getDataPath, ensureDataDir } from "./paths.js";
import { dominantMonth, eachDay, parseDay } from "./stayDates.js";
import type { City, ObservedConditions } from "../../src/types.js";

export type ObservedWeatherFailure = "quota" | "network" | "timeout" | "future" | "no_city";

export type ObservedWeatherResult =
  | { ok: true; observed: ObservedConditions }
  | { ok: false; reason: ObservedWeatherFailure };

export interface ObservedCache {
  get(key: string): ObservedConditions | undefined;
  set(key: string, value: ObservedConditions): void;
}

export interface ObservedWeatherDeps {
  fetch: typeof fetch;
  getCity: (cityId: string) => City | undefined;
  /** City's 12 monthly normals (Jan..Dec), for normalComfort. */
  seasonality: (cityId: string) => Promise<MonthSeasonality[] | undefined> | MonthSeasonality[] | undefined;
  now: () => Date;
  cache?: ObservedCache;
  timeoutMs?: number;
}

/** ERA5 archive lags real time by ~5 days; stays ending after that are "future". */
export const ARCHIVE_LAG_DAYS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const MONTH_DAYS = 30.4;

export function observedCacheKey(cityId: string, arrive: string, depart: string): string {
  return `${cityId}|${arrive}|${depart}`;
}

/**
 * Disk cache at data/cache/observed.json, keyed per (cityId, arrive, depart).
 * set() re-reads the file and merges before the atomic rename (one sync section),
 * so concurrent instances (one per fingerprint job) never drop each other's entries.
 */
export function diskObservedCache(): ObservedCache {
  let mem: Record<string, ObservedConditions> | null = null;
  const file = () => getDataPath("cache", "observed.json");
  const read = (): Record<string, ObservedConditions> => {
    try {
      const v = JSON.parse(readFileSync(file(), "utf-8")) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ObservedConditions>) : {};
    } catch {
      return {};
    }
  };
  const load = () => (mem ??= read());
  return {
    get: (key) => load()[key],
    set: (key, value) => {
      const data = (mem = { ...load(), ...read(), [key]: value });
      ensureDataDir("cache");
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, file());
    },
  };
}

export function observedArchiveUrl(lat: number, lng: number, start: string, end: string): string {
  return (
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${start}&end_date=${end}&daily=temperature_2m_mean,precipitation_sum&timezone=UTC`
  );
}

/**
 * Pure: daily series → observed conditions. Temp = mean of daily means (1dp);
 * precip = total scaled to a monthly equivalent (sum / days * 30.4, integer).
 * Returns undefined when there is no usable day.
 */
export function summarizeDaily(
  temps: (number | null | undefined)[],
  precips: (number | null | undefined)[],
  normal: { score: number; tempC: number } | undefined
): ObservedConditions | undefined {
  let tSum = 0;
  let pSum = 0;
  let n = 0;
  for (let i = 0; i < temps.length; i++) {
    const t = temps[i];
    if (t == null || !Number.isFinite(t)) continue;
    tSum += t;
    pSum += precips[i] ?? 0;
    n++;
  }
  if (n === 0) return undefined;
  const tempC = Math.round((tSum / n) * 10) / 10;
  const precipMm = Math.round((pSum / n) * MONTH_DAYS);
  const comfort = comfortScore(tempC, precipMm);
  // normalComfort is required by the type; with no normals it equals the observed comfort (no "lucky week" signal).
  const out: ObservedConditions = { tempC, precipMm, comfort, normalComfort: normal?.score ?? comfort };
  if (normal) out.normalTempC = normal.tempC;
  return out;
}

async function fetchWithTimeout(f: typeof fetch, url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await f(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const inFlight = new Map<string, Promise<ObservedWeatherResult>>();

export async function fetchObservedWeather(
  cityId: string,
  arrive: string,
  depart: string,
  deps: ObservedWeatherDeps
): Promise<ObservedWeatherResult> {
  const key = observedCacheKey(cityId, arrive, depart);
  const hit = deps.cache?.get(key);
  if (hit) return { ok: true, observed: hit };

  const city = deps.getCity(cityId);
  if (!city) return { ok: false, reason: "no_city" };

  const cutoff = deps.now().getTime() - ARCHIVE_LAG_DAYS * 86_400_000;
  if (parseDay(depart) > cutoff) return { ok: false, reason: "future" };

  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = fetchLive(city, key, arrive, depart, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function fetchLive(
  city: City,
  key: string,
  arrive: string,
  depart: string,
  deps: ObservedWeatherDeps
): Promise<ObservedWeatherResult> {
  const end = depart < arrive ? arrive : depart;
  const url = observedArchiveUrl(city.lat, city.lng, arrive, end);
  let res: Response;
  try {
    res = await fetchWithTimeout(deps.fetch, url, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "AbortError" || name === "TimeoutError" ? "timeout" : "network" };
  }

  let body: { error?: boolean; daily?: { time?: string[]; temperature_2m_mean?: (number | null)[]; precipitation_sum?: (number | null)[] } } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: "network" };
  }
  // Same rule as seasonality.ts: Open-Meteo reports quota/validation errors as
  // a non-2xx with {"error":true}. Never fabricate.
  if (!res.ok || body?.error === true) return { ok: false, reason: "quota" };

  const daily = body?.daily;
  if (!daily?.time || !Array.isArray(daily.time)) return { ok: false, reason: "network" };

  // Keep only the stay's days, in case the API returned a wider window.
  const wanted = new Set(eachDay(arrive, end));
  const temps: (number | null)[] = [];
  const precips: (number | null)[] = [];
  daily.time.forEach((d, i) => {
    if (!wanted.has(d)) return;
    temps.push(daily.temperature_2m_mean?.[i] ?? null);
    precips.push(daily.precipitation_sum?.[i] ?? null);
  });

  let normal: MonthSeasonality | undefined;
  try {
    const months = await deps.seasonality(city.id);
    normal = months?.[dominantMonth(arrive, depart) - 1];
  } catch {
    normal = undefined;
  }

  const observed = summarizeDaily(temps, precips, normal);
  if (!observed) return { ok: false, reason: "network" };
  deps.cache?.set(key, observed);
  return { ok: true, observed };
}

/** Real wiring: network fetch, city DB, seasonality (seed + on-demand), disk cache. */
export function defaultObservedWeatherDeps(): ObservedWeatherDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    getCity: getCityById,
    seasonality: getCitySeasonality,
    now: () => new Date(),
    cache: diskObservedCache(),
  };
}
