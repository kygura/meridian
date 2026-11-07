/**
 * Seasonality API types + fetch wrappers.
 * Shapes match server/routes/seasonality.ts exactly:
 *  - GET /api/seasonality/:cityId      -> { cityId, months: SeasonMonth[12] } | 404
 *  - GET /api/seasonality?cityIds=a,b  -> { cities: Record<id, SeasonMonth[] | null>, window: "2015-2024" }
 *    (null = uncovered/pending; the server may resolve misses on-demand, so a
 *    single re-request of nulls after a few seconds can fill them in)
 *  - GET /api/seasonality/regions      -> { regions: RegionSeason[] }
 *  - 503 = seasonality temporarily unavailable (provider quota)
 */

import { apiUrl } from "./api";

/** One month's entry (index 0 = January .. 11 = December). */
export interface SeasonMonth {
  score: number;
  tempC: number;
  precipMm: number;
}

/** Region aggregate — note: months carry scores only (no temp/precip). */
export interface RegionSeason {
  region: string;
  months: Array<{ score: number }>;
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
 * Returns a record where null means "not covered (yet)".
 */
export async function fetchSeasonality(
  cityIds: string[]
): Promise<{ cities: Record<string, SeasonMonth[] | null>; window: string | null }> {
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
      window?: string;
    };
    Object.assign(result, body.cities ?? {});
    if (typeof body.window === "string" && body.window) window = body.window;
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
export async function fetchRegions(): Promise<RegionSeason[]> {
  const res = await fetch(apiUrl("/api/seasonality/regions"));
  checkStatus(res);
  const body = (await res.json()) as { regions?: RegionSeason[] };
  return Array.isArray(body.regions) ? body.regions : [];
}
