// Columns and values for the When to go heatmap: one metric (comfort, temperature, rain,
// greenery) over one timeframe (12 months or 4 seasons). Pure: no React, no fetch.

import { lushIndex, type ClimateMode } from "./climate";
import { comfortBreakdown, monthOfWeek, weeklyComfortBreakdown } from "./comfort";
import { MONTH_NAMES, MONTH_SHORT } from "./repeatCopy";

export type Timeframe = "months" | "seasons" | "weeks";

export interface FrameColumn {
  /** Header text on wide screens. */
  short: string;
  /** Header text on narrow screens. */
  tiny: string;
  /** Accessible / popover name. */
  name: string;
  /** 0-based months this column averages. */
  months: number[];
}

const MONTH_COLUMNS: FrameColumn[] = MONTH_SHORT.map((m, i) => ({
  short: m,
  tiny: m[0]!,
  name: MONTH_NAMES[i]!,
  months: [i],
}));

// Calendar quarters by meteorological season. Named by months, not "summer", so they
// read the same in both hemispheres.
const SEASON_COLUMNS: FrameColumn[] = [
  { short: "Dec–Feb", tiny: "DJF", name: "December to February", months: [11, 0, 1] },
  { short: "Mar–May", tiny: "MAM", name: "March to May", months: [2, 3, 4] },
  { short: "Jun–Aug", tiny: "JJA", name: "June to August", months: [5, 6, 7] },
  { short: "Sep–Nov", tiny: "SON", name: "September to November", months: [8, 9, 10] },
];

// 52 week-of-year columns. The header names the month on its first week and stays quiet on the rest.
const WEEK_COLUMNS: FrameColumn[] = Array.from({ length: 52 }, (_, i) => {
  const week = i + 1;
  const month = monthOfWeek(week) - 1;
  const first = i === 0 || monthOfWeek(week - 1) - 1 !== month;
  return { short: first ? MONTH_SHORT[month]! : "", tiny: first ? MONTH_SHORT[month]![0]! : "", name: `Week ${week}, ${MONTH_NAMES[month]}`, months: [month] };
});

export function frameColumns(tf: Timeframe): FrameColumn[] {
  return tf === "months" ? MONTH_COLUMNS : tf === "weeks" ? WEEK_COLUMNS : SEASON_COLUMNS;
}

/** Column holding the given 0-based month. */
export function columnOfMonth(tf: Timeframe, month: number): number {
  return frameColumns(tf).findIndex((c) => c.months.includes(month));
}

/** A month as the API gives it; country aggregates may lack temperature and rain. */
export interface FrameMonth {
  score: number;
  tempC?: number;
  precipMm?: number;
  pm25?: number;
}

const finite = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Per-month values of a metric; null where the data can't give one. */
export function monthValues(months: FrameMonth[], metric: ClimateMode): (number | null)[] {
  if (metric === "comfort") return months.map((m) => (finite(m.score) ? m.score : null));
  if (metric === "temperature") return months.map((m) => (finite(m.tempC) ? m.tempC : null));
  if (metric === "rainfall") return months.map((m) => (finite(m.precipMm) ? m.precipMm : null));
  if (metric === "air") return months.map((m) => (finite(m.pm25) ? m.pm25 : null));
  // Greenery reads rain from the months before, so it needs the whole year.
  if (months.length !== 12 || !months.every((m) => finite(m.tempC) && finite(m.precipMm))) {
    return months.map(() => null);
  }
  const full = months.map((m) => ({ score: m.score, tempC: m.tempC!, precipMm: m.precipMm! }));
  return full.map((_, i) => lushIndex(full, i));
}

/**
 * Values per column: the mean of the column's months, null if any month is missing. In the weeks
 * timeframe a place with 52 weekly normals uses them; a place without falls back to its month's
 * figure for each week of that month (a monthly value shown flat, not interpolated). Greenery
 * reads a whole year of months, so it is always the month's.
 */
export function frameValues(months: FrameMonth[], metric: ClimateMode, tf: Timeframe, weeks?: FrameMonth[] | null): (number | null)[] {
  if (tf === "weeks" && weeks && weeks.length === 52 && metric !== "greenery") {
    return weeks.map((w) => monthValues([w], metric)[0] ?? null);
  }
  const vals = monthValues(months, metric);
  return frameColumns(tf).map((c) => {
    const xs = c.months.map((m) => vals[m]);
    if (xs.some((x) => x === null || x === undefined)) return null;
    return (xs as number[]).reduce((a, b) => a + b, 0) / xs.length;
  });
}

/** The Comfort Index terms for a column, averaged over its months or taken from the week; null where temperature or rain is missing. */
export function frameBreakdown(
  months: FrameMonth[],
  tf: Timeframe,
  col: number,
  weeks?: FrameMonth[] | null
): { temp: number; rain: number; air: number; airKnown: boolean; score: number; tempC: number; precipMm: number; pm25?: number; per: "month" | "week" } | null {
  const usable = (m: FrameMonth | undefined): m is FrameMonth & { tempC: number; precipMm: number } => !!m && finite(m.tempC) && finite(m.precipMm);
  if (tf === "weeks" && weeks && weeks.length === 52) {
    const w = weeks[col];
    if (!usable(w)) return null;
    return { ...weeklyComfortBreakdown(w.tempC, w.precipMm, w.pm25), tempC: w.tempC, precipMm: w.precipMm, pm25: w.pm25, per: "week" };
  }
  const picked = frameColumns(tf)[col]!.months.map((i) => months[i]);
  if (!picked.every(usable)) return null;
  const parts = picked.map((m) => comfortBreakdown(m.tempC, m.precipMm, m.pm25));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const air = picked.filter((m) => finite(m.pm25)).map((m) => m.pm25 as number);
  const airKnown = air.length === picked.length;
  return {
    temp: mean(parts.map((p) => p.temp)),
    rain: mean(parts.map((p) => p.rain)),
    air: mean(parts.map((p) => p.air)),
    airKnown,
    score: Math.round(mean(parts.map((p) => p.score))),
    tempC: mean(picked.map((m) => m.tempC)),
    precipMm: mean(picked.map((m) => m.precipMm)),
    pm25: airKnown ? mean(air) : undefined,
    per: "month",
  };
}

/** Cell text: "82", "24°", "85", "63". */
export function formatMetric(metric: ClimateMode, v: number): string {
  if (metric === "temperature") return `${Math.round(v)}°`;
  return String(Math.round(v));
}

/** Long form for popovers and screen readers. */
export function describeMetric(metric: ClimateMode, v: number): string {
  switch (metric) {
    case "comfort":
      return `comfort ${Math.round(v)}`;
    case "temperature":
      return `${Math.round(v)}°C`;
    case "rainfall":
      return `${Math.round(v)} mm of rain a month`;
    case "greenery":
      return `greenery ${Math.round(v)}`;
    case "air":
      return `PM2.5 ${Math.round(v)} µg/m³`;
  }
}

export interface BestRun {
  start: number;
  end: number;
  peak: number;
  /** Column indices inside the run, in order. */
  cols: number[];
}

const MARGIN = 8;

/**
 * Longest wrap-around run of columns within 8 points of the best comfort score. Ties go
 * to the run holding the peak, then the earliest start. Null when any column is missing.
 */
export function bestRun(scores: (number | null)[]): BestRun | null {
  const n = scores.length;
  if (n === 0 || scores.some((s) => s === null)) return null;
  const s = scores as number[];
  const max = Math.max(...s);
  const ok = s.map((x) => x >= max - MARGIN);
  const peak = s.indexOf(max);
  const span = (start: number, len: number) => Array.from({ length: len }, (_, k) => (start + k) % n);

  if (ok.every(Boolean)) return { start: 0, end: n - 1, peak, cols: span(0, n) };

  const runs: { start: number; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (ok[i] && !ok[(i + n - 1) % n]) {
      let len = 0;
      while (len < n && ok[(i + len) % n]) len++;
      runs.push({ start: i, len });
    }
  }
  const has = (r: { start: number; len: number }) => (peak - r.start + n) % n < r.len;
  runs.sort((a, b) => b.len - a.len || Number(has(b)) - Number(has(a)) || a.start - b.start);
  const r = runs[0]!;
  const cols = span(r.start, r.len);
  const runPeak = cols.reduce((p, c) => (s[c]! > s[p]! ? c : p), cols[0]!);
  return { start: r.start, end: cols[cols.length - 1]!, peak: runPeak, cols };
}

/** "May–Sep", "Jun–Aug", "All year". */
export function bestRunLabel(run: BestRun | null, tf: Timeframe): string {
  if (!run) return "";
  const cols = frameColumns(tf);
  if (run.cols.length === cols.length) return "All year";
  if (tf === "weeks") {
    const first = cols[run.start]!.months[0]!;
    const last = cols[run.end]!.months[0]!;
    return first === last ? `${MONTH_SHORT[first]}` : `${MONTH_SHORT[first]}–${MONTH_SHORT[last]}`;
  }
  if (tf === "seasons") {
    const first = cols[run.start]!.months[0]!;
    const last = cols[run.end]!.months[2]!;
    return `${MONTH_SHORT[first]}–${MONTH_SHORT[last]}`;
  }
  if (run.start === run.end) return MONTH_SHORT[run.start]!;
  return `${MONTH_SHORT[run.start]}–${MONTH_SHORT[run.end]}`;
}

// ── Time window ────────────────────────────────────────────────────────

/** "2026-11-10" -> Date at local midnight, or null. */
function parseDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 0-based months a date range touches, in calendar order from the start date
 * ("2026-12-20".."2027-01-05" -> [11, 0]). A year or more gives all 12. Null when either
 * date is invalid or the range runs backwards.
 */
export function monthsInRange(from: string, to: string): number[] | null {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b || b < a) return null;
  const span = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
  if (span >= 12) return Array.from({ length: 12 }, (_, i) => (a.getMonth() + i) % 12);
  return Array.from({ length: span }, (_, i) => (a.getMonth() + i) % 12);
}

/** Mean comfort over the window's months; null when any of them has no score. */
export function windowScore(months: FrameMonth[], window: number[]): number | null {
  if (window.length === 0) return null;
  let sum = 0;
  for (const m of window) {
    const v = months[m]?.score;
    if (!finite(v)) return null;
    sum += v;
  }
  return sum / window.length;
}

/** Columns of a timeframe that overlap the window's months. */
export function columnsInWindow(tf: Timeframe, window: number[]): number[] {
  return frameColumns(tf)
    .map((c, i) => (c.months.some((m) => window.includes(m)) ? i : -1))
    .filter((i) => i >= 0);
}

/** "Nov", "Dec–Jan", "All year". */
export function windowLabel(window: number[]): string {
  if (window.length === 0) return "";
  if (window.length >= 12) return "All year";
  const first = MONTH_SHORT[window[0]!]!;
  return window.length === 1 ? first : `${first}–${MONTH_SHORT[window[window.length - 1]!]}`;
}
