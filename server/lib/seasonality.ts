import { readFileSync } from "fs";
import { getDataPath } from "./paths.js";
import { getCities } from "./cities.js";

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

// ── Dataset access ───────────────────────────────────────────────────────

let cache: SeasonalityDataset | null = null;

/** Loads and caches data/seasonality.json (falls back to an empty dataset if missing). */
export function loadSeasonality(): SeasonalityDataset {
  if (cache) return cache;
  try {
    const raw = readFileSync(getDataPath("seasonality.json"), "utf-8");
    cache = JSON.parse(raw) as SeasonalityDataset;
  } catch {
    cache = { version: 1, generatedAt: new Date(0).toISOString(), window: "", cities: {} };
  }
  return cache;
}

/** Test-only: force the next loadSeasonality() call to re-read from disk. */
export function resetSeasonalityCache(): void {
  cache = null;
}

export function getCitySeasonality(cityId: string): MonthSeasonality[] | undefined {
  return loadSeasonality().cities[cityId]?.months;
}

/** Per-country monthly average of covered cities' scores. */
export function getRegionAggregates(): RegionAggregate[] {
  const dataset = loadSeasonality();
  const cities = getCities();
  const byCountry = new Map<string, number[][]>();

  for (const city of cities) {
    const entry = dataset.cities[city.id];
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
