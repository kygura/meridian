// Crowd proxy (spec-journal §5): there is no free, reliable, global crowd
// dataset, so v1 combines
//   (a) a month-relative peak index from the city's own comfort curve
//       (tourist seasons track comfort seasons in most leisure destinations), and
//   (b) public-holiday overlap in the top source markets (Nager.Date, keyless).
// value = 0.7 a + 0.3 b, 0-100. Always a labeled proxy; a stop's
// crowdOverride wins over it (handled by the fingerprint).
//
// Nager.Date only publishes PUBLIC holidays (no school holidays), and only
// national ones (`global: true`) are counted.

import { readFileSync, readdirSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { peekCitySeasonality, type MonthSeasonality } from "./seasonality.js";
import { getDataPath, ensureDataDir } from "./paths.js";
import { daysInMonth, eachDay } from "./stayDates.js";

/**
 * Top outbound-tourism source markets (UNWTO international tourism
 * expenditure ranking, rounded): China, United States, Germany, United
 * Kingdom, France, Italy, Canada, South Korea. Kept to 8 so a year costs at
 * most 8 small cached requests.
 */
export const SOURCE_MARKETS = ["CN", "US", "DE", "GB", "FR", "IT", "CA", "KR"] as const;

export const PEAK_WEIGHT = 0.7;
export const HOLIDAY_WEIGHT = 0.3;
/** Mean share of holiday days across markets that maps to holiday index 100. */
export const HOLIDAY_SHARE_CAP = 0.1;
/** Minimum comfort range used to normalize the peak index (flat curves stay near 50). */
const MIN_PEAK_RANGE = 20;

export interface CrowdProxy {
  value: number;
  peak: number;
  /** 0-100 holiday index; absent when no holiday data was available. */
  holiday?: number;
  flags: ("holidays_unavailable" | "holidays_partial")[];
}

/** Per-month (index 0 = Jan) mean holiday share across markets, 0-1. */
export type HolidayIndex = number[];

/** Holiday dates (YYYY-MM-DD) per market for one year. */
export type MarketHolidays = Partial<Record<string, string[]>>;

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/**
 * (a) Month-relative peak index: the month's comfort score normalized within
 * the city's own 12 months (min→0, max→100). Curves with a range under 20
 * points are normalized over 20 so near-flat tropical curves don't swing 0-100.
 */
export function peakIndex(months: MonthSeasonality[], month: number): number {
  const scores = months.map((m) => m.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const denom = Math.max(max - min, MIN_PEAK_RANGE);
  const mid = (max + min) / 2;
  return Math.round(clamp(50 + ((months[month - 1]!.score - mid) / denom) * 100));
}

/** Mean over markets of the fraction of `days` that are holidays there. */
export function holidayShare(days: string[], holidays: MarketHolidays): number | undefined {
  // Sorted keys: float sums must not depend on insertion order (determinism).
  const markets = Object.keys(holidays)
    .sort()
    .map((k) => holidays[k])
    .filter((v): v is string[] => Array.isArray(v));
  if (markets.length === 0 || days.length === 0) return undefined;
  let sum = 0;
  for (const dates of markets) {
    const set = new Set(dates);
    sum += days.filter((d) => set.has(d)).length / days.length;
  }
  return sum / markets.length;
}

export function holidayShareToIndex(share: number): number {
  return Math.round(clamp((share / HOLIDAY_SHARE_CAP) * 100));
}

export function combineCrowd(peak: number, holiday: number | undefined): number {
  if (holiday === undefined) return peak;
  return Math.round(clamp(PEAK_WEIGHT * peak + HOLIDAY_WEIGHT * holiday));
}

/** Builds the 12-month holiday index from one or more years of market holidays (averaged). */
export function buildHolidayIndex(years: Record<number, MarketHolidays>): HolidayIndex | undefined {
  const entries = Object.entries(years);
  if (entries.length === 0) return undefined;
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) {
    let sum = 0;
    let n = 0;
    for (const [y, hol] of entries) {
      const year = Number(y);
      const mm = String(m).padStart(2, "0");
      const days = eachDay(`${year}-${mm}-01`, `${year}-${mm}-${String(daysInMonth(year, m)).padStart(2, "0")}`);
      const s = holidayShare(days, hol);
      if (s !== undefined) {
        sum += s;
        n++;
      }
    }
    if (n === 0) return undefined;
    out.push(sum / n);
  }
  return out;
}

/**
 * Synchronous fast path for the replay ranking loop: no network, ever.
 * `holidayIndex` comes from the on-disk cache (loadHolidayIndexFromCache);
 * without it the proxy is the peak index alone (flagged).
 */
export function crowdProxyForMonth(
  cityId: string,
  month: number,
  holidayIndex?: HolidayIndex,
  seasonality: (cityId: string) => MonthSeasonality[] | undefined = peekMonths
): CrowdProxy | undefined {
  const months = seasonality(cityId);
  if (!months || months.length !== 12) return undefined;
  const peak = peakIndex(months, month);
  const share = holidayIndex?.[month - 1];
  const holiday = share === undefined ? undefined : holidayShareToIndex(share);
  return {
    value: combineCrowd(peak, holiday),
    peak,
    holiday,
    flags: holiday === undefined ? ["holidays_unavailable"] : [],
  };
}

function peekMonths(cityId: string): MonthSeasonality[] | undefined {
  const p = peekCitySeasonality(cityId);
  return p.kind === "hit" ? p.months : undefined;
}

// ── Nager.Date fetch + disk cache (data/cache/holidays/{year}-{cc}.json) ──

export interface HolidayDeps {
  fetch: typeof fetch;
  /** Cache read/write; default is the disk cache. */
  cache?: { get(year: number, cc: string): string[] | undefined; set(year: number, cc: string, dates: string[]): void };
  timeoutMs?: number;
}

export function diskHolidayCache(): NonNullable<HolidayDeps["cache"]> {
  const file = (year: number, cc: string) => getDataPath("cache", "holidays", `${year}-${cc}.json`);
  return {
    get(year, cc) {
      try {
        const v = JSON.parse(readFileSync(file(year, cc), "utf-8"));
        return Array.isArray(v) ? (v as string[]) : undefined;
      } catch {
        return undefined;
      }
    },
    set(year, cc, dates) {
      ensureDataDir("cache", "holidays");
      const tmp = `${file(year, cc)}.tmp`;
      writeFileSync(tmp, JSON.stringify(dates));
      renameSync(tmp, file(year, cc));
    },
  };
}

/** Pure: Nager response → national holiday dates. */
export function parseNagerHolidays(body: unknown): string[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const dates = new Set<string>();
  for (const h of body as Array<{ date?: unknown; global?: unknown }>) {
    if (typeof h?.date === "string" && h.global !== false) dates.add(h.date.slice(0, 10));
  }
  return [...dates].sort();
}

export async function getMarketHolidays(year: number, cc: string, deps: HolidayDeps): Promise<string[] | undefined> {
  const cached = deps.cache?.get(year, cc);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 10_000);
  try {
    const res = await deps.fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const dates = parseNagerHolidays(await res.json());
    if (!dates) return undefined;
    deps.cache?.set(year, cc, dates);
    return dates;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function getYearHolidays(year: number, deps: HolidayDeps): Promise<{ holidays: MarketHolidays; failed: number }> {
  const holidays: MarketHolidays = {};
  let failed = 0;
  const results = await Promise.all(SOURCE_MARKETS.map((cc) => getMarketHolidays(year, cc, deps)));
  SOURCE_MARKETS.forEach((cc, i) => {
    if (results[i]) holidays[cc] = results[i];
    else failed++;
  });
  return { holidays, failed };
}

/**
 * Async proxy for a real stay (used by the fingerprint): peak index for the
 * month plus holiday overlap over the exact date range (or the whole month of
 * `year` when no range). Nager failure → peak only, flagged.
 */
export async function computeCrowdProxy(
  input: { cityId: string; month: number; year: number; dateRange?: { from: string; to: string } },
  deps: HolidayDeps & { seasonality: (cityId: string) => MonthSeasonality[] | undefined }
): Promise<CrowdProxy | undefined> {
  const months = deps.seasonality(input.cityId);
  if (!months || months.length !== 12) return undefined;
  const peak = peakIndex(months, input.month);

  const mm = String(input.month).padStart(2, "0");
  const days = input.dateRange
    ? eachDay(input.dateRange.from, input.dateRange.to)
    : eachDay(`${input.year}-${mm}-01`, `${input.year}-${mm}-${String(daysInMonth(input.year, input.month)).padStart(2, "0")}`);
  const years = [...new Set(days.map((d) => Number(d.slice(0, 4))))];

  const perYear = await Promise.all(years.map((y) => getYearHolidays(y, deps)));
  const failed = perYear.reduce((n, r) => n + r.failed, 0);
  // A market only counts when every year in the range resolved for it.
  const complete: MarketHolidays = {};
  for (const cc of SOURCE_MARKETS) {
    if (perYear.every((r) => r.holidays[cc])) complete[cc] = perYear.flatMap((r) => r.holidays[cc]!);
  }
  const share = holidayShare(days, complete);
  const holiday = share === undefined ? undefined : holidayShareToIndex(share);
  const flags: CrowdProxy["flags"] = [];
  if (holiday === undefined) flags.push("holidays_unavailable");
  else if (failed > 0) flags.push("holidays_partial");
  return { value: combineCrowd(peak, holiday), peak, holiday, flags };
}

/** Cache-only: builds the replay holiday index from whatever years are on disk. Never fetches. */
export function loadHolidayIndexFromCache(dir = getDataPath("cache", "holidays")): HolidayIndex | undefined {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const years: Record<number, MarketHolidays> = {};
  for (const f of files) {
    const m = /^(\d{4})-([A-Z]{2})\.json$/.exec(f);
    if (!m || !(SOURCE_MARKETS as readonly string[]).includes(m[2]!)) continue;
    try {
      const dates = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      if (!Array.isArray(dates)) continue;
      (years[Number(m[1])] ??= {})[m[2]!] = dates as string[];
    } catch {
      /* skip unreadable */
    }
  }
  return buildHolidayIndex(years);
}
