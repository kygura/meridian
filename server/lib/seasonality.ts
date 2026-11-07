import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { getDataPath, ensureDataDir } from "./paths.js";
import { getCities, getCityById } from "./cities.js";

export interface MonthSeasonality {
  score: number;
  tempC: number;
  precipMm: number;
}

export interface CitySeasonality {
  months: MonthSeasonality[]; // 12 entries, Jan..Dec
}

export interface SeasonalityDataset {
  version: number;
  generatedAt: string;
  window: string;
  cities: Record<string, CitySeasonality>;
}

export interface RegionAggregate {
  region: string;
  months: Array<{ score: number }>;
}

// ── Comfort score formula ───────────────────────────────────────────────
// Pure, deterministic, unit-tested. Temperature contributes 100 within the
// 18-26C comfort band, falling off linearly to 0 at <=-5C and >=40C.
// Precipitation subtracts a penalty: 0 at <=30mm/month, scaling linearly to
// -35 at >=250mm/month. Final score is clamped to 0-100.

const TEMP_COMFORT_MIN = 18;
const TEMP_COMFORT_MAX = 26;
const TEMP_FLOOR = -5;
const TEMP_CEILING = 40;

const PRECIP_FREE_MM = 30;
const PRECIP_MAX_MM = 250;
const PRECIP_MAX_PENALTY = 35;

export function comfortScore(tempC: number, precipMm: number): number {
  let tempScore: number;
  if (tempC >= TEMP_COMFORT_MIN && tempC <= TEMP_COMFORT_MAX) {
    tempScore = 100;
  } else if (tempC < TEMP_COMFORT_MIN) {
    tempScore = (100 * (tempC - TEMP_FLOOR)) / (TEMP_COMFORT_MIN - TEMP_FLOOR);
  } else {
    tempScore = (100 * (TEMP_CEILING - tempC)) / (TEMP_CEILING - TEMP_COMFORT_MAX);
  }
  tempScore = Math.min(100, Math.max(0, tempScore));

  let penalty: number;
  if (precipMm <= PRECIP_FREE_MM) {
    penalty = 0;
  } else if (precipMm >= PRECIP_MAX_MM) {
    penalty = PRECIP_MAX_PENALTY;
  } else {
    penalty =
      (PRECIP_MAX_PENALTY * (precipMm - PRECIP_FREE_MM)) / (PRECIP_MAX_MM - PRECIP_FREE_MM);
  }

  return Math.round(Math.min(100, Math.max(0, tempScore - penalty)));
}

// ── Daily → monthly aggregation ─────────────────────────────────────────

export interface DailyRecord {
  /** ISO date, YYYY-MM-DD */
  date: string;
  tempC: number;
  precipMm: number;
}

/**
 * Aggregates a multi-year series of daily records into 12 monthly figures
 * (index 0 = January .. 11 = December):
 *  - tempC: the mean daily temperature for that calendar month, averaged
 *    across all years present (mean-of-yearly-means), rounded to 1dp.
 *  - precipMm: the total precipitation for that calendar month in a given
 *    year, averaged across all years present, rounded to an integer.
 * Months with no data default to { tempC: 0, precipMm: 0 }.
 */
export function aggregateDailyToMonthly(
  daily: DailyRecord[]
): Array<{ tempC: number; precipMm: number }> {
  const perMonthYear = new Map<string, { tempSum: number; tempCount: number; precipSum: number }>();

  for (const d of daily) {
    const [yearStr, monthStr] = d.date.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr) - 1;
    if (!Number.isFinite(year) || month < 0 || month > 11) continue;
    const key = `${month}-${year}`;
    const acc = perMonthYear.get(key) ?? { tempSum: 0, tempCount: 0, precipSum: 0 };
    acc.tempSum += d.tempC;
    acc.tempCount += 1;
    acc.precipSum += d.precipMm;
    perMonthYear.set(key, acc);
  }

  const perMonth: Array<{ tempMeanSum: number; precipSum: number; years: number }> = Array.from(
    { length: 12 },
    () => ({ tempMeanSum: 0, precipSum: 0, years: 0 })
  );

  for (const [key, acc] of perMonthYear) {
    const month = Number(key.split("-")[0]);
    const bucket = perMonth[month]!;
    bucket.tempMeanSum += acc.tempSum / acc.tempCount;
    bucket.precipSum += acc.precipSum;
    bucket.years += 1;
  }

  return perMonth.map((b) => ({
    tempC: b.years > 0 ? Math.round((b.tempMeanSum / b.years) * 10) / 10 : 0,
    precipMm: b.years > 0 ? Math.round(b.precipSum / b.years) : 0,
  }));
}

// ── Seed dataset access ───────────────────────────────────────────────────
//
// data/seasonality.json is a pristine, committed SEED dataset (built offline
// by scripts/build-seasonality.mjs). It is never written to at runtime.

let cache: SeasonalityDataset | null = null;

/** Loads and caches data/seasonality.json (falls back to an empty dataset if missing). */
export function loadSeasonality(): SeasonalityDataset {
  if (cache) return cache;
  // DATA_DIR first (tests and overrides), then the committed seed in the repo:
  // on Render DATA_DIR is the persistent disk, which never holds the seed.
  const candidates = new Set([getDataPath("seasonality.json"), join(process.cwd(), "data", "seasonality.json")]);
  for (const path of candidates) {
    try {
      cache = JSON.parse(readFileSync(path, "utf-8")) as SeasonalityDataset;
      return cache;
    } catch {
      // try the next location
    }
  }
  cache = { version: 1, generatedAt: new Date(0).toISOString(), window: "", cities: {} };
  return cache;
}

// ── Runtime cache (on-demand additions) ───────────────────────────────────
//
// data/cache/seasonality-runtime.json holds cities fetched on-demand at
// request time (see resolveCitySeasonality below). Same inner shape as the
// seed dataset. Loaded lazily, written to disk on every successful fetch.

const RUNTIME_CACHE_FILE = ["cache", "seasonality-runtime.json"];

let runtimeCache: SeasonalityDataset | null = null;

function loadRuntimeCache(): SeasonalityDataset {
  if (runtimeCache) return runtimeCache;
  try {
    const raw = readFileSync(getDataPath(...RUNTIME_CACHE_FILE), "utf-8");
    runtimeCache = JSON.parse(raw) as SeasonalityDataset;
  } catch {
    runtimeCache = { version: 1, generatedAt: new Date(0).toISOString(), window: WINDOW, cities: {} };
  }
  return runtimeCache;
}

function persistToRuntimeCache(cityId: string, months: MonthSeasonality[]): void {
  const dataset = loadRuntimeCache();
  dataset.cities[cityId] = { months };
  dataset.generatedAt = new Date().toISOString();
  ensureDataDir("cache");
  writeFileSync(getDataPath(...RUNTIME_CACHE_FILE), JSON.stringify(dataset));
}

/** Test-only: force the next load*Cache() call to re-read from disk, and clear in-flight fetches. */
export function resetSeasonalityCache(): void {
  cache = null;
  runtimeCache = null;
  inFlight.clear();
}

/** Runtime cache wins over the seed on duplicate city ids. */
function mergedCities(): Record<string, CitySeasonality> {
  return { ...loadSeasonality().cities, ...loadRuntimeCache().cities };
}

function getCachedMonths(cityId: string): MonthSeasonality[] | undefined {
  return loadRuntimeCache().cities[cityId]?.months ?? loadSeasonality().cities[cityId]?.months;
}

// ── On-demand live fetch (Open-Meteo archive API) ─────────────────────────
//
// Same 10-year window, daily variables, and aggregation/scoring formula as
// scripts/build-seasonality.mjs, but for a single city at request time.

const WINDOW_START_YEAR = 2015;
const WINDOW_END_YEAR = 2024;
const START_DATE = `${WINDOW_START_YEAR}-01-01`;
const END_DATE = `${WINDOW_END_YEAR}-12-31`;
const WINDOW = `${WINDOW_START_YEAR}-${WINDOW_END_YEAR}`;
const FETCH_TIMEOUT_MS = 15_000;

export type SeasonalityUnavailableReason = "quota" | "network" | "timeout";

export type SeasonalityLookupResult =
  | { kind: "hit"; months: MonthSeasonality[] }
  | { kind: "unavailable"; reason: SeasonalityUnavailableReason }
  | { kind: "unknown" };

type SeasonalityPeekResult =
  | { kind: "hit"; months: MonthSeasonality[] }
  | { kind: "unknown" }
  | { kind: "miss" };

/** Cache-only lookup: never triggers a fetch. Used to plan on-demand work in batch requests. */
export function peekCitySeasonality(cityId: string): SeasonalityPeekResult {
  const months = getCachedMonths(cityId);
  if (months) return { kind: "hit", months };
  if (!getCityById(cityId)) return { kind: "unknown" };
  return { kind: "miss" };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCityLive(
  cityId: string,
  lat: number,
  lng: number
): Promise<SeasonalityLookupResult> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=UTC`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason: SeasonalityUnavailableReason =
      name === "AbortError" || name === "TimeoutError" ? "timeout" : "network";
    return { kind: "unavailable", reason };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unavailable", reason: "network" };
  }

  const parsed = body as { error?: boolean; daily?: Record<string, unknown> } | null;

  // Open-Meteo reports quota/validation errors as a 400-ish response with
  // {"error":true,"reason":"..."} — never fabricate a score for these.
  if (!res.ok || parsed?.error === true) {
    return { kind: "unavailable", reason: "quota" };
  }

  const daily = parsed?.daily as
    | { time?: string[]; temperature_2m_max?: (number | null)[]; temperature_2m_min?: (number | null)[]; precipitation_sum?: (number | null)[] }
    | undefined;
  if (!daily?.time || !Array.isArray(daily.time)) {
    return { kind: "unavailable", reason: "network" };
  }

  const records: DailyRecord[] = [];
  for (let i = 0; i < daily.time.length; i++) {
    const max = daily.temperature_2m_max?.[i];
    const min = daily.temperature_2m_min?.[i];
    if (max == null || min == null) continue;
    records.push({
      date: daily.time[i]!,
      tempC: (max + min) / 2,
      precipMm: daily.precipitation_sum?.[i] ?? 0,
    });
  }

  if (records.length === 0) {
    return { kind: "unavailable", reason: "network" };
  }

  const monthly = aggregateDailyToMonthly(records);
  const months: MonthSeasonality[] = monthly.map((m) => ({
    score: comfortScore(m.tempC, m.precipMm),
    tempC: m.tempC,
    precipMm: m.precipMm,
  }));

  persistToRuntimeCache(cityId, months);
  return { kind: "hit", months };
}

// In-flight dedupe: concurrent requests for the same city share one fetch.
const inFlight = new Map<string, Promise<SeasonalityLookupResult>>();

function fetchCityLiveDeduped(cityId: string, lat: number, lng: number): Promise<SeasonalityLookupResult> {
  const existing = inFlight.get(cityId);
  if (existing) return existing;
  const promise = fetchCityLive(cityId, lat, lng).finally(() => {
    inFlight.delete(cityId);
  });
  inFlight.set(cityId, promise);
  return promise;
}

/**
 * Full resolution: cache hit -> return immediately. Miss + known city ->
 * fetch Open-Meteo live, persist to the runtime cache, and return. Unknown
 * city -> {kind:"unknown"}. Never fabricates scores; fetch failures return
 * {kind:"unavailable"} and are never cached.
 */
export async function resolveCitySeasonality(cityId: string): Promise<SeasonalityLookupResult> {
  const peek = peekCitySeasonality(cityId);
  if (peek.kind === "hit") return peek;
  if (peek.kind === "unknown") return peek;

  const city = getCityById(cityId);
  if (!city) return { kind: "unknown" };
  return fetchCityLiveDeduped(cityId, city.lat, city.lng);
}

/**
 * Convenience wrapper kept for existing callers (e.g. the agent tool layer)
 * that only care about the months, not why a fetch failed.
 */
export async function getCitySeasonality(cityId: string): Promise<MonthSeasonality[] | undefined> {
  const result = await resolveCitySeasonality(cityId);
  return result.kind === "hit" ? result.months : undefined;
}

/** Per-country monthly average of covered cities' scores (seed + runtime cache merged). */
/** The "YYYY-YYYY" climate window the dataset was built from. */
export function getSeasonalityWindow(): string {
  return loadSeasonality().window || WINDOW;
}

export function getRegionAggregates(): RegionAggregate[] {
  const dataset = mergedCities();
  const cities = getCities();
  const byCountry = new Map<string, number[][]>();

  for (const city of cities) {
    const entry = dataset[city.id];
    if (!entry) continue;
    const arr = byCountry.get(city.country) ?? [];
    arr.push(entry.months.map((m) => m.score));
    byCountry.set(city.country, arr);
  }

  const result: RegionAggregate[] = [];
  for (const [region, scoreLists] of byCountry) {
    const months = Array.from({ length: 12 }, (_, i) => {
      const vals = scoreLists.map((s) => s[i]!);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { score: Math.round(avg) };
    });
    result.push({ region, months });
  }

  return result.sort((a, b) => a.region.localeCompare(b.region));
}
