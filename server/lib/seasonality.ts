import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { getDataPath, ensureDataDir } from "./paths.js";
import { getCities, getCityById } from "./cities.js";
import { comfortScore } from "../../src/lib/comfort.js";
import { createJsonStore } from "./jsonStore.js";
import {
  cellKeyFor,
  decodeMonths,
  decodeWeeks,
  encodeWeekly,
  emptyClimateFile,
  readCommittedClimate,
  type ClimateCell,
  type ClimateFile,
  type WeekSeasonality,
} from "./climateNormals.js";

export { comfortScore };
export type { WeekSeasonality };

export interface MonthSeasonality {
  /** Comfort Index: temperature comfort minus rain penalty minus air penalty (src/lib/comfort.ts). */
  score: number;
  tempC: number;
  precipMm: number;
  /** Monthly mean PM2.5 in ug/m3 (CAMS via Open-Meteo); absent until the air-quality backfill reaches the city. */
  pm25?: number;
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
  /** Means over the country's covered cities. tempC to 1dp, precipMm rounded. */
  months: Array<{ score: number; tempC: number; precipMm: number }>;
}

// ── Comfort score formula ───────────────────────────────────────────────
// Lives in src/lib/comfort.ts so the client can show the same breakdown (ADR 0014).
// comfortScore(tempC, precipMm, pm25?) is re-exported above.

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
  committedClimate = null;
  runtimeClimate = emptyClimateFile();
  derived = null;
  inFlight.clear();
}

// ── Climate cells (ADR 0014) ──────────────────────────────────────────────
//
// Monthly PM2.5 and the 52-week normals live in climate cells (climateNormals.ts), shared by every
// city in the same 0.25 degree cell. The committed file is data/climate-normals.json; cells the server
// fetched itself (the nightly job, and weekly profiles from on-demand fetches) are kept in the
// document store under cache/climate-runtime.json, so they work on both the JSON-file and
// Postgres backends. A cell, when present, supersedes the legacy per-city months above it.

let committedClimate: ClimateFile | null = null;
let runtimeClimate: ClimateFile = emptyClimateFile();
let derived: { months: Map<string, MonthSeasonality[]>; weeks: Map<string, WeekSeasonality[]> } | null = null;

const climateRuntimeStore = createJsonStore<ClimateFile>("cache/climate-runtime.json", () => emptyClimateFile());

function loadCommittedClimate(): ClimateFile {
  if (committedClimate) return committedClimate;
  // A DATA_DIR that carries its own seasonality seed owns the whole dataset (tests, overrides): the repo's
  // committed climate cells must not leak into it.
  let ownSeed = false;
  try {
    readFileSync(getDataPath("seasonality.json"), "utf-8");
    ownSeed = process.env.DATA_DIR !== undefined && process.env.DATA_DIR !== join(process.cwd(), "data");
  } catch {
    ownSeed = false;
  }
  committedClimate = ownSeed ? readOwnClimate() : readCommittedClimate();
  return committedClimate;
}

function readOwnClimate(): ClimateFile {
  try {
    const parsed = JSON.parse(readFileSync(getDataPath("climate-normals.json"), "utf-8")) as ClimateFile;
    if (parsed?.version === 1 && parsed.cells) return parsed;
  } catch {
    // none
  }
  return emptyClimateFile();
}

/** Loads the server-fetched cells from the document store into memory. Call once at server start; safe to repeat. */
export async function hydrateClimateRuntime(): Promise<void> {
  try {
    const f = await climateRuntimeStore.read();
    if (f?.version === 1 && f.cells) {
      runtimeClimate = f;
      derived = null;
    }
  } catch (err) {
    console.warn("[seasonality] could not read the runtime climate cells:", err instanceof Error ? err.message : String(err));
  }
}

/** Persists one server-fetched cell (document store) and makes it visible to readers immediately. */
export async function saveRuntimeClimateCell(key: string, cell: ClimateCell): Promise<void> {
  runtimeClimate.cells[key] = cell;
  runtimeClimate.generatedAt = new Date().toISOString();
  derived = null;
  await climateRuntimeStore.update((f) => {
    f.version = 1;
    f.cells ??= {};
    f.cells[key] = cell;
    f.generatedAt = runtimeClimate.generatedAt;
    f.cellDeg = runtimeClimate.cellDeg;
  });
}

/** Cells visible to readers: committed, with server-fetched ones on top when they are at least as new. */
export function climateCells(): Record<string, ClimateCell> {
  const committed = loadCommittedClimate().cells;
  const runtime = runtimeClimate.cells;
  const keys = Object.keys(runtime);
  if (keys.length === 0) return committed;
  const out = { ...committed };
  for (const k of keys) {
    const r = runtime[k]!;
    const c = out[k];
    if (!c || (r.at ?? "") >= (c.at ?? "")) out[k] = r;
  }
  return out;
}

export function getClimateCell(cityId: string): ClimateCell | undefined {
  const city = getCityById(cityId);
  return city ? climateCells()[cellKeyFor(city.lat, city.lng)] : undefined;
}

export function getAirWindow(): string {
  return loadCommittedClimate().airWindow || "";
}

function buildDerived() {
  if (derived) return derived;
  const cells = climateCells();
  const months = new Map<string, MonthSeasonality[]>();
  const weeks = new Map<string, WeekSeasonality[]>();
  const decodedM = new Map<string, MonthSeasonality[] | null>();
  const decodedW = new Map<string, WeekSeasonality[] | null>();
  for (const city of getCities()) {
    const key = cellKeyFor(city.lat, city.lng);
    const cell = cells[key];
    if (!cell) continue;
    if (!decodedM.has(key)) {
      decodedM.set(key, decodeMonths(cell));
      decodedW.set(key, decodeWeeks(cell));
    }
    const m = decodedM.get(key);
    const w = decodedW.get(key);
    if (m) months.set(city.id, m);
    if (w) weeks.set(city.id, w);
  }
  derived = { months, weeks };
  return derived;
}

/** Cache-only: a city's 52 week-of-year normals, when its climate cell has them. */
export function getCityWeeks(cityId: string): WeekSeasonality[] | undefined {
  return buildDerived().weeks.get(cityId);
}

/** Every covered city's weekly normals (cache-only). */
export function getAllCityWeeks(): Record<string, WeekSeasonality[]> {
  return Object.fromEntries(buildDerived().weeks);
}

/** How many cities have each kind of data, for the job log and status. */
export function climateCoverage(): { cities: number; monthly: number; weekly: number; air: number } {
  const d = buildDerived();
  const monthly = new Set([...d.months.keys(), ...Object.keys(loadSeasonality().cities), ...Object.keys(loadRuntimeCache().cities)]);
  let air = 0;
  for (const m of d.months.values()) if (m.some((x) => x.pm25 !== undefined)) air++;
  return { cities: getCities().length, monthly: monthly.size, weekly: d.weeks.size, air };
}

/** Climate cells win over the legacy per-city months (they carry air quality); the runtime cache wins over the seed. */
function mergedCities(): Record<string, CitySeasonality> {
  const out: Record<string, CitySeasonality> = { ...loadSeasonality().cities, ...loadRuntimeCache().cities };
  for (const [id, months] of buildDerived().months) out[id] = { months };
  return out;
}

function getCachedMonths(cityId: string): MonthSeasonality[] | undefined {
  return (
    buildDerived().months.get(cityId) ??
    loadRuntimeCache().cities[cityId]?.months ??
    loadSeasonality().cities[cityId]?.months
  );
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

  // The same daily data also gives the week-of-year profile; stored when the series is dense enough.
  // (Air quality is a second provider call, left to the nightly job.)
  const weekly = encodeWeekly(
    records.map((r) => ({ date: r.date, v: r.tempC })),
    records.map((r) => ({ date: r.date, v: r.precipMm }))
  );
  if (weekly) {
    void saveRuntimeClimateCell(cellKeyFor(lat, lng), {
      at: new Date().toISOString().slice(0, 10),
      m: { t: months.map((m) => Math.round(m.tempC * 10)), p: months.map((m) => m.precipMm) },
      w: weekly,
    }).catch(() => undefined);
  }
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

/**
 * Year range the comfort scores are averaged over, e.g. "2015-2024". Read from
 * the seed dataset; falls back to the on-demand fetch window when the seed is
 * missing or predates the field.
 */
export function getSeasonalityWindow(): string {
  return loadSeasonality().window || WINDOW;
}

/** Every covered city's 12 months (seed + runtime cache merged), for map-wide climate search. */
export function getAllCitySeasonality(): Record<string, MonthSeasonality[]> {
  const out: Record<string, MonthSeasonality[]> = {};
  for (const [id, entry] of Object.entries(mergedCities())) if (Array.isArray(entry?.months)) out[id] = entry.months;
  return out;
}

/** Per-country monthly average of covered cities' scores (seed + runtime cache merged). */
export function getRegionAggregates(): RegionAggregate[] {
  const dataset = mergedCities();
  const cities = getCities();
  const byCountry = new Map<string, MonthSeasonality[][]>();

  for (const city of cities) {
    const entry = dataset[city.id];
    if (!entry) continue;
    const arr = byCountry.get(city.country) ?? [];
    arr.push(entry.months);
    byCountry.set(city.country, arr);
  }

  const mean = (vals: number[]) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const result: RegionAggregate[] = [];
  for (const [region, lists] of byCountry) {
    const months = Array.from({ length: 12 }, (_, i) => {
      const ms = lists.map((l) => l[i]).filter((m): m is MonthSeasonality => !!m);
      return {
        score: Math.round(mean(ms.map((m) => m.score))),
        tempC: Math.round(mean(ms.map((m) => m.tempC)) * 10) / 10,
        precipMm: Math.round(mean(ms.map((m) => m.precipMm))),
      };
    });
    result.push({ region, months });
  }

  return result.sort((a, b) => a.region.localeCompare(b.region));
}
