// Plain-language copy for Plan › Repeat a trip and When to go. Pure: no React, no fetch.
// Months are 1-based (1 = January) everywhere in this file.

import type { ReplayDim, ReplayQuery, ReplayResult } from "../types";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** 1-based month -> "October". */
export function monthName(m: number | undefined): string {
  return m && m >= 1 && m <= 12 ? MONTH_NAMES[m - 1]! : "";
}

/** Days from 1 January to the end of each month on a 365-day calendar. */
const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

/** Week of the year (1-52) -> "May 11–17" (the last week runs to 31 December). */
export function weekRangeLabel(week: number): string {
  const first = (week - 1) * 7 + 1;
  const last = week >= 52 ? 365 : first + 6;
  const at = (doy: number) => {
    const m = MONTH_STARTS.findIndex((s, i) => doy > s && doy <= MONTH_STARTS[i + 1]!);
    return { m, d: doy - MONTH_STARTS[m]! };
  };
  const a = at(first);
  const b = at(last);
  return a.m === b.m ? `${MONTH_SHORT[a.m]} ${a.d}–${b.d}` : `${MONTH_SHORT[a.m]} ${a.d} – ${MONTH_SHORT[b.m]} ${b.d}`;
}

/** When a result is: "May" at month resolution, "Week 19 · May 11–17" at week resolution. */
export function resultWhen(r: Pick<ReplayResult, "month" | "week">): string {
  return r.week !== undefined ? `Week ${r.week} · ${weekRangeLabel(r.week)}` : monthName(r.month);
}

/** 1-based month -> "Oct". */
export function monthShort(m: number | undefined): string {
  return m && m >= 1 && m <= 12 ? MONTH_SHORT[m - 1]! : "";
}

/** Inclusive month range, wrapping over the new year: (11, 2) -> [11, 12, 1, 2]. */
export function monthsBetween(from: number, to: number): number[] {
  const out: number[] = [];
  let m = from;
  for (let i = 0; i < 12; i++) {
    out.push(m);
    if (m === to) break;
    m = (m % 12) + 1;
  }
  return out;
}

/**
 * The (possibly wrapping) contiguous range a month list covers, or null when the list is
 * empty, covers every month, or has gaps.
 */
export function rangeOfMonths(months: number[]): { from: number; to: number } | null {
  const set = new Set(months.filter((m) => m >= 1 && m <= 12));
  if (set.size === 0 || set.size === 12) return null;
  for (const start of set) {
    const prev = ((start + 10) % 12) + 1;
    if (set.has(prev)) continue;
    let end = start;
    let len = 1;
    while (set.has((end % 12) + 1) && len < 12) {
      end = (end % 12) + 1;
      len++;
    }
    return len === set.size ? { from: start, to: end } : null;
  }
  return null;
}

/** "October", "October to December", "December to February". */
export function rangeLabel(r: { from: number; to: number }): string {
  return r.from === r.to ? monthName(r.from) : `${monthName(r.from)} to ${monthName(r.to)}`;
}

// ── Bend readouts ────────────────────────────────────────────────────

export function tempLabel(v: number): string {
  if (v === 0) return "Same temperature";
  return `${Math.abs(v)}°C ${v > 0 ? "warmer" : "cooler"}`;
}

export function budgetLabel(v: number): string {
  if (v === 0) return "Same budget";
  return `${Math.abs(v)}% ${v > 0 ? "more" : "less"} spend`;
}

export function crowdLabel(v: number): string {
  if (v === 0) return "Same crowds";
  return v < 0 ? `Quieter by ${Math.abs(v)}` : `Busier by ${v}`;
}

/** Month bend: shift relative to the template month, or any month. */
export function shiftLabel(shift: number, any: boolean, base: number | undefined): string {
  if (any) return "Any month";
  const target = base ? shiftMonthBy(base, shift) : undefined;
  if (shift === 0) return target ? `Same month (${monthName(target)})` : "Same month";
  const word = `${Math.abs(shift)} month${Math.abs(shift) === 1 ? "" : "s"} ${shift > 0 ? "later" : "earlier"}`;
  return target ? `${word} (${monthName(target)})` : word;
}

export function shiftMonthBy(month: number, shift: number): number {
  return ((((month - 1 + shift) % 12) + 12) % 12) + 1;
}

// ── Match ────────────────────────────────────────────────────────────

export const MATCH_WORDS = ["Distant", "Loose", "Some likeness", "Fair", "Close", "Near twin"] as const;

/** Plain word for a 0-100 match. */
export function matchWord(score: number): string {
  if (score >= 84) return MATCH_WORDS[5];
  if (score >= 67) return MATCH_WORDS[4];
  if (score >= 51) return MATCH_WORDS[3];
  if (score >= 34) return MATCH_WORDS[2];
  if (score >= 17) return MATCH_WORDS[1];
  return MATCH_WORDS[0];
}

/** 0-100 -> sequential ramp step 0..6. */
export function scoreStep(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(6, Math.round((score / 100) * 6)));
}

export const DIM_WORDS: Record<ReplayDim, string> = {
  month: "Season",
  weekOfYear: "Season",
  comfort: "Comfort",
  tempC: "Temperature",
  precipMm: "Rain",
  dailySpendEur: "Budget",
  flightCostEurPer1000km: "Flight cost",
  crowdProxy: "Crowds",
};

const CLIMATE_DIMS: ReplayDim[] = ["month", "weekOfYear", "comfort", "tempC", "precipMm"];

/** "Mostly climate and budget": the two strongest contributors, grouped. */
export function whyText(r: Pick<ReplayResult, "dims">): string {
  const groups = new Map<string, number>();
  for (const d of r.dims) {
    const g = CLIMATE_DIMS.includes(d.name)
      ? "climate"
      : d.name === "dailySpendEur"
        ? "budget"
        : d.name === "crowdProxy"
          ? "crowds"
          : "flight cost";
    groups.set(g, (groups.get(g) ?? 0) + d.contribution);
  }
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g]) => g);
  if (top.length === 0) return "";
  return `Mostly ${top.join(" and ")}`;
}

/** Climate line for a result: "22°C, 3 mm rain". Empty when neither was scored. */
export function climateText(r: Pick<ReplayResult, "dims">): string {
  const t = r.dims.find((d) => d.name === "tempC");
  const p = r.dims.find((d) => d.name === "precipMm");
  const parts: string[] = [];
  if (t) parts.push(`${Math.round(t.value)}°C`);
  if (p) parts.push(`${Math.round(p.value)} mm rain`);
  return parts.join(", ");
}

/** Crowds line: "Quieter (48 vs 62)". Empty when crowds were not scored. */
export function crowdText(r: Pick<ReplayResult, "dims">): string {
  const c = r.dims.find((d) => d.name === "crowdProxy");
  if (!c) return "";
  const v = Math.round(c.value);
  const t = Math.round(c.templateValue);
  const word = v < t - 3 ? "Quieter" : v > t + 3 ? "Busier" : "About the same";
  return `${word} (${v} vs ${t})`;
}

/** Signed percent change of a price against its baseline, or undefined. */
export function priceDelta(p: NonNullable<ReplayResult["price"]>): number | undefined {
  return p.priceEur !== undefined && p.baselineEur ? Math.round(((p.priceEur - p.baselineEur) / p.baselineEur) * 100) : undefined;
}

export function euros(n: number): string {
  return `€${Math.round(n).toLocaleString("en-US")}`;
}

/** "€214" or "214 USD". */
export function priceText(p: NonNullable<ReplayResult["price"]>): string {
  return p.priceEur !== undefined ? euros(p.priceEur) : `${Math.round(p.priceAmount)} ${p.currency}`;
}

// ── Watch summary ────────────────────────────────────────────────────

/** One plain sentence restating a replay query, for the watch sheet. */
export function querySentence(q: ReplayQuery, likeWhat: string, cityName?: (id: string) => string): string {
  const parts: string[] = [];
  const b = q.bend;
  if (b.tempC) parts.push(tempLabel(b.tempC));
  if (b.spendPct) parts.push(budgetLabel(b.spendPct).toLowerCase());
  if (b.crowd) parts.push(b.crowd < 0 ? "quieter" : "busier");
  if (b.monthShift === null) parts.push("any month");
  else if (b.monthShift) parts.push(`${Math.abs(b.monthShift)} month${Math.abs(b.monthShift) === 1 ? "" : "s"} ${b.monthShift > 0 ? "later" : "earlier"}`);
  const c = q.constraints;
  if (c?.cityIds?.length) parts.push(`only ${c.cityIds.map((id) => cityName?.(id) ?? id).join(", ")}`);
  if (c?.months?.length) {
    const r = rangeOfMonths(c.months);
    parts.push(`in ${r ? rangeLabel(r) : c.months.map(monthName).join(", ")}`);
  }
  if (c?.excludeVisited) parts.push("new places only");
  if (c?.maxFlightHours) parts.push(`flights up to ${c.maxFlightHours} hours`);
  const head = `Places like ${likeWhat}`;
  return parts.length ? `${head}, ${parts.join(", ")}.` : `${head}.`;
}
