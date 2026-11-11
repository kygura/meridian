/**
 * Seasonality API types + fetch wrappers.
 * Shapes match server/routes/seasonality.ts exactly:
 *  - GET /api/seasonality/:cityId      -> { cityId, months: SeasonMonth[12] } | 404
 *  - GET /api/seasonality?cityIds=a,b  -> { cities: Record<id, SeasonMonth[] | null>, window }
 *    (null = uncovered/pending; the server may resolve misses on-demand, so a
 *    single re-request of nulls after a few seconds can fill them in)
 *  - GET /api/seasonality/regions      -> { regions: RegionSeason[], window }
 *  - GET /api/seasonality/cities       -> { cities: Record<id, SeasonMonth[]>, window } (cache-only)
 *    (window = year range the scores average over, e.g. "2015-2024")
 *  - 503 = seasonality temporarily unavailable (provider quota)
 */

import { apiUrl } from "./api";

/** One month's entry (index 0 = January .. 11 = December). */
export interface SeasonMonth {
  /** Comfort Index: temperature comfort minus the rain and air penalties. */
  score: number;
  tempC: number;
  precipMm: number;
  /** Monthly mean PM2.5 (ug/m3); absent until the air-quality data reaches the place. */
  pm25?: number;
}

/** One week-of-year normal (index 0 = week 1). `precipMm` is per 7 days. */
export interface SeasonWeek {
  score: number;
  tempC: number;
  precipMm: number;
  pm25?: number;
}

/** Region aggregate: means over the country's covered cities (temp/precip absent on older servers). */
export interface RegionSeason {
  region: string;
  months: Array<{ score: number; tempC?: number; precipMm?: number; pm25?: number }>;
}

/** Batch response: city records plus the dataset's year window (null if the server omitted it). */
export interface SeasonalityBatch {
  cities: Record<string, SeasonMonth[] | null>;
  window: string | null;
}

/** Region aggregates plus the dataset's year window (null if the server omitted it). */
export interface RegionsResult {
  regions: RegionSeason[];
  window: string | null;
}

function readWindow(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Thrown on a 503 — provider quota exhausted, retry later. Never fabricate data. */
export class SeasonalityUnavailableError extends Error {
  constructor() {
    super("seasonality_unavailable");
    this.name = "SeasonalityUnavailableError";
  }
}

/** Server-enforced maximum ids per batch request. */
const BATCH_LIMIT = 100;

function checkStatus(res: Response): void {
  if (res.status === 503) throw new SeasonalityUnavailableError();
  if (!res.ok) throw new Error(`Seasonality request failed: ${res.status}`);
}

/**
 * Batch fetch, chunked to the server's 100-id limit.
 * In `cities`, null means "not covered (yet)".
 */
export async function fetchSeasonality(cityIds: string[]): Promise<SeasonalityBatch> {
  const unique = [...new Set(cityIds)].filter(Boolean);
  const result: Record<string, SeasonMonth[] | null> = {};
  let window: string | null = null;
  for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
    const chunk = unique.slice(i, i + BATCH_LIMIT);
    const qs = chunk.map(encodeURIComponent).join(",");
    const res = await fetch(apiUrl(`/api/seasonality?cityIds=${qs}`));
    checkStatus(res);
    const body = (await res.json()) as {
      cities?: Record<string, SeasonMonth[] | null>;
      window?: unknown;
    };
    Object.assign(result, body.cities ?? {});
    window = readWindow(body.window) ?? window;
  }
  return { cities: result, window };
}

/** Single-city fetch. 404 (uncovered) resolves to null. */
export async function fetchCitySeasonality(
  cityId: string
): Promise<SeasonMonth[] | null> {
  const res = await fetch(apiUrl(`/api/seasonality/${encodeURIComponent(cityId)}`));
  if (res.status === 404) return null;
  checkStatus(res);
  const body = (await res.json()) as { cityId: string; months: SeasonMonth[] };
  return Array.isArray(body.months) ? body.months : null;
}

/** Region aggregates for the REGIONS toggle / empty-state teaser. */
export async function fetchRegions(): Promise<RegionsResult> {
  const res = await fetch(apiUrl("/api/seasonality/regions"));
  checkStatus(res);
  const body = (await res.json()) as { regions?: RegionSeason[]; window?: unknown };
  return {
    regions: Array.isArray(body.regions) ? body.regions : [],
    window: readWindow(body.window),
  };
}

/** Every covered city's months, for the map's climate search. Cache-only on the server. */
export async function fetchAllCitySeasonality(): Promise<SeasonalityBatch> {
  const res = await fetch(apiUrl("/api/seasonality/cities"));
  checkStatus(res);
  const body = (await res.json()) as { cities?: Record<string, SeasonMonth[]>; window?: unknown };
  return { cities: body.cities && typeof body.cities === "object" ? body.cities : {}, window: readWindow(body.window) };
}

/** Weekly normals per city (cache-only on the server); null where a city has none yet, so callers fall back to months. */
export async function fetchWeekly(cityIds: string[]): Promise<Record<string, SeasonWeek[] | null>> {
  const unique = [...new Set(cityIds)].filter(Boolean);
  const result: Record<string, SeasonWeek[] | null> = {};
  for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
    const qs = unique.slice(i, i + BATCH_LIMIT).map(encodeURIComponent).join(",");
    const res = await fetch(apiUrl(`/api/seasonality/weekly?cityIds=${qs}`));
    checkStatus(res);
    const body = (await res.json()) as { cities?: Record<string, SeasonWeek[] | null> };
    for (const [id, weeks] of Object.entries(body.cities ?? {})) result[id] = Array.isArray(weeks) && weeks.length === 52 ? weeks : null;
  }
  return result;
}
