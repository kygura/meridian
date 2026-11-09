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
  if (tf === "seasons") {
    const first = cols[run.start]!.months[0]!;
    const last = cols[run.end]!.months[2]!;
    return `${MONTH_SHORT[first]}–${MONTH_SHORT[last]}`;
  }
  if (run.start === run.end) return MONTH_SHORT[run.start]!;
  return `${MONTH_SHORT[run.start]}–${MONTH_SHORT[run.end]}`;
}
