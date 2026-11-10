// Columns and values for the When to go heatmap: one metric (comfort, temperature, rain,
// greenery) over one timeframe (12 months or 4 seasons). Pure: no React, no fetch.

import { lushIndex, type ClimateMode } from "./climate";
import { MONTH_NAMES, MONTH_SHORT } from "./repeatCopy";

export type Timeframe = "months" | "seasons";

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

export function frameColumns(tf: Timeframe): FrameColumn[] {
  return tf === "months" ? MONTH_COLUMNS : SEASON_COLUMNS;
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
}

const finite = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Per-month values of a metric; null where the data can't give one. */
export function monthValues(months: FrameMonth[], metric: ClimateMode): (number | null)[] {
  if (metric === "comfort") return months.map((m) => (finite(m.score) ? m.score : null));
  if (metric === "temperature") return months.map((m) => (finite(m.tempC) ? m.tempC : null));
  if (metric === "rainfall") return months.map((m) => (finite(m.precipMm) ? m.precipMm : null));
  // Greenery reads rain from the months before, so it needs the whole year.
  if (months.length !== 12 || !months.every((m) => finite(m.tempC) && finite(m.precipMm))) {
    return months.map(() => null);
  }
  const full = months.map((m) => ({ score: m.score, tempC: m.tempC!, precipMm: m.precipMm! }));
  return full.map((_, i) => lushIndex(full, i));
}

/** Values per column: the mean of the column's months, null if any month is missing. */
export function frameValues(months: FrameMonth[], metric: ClimateMode, tf: Timeframe): (number | null)[] {
  const vals = monthValues(months, metric);
  return frameColumns(tf).map((c) => {
    const xs = c.months.map((m) => vals[m]);
    if (xs.some((x) => x === null || x === undefined)) return null;
    return (xs as number[]).reduce((a, b) => a + b, 0) / xs.length;
  });
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
  }
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
