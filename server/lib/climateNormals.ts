// Climate normals beyond the monthly temperature/rain pair (ADR 0014): monthly PM2.5, and
// week-of-year (52) temperature, rain and PM2.5. Stored per climate grid cell (0.25 degrees),
// quantised to integers, so cities that share a cell share one record and one API call.
//
// Pure helpers and the on-disk format live here. Fetching and scheduling live in
// climateBackfill.ts; seasonality.ts merges this data into what the rest of the app reads.

import { readFileSync } from "fs";
import { join } from "path";
import { getDataPath } from "./paths.js";
import { annualRain, comfortScore, weeklyComfortBreakdown, WEEKS_PER_MONTH } from "../../src/lib/comfort.js";

export const CELL_DEG = 0.25;
export const WEEKS = 52;

/** Grid-cell key for a coordinate: the integer index of its 0.25 degree cell. */
export function cellKeyFor(lat: number, lng: number): string {
  return `${Math.round(lat / CELL_DEG) + 0},${Math.round(lng / CELL_DEG) + 0}`;
}

/**
 * One cell's record. All numbers are integers (x10 where noted) to keep the file small.
 *  m.t monthly mean temperature C x10, m.p monthly rain mm, m.a monthly mean PM2.5 ug/m3 x10
 *  w.t weekly mean temperature C x10, w.p rain mm per 7 days x10, w.a weekly mean PM2.5 x10
 *  at: date the weather was fetched; aq: date the air quality was fetched (absent = not yet).
 */
export interface ClimateCell {
  at?: string;
  aq?: string;
  m?: { t: number[]; p: number[]; a?: number[] };
  w?: { t: number[]; p: number[]; a?: number[] };
}

export interface ClimateFile {
  version: 1;
  /** Years the weather normals average over, e.g. "2015-2024". */
  weatherWindow: string;
  /** Years the air-quality normals average over, e.g. "2023-2025". */
  airWindow: string;
  generatedAt: string;
  cellDeg: number;
  cells: Record<string, ClimateCell>;
}

export interface WeekSeasonality {
  score: number;
  tempC: number;
  /** Mean rain per 7 days. */
  precipMm: number;
  pm25?: number;
}

export function emptyClimateFile(weatherWindow = "", airWindow = ""): ClimateFile {
  return { version: 1, weatherWindow, airWindow, generatedAt: new Date(0).toISOString(), cellDeg: CELL_DEG, cells: {} };
}

// ── daily -> weekly / monthly ─────────────────────────────────────────────

export interface DailyValue {
  /** ISO date, YYYY-MM-DD */
  date: string;
  v: number;
}

const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Day of year on a fixed 365-day calendar: 29 February counts as 28 February, so weeks line up across leap years. */
export function dayOfYear365(date: string): number | undefined {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return undefined;
  if (month === 2 && day > 28) return 59;
  return CUM_DAYS[month - 1]! + day;
}

/** Week bucket 0..51 for a date. Days 358-365 fold into the last week (8 days). */
export function weekIndex(date: string): number | undefined {
  const doy = dayOfYear365(date);
  return doy === undefined ? undefined : Math.min(WEEKS - 1, Math.floor((doy - 1) / 7));
}

/** Circular [1,2,1]/4 smoothing: removes week-to-week noise from a 10 year sample without moving the seasonal shape. */
export function smoothCircular(xs: number[]): number[] {
  const n = xs.length;
  return xs.map((_, i) => (xs[(i - 1 + n) % n]! + 2 * xs[i]! + xs[(i + 1) % n]!) / 4);
}

const MIN_DAYS_PER_WEEK = 5;

/**
 * Mean of a daily series per week-of-year (52 values, smoothed), over every day in the series.
 * `perWeek` scales the daily mean to a weekly total (rain). Returns null when any week has too
 * few days to be a normal, so a sparse series never produces a weekly profile.
 */
export function weeklyNormals(daily: DailyValue[], perWeek = false): number[] | null {
  const sum = new Array<number>(WEEKS).fill(0);
  const count = new Array<number>(WEEKS).fill(0);
  for (const d of daily) {
    const w = weekIndex(d.date);
    if (w === undefined || !Number.isFinite(d.v)) continue;
    sum[w]! += d.v;
    count[w]! += 1;
  }
  if (count.some((c) => c < MIN_DAYS_PER_WEEK)) return null;
  const means = sum.map((s, i) => (s / count[i]!) * (perWeek ? 7 : 1));
  return smoothCircular(means);
}

/** Mean of a daily series per calendar month (12 values): the mean of each year's monthly mean. Null if a month has no data. */
export function monthlyMeanNormals(daily: DailyValue[]): number[] | null {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const d of daily) {
    const month = Number(d.date.slice(5, 7)) - 1;
    const year = d.date.slice(0, 4);
    if (!(month >= 0 && month < 12) || !Number.isFinite(d.v)) continue;
    const k = `${month}-${year}`;
    const a = acc.get(k) ?? { sum: 0, n: 0 };
    a.sum += d.v;
    a.n += 1;
    acc.set(k, a);
  }
  const perMonth = Array.from({ length: 12 }, () => ({ sum: 0, years: 0 }));
  for (const [k, a] of acc) {
    const m = perMonth[Number(k.split("-")[0])]!;
    m.sum += a.sum / a.n;
    m.years += 1;
  }
  if (perMonth.some((m) => m.years === 0)) return null;
  return perMonth.map((m) => m.sum / m.years);
}

/** Hourly series -> daily means. A day with fewer than 12 valid hours is dropped rather than averaged on a partial day. */
export function dailyFromHourly(times: string[], values: Array<number | null | undefined>): DailyValue[] {
  const byDay = new Map<string, { sum: number; n: number }>();
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const date = times[i]!.slice(0, 10);
    const a = byDay.get(date) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n += 1;
    byDay.set(date, a);
  }
  const out: DailyValue[] = [];
  for (const [date, a] of byDay) if (a.n >= 12) out.push({ date, v: a.sum / a.n });
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

const q10 = (x: number) => Math.round(x * 10);

/** Weekly profile (temperature, rain, and PM2.5 when given) from daily series, quantised for storage; null if the weather series is too sparse. */
export function encodeWeekly(temp: DailyValue[], rain: DailyValue[], pm25?: DailyValue[]): ClimateCell["w"] | undefined {
  const t = weeklyNormals(temp);
  const p = weeklyNormals(rain, true);
  if (!t || !p) return undefined;
  const a = pm25 ? weeklyNormals(pm25) : null;
  return { t: t.map(q10), p: p.map(q10), ...(a ? { a: a.map(q10) } : {}) };
}

// ── decoding ──────────────────────────────────────────────────────────────

export function decodeMonths(cell: ClimateCell | undefined): Array<{ score: number; tempC: number; precipMm: number; pm25?: number }> | null {
  const m = cell?.m;
  if (!m || m.t.length !== 12 || m.p.length !== 12) return null;
  const year = annualRain(m.p);
  return m.t.map((t, i) => {
    const tempC = t / 10;
    const precipMm = m.p[i]!;
    const a = m.a?.[i];
    const pm25 = typeof a === "number" ? a / 10 : undefined;
    return { score: comfortScore(tempC, precipMm, pm25, year), tempC, precipMm, ...(pm25 !== undefined ? { pm25 } : {}) };
  });
}

export function decodeWeeks(cell: ClimateCell | undefined): WeekSeasonality[] | null {
  const w = cell?.w;
  if (!w || w.t.length !== WEEKS || w.p.length !== WEEKS) return null;
  const year = annualRain(w.p.map((p) => p / 10));
  return w.t.map((t, i) => {
    const tempC = t / 10;
    const precipMm = w.p[i]! / 10;
    const a = w.a?.[i];
    const pm25 = typeof a === "number" ? a / 10 : undefined;
    return { score: weeklyComfortBreakdown(tempC, precipMm, pm25, year).score, tempC, precipMm: Math.round(precipMm * 10) / 10, ...(pm25 !== undefined ? { pm25 } : {}) };
  });
}

export { WEEKS_PER_MONTH };

// ── file format ───────────────────────────────────────────────────────────

/** One cell per line, so a nightly update is a readable git diff. */
export function serializeClimateFile(file: ClimateFile): string {
  const keys = Object.keys(file.cells).sort((a, b) => {
    const [a1, a2] = a.split(",").map(Number) as [number, number];
    const [b1, b2] = b.split(",").map(Number) as [number, number];
    return a1 - b1 || a2 - b2;
  });
  const head = JSON.stringify({ version: file.version, weatherWindow: file.weatherWindow, airWindow: file.airWindow, generatedAt: file.generatedAt, cellDeg: file.cellDeg });
  const cells = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(file.cells[k])}`).join(",\n");
  return `${head.slice(0, -1)},\n"cells":{\n${cells}\n}}\n`;
}

export function parseClimateFile(text: string): ClimateFile | undefined {
  try {
    const f = JSON.parse(text) as ClimateFile;
    if (f && f.version === 1 && f.cells && typeof f.cells === "object") return f;
  } catch {
    // fall through
  }
  return undefined;
}

export const COMMITTED_CLIMATE_FILE = "climate-normals.json";

/** The committed dataset: a DATA_DIR copy first (tests, overrides), then the repo's data/ (DATA_DIR is a runtime disk in prod). */
export function readCommittedClimate(): ClimateFile {
  for (const p of new Set([getDataPath(COMMITTED_CLIMATE_FILE), join(process.cwd(), "data", COMMITTED_CLIMATE_FILE)])) {
    try {
      const f = parseClimateFile(readFileSync(p, "utf-8"));
      if (f) return f;
    } catch {
      // try the next location
    }
  }
  return emptyClimateFile();
}
