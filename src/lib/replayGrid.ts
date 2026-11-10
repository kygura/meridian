// ReplayResponse -> heatmap grid model. The ONE place where replay's 1-based months
// (spec R3) meet the heatmap's 0-based columns: use monthToCol / colToMonth, never `- 1` elsewhere.

import { monthOfWeek } from "./comfort";
import { comfortBin } from "./seasonality";
import type { MeridianEvent, ReplayResponse, ReplayResult } from "../types";

/** Server matches are fractional (95.4); the UI shows whole points. */
export const points = (n: number): number => Math.round(n);

export const monthToCol = (month: number): number => month - 1;
export const colToMonth = (col: number): number => col + 1;

/** Match ramp words, one per --heat-b0..5 bin (legend and tooltip). */
export const MATCH_LABELS = ["FAR", "LOOSE", "SOME", "FAIR", "CLOSE", "TWIN"] as const;
export const matchWord = (match: number): string => MATCH_LABELS[comfortBin(match)];

export interface ReplayCell {
  /** Whole points, 0-100. A ranked pair carries its final match; any other month the climate-stage score. */
  match: number;
  /** Set when this city x month is in `results` (price, dims, events live there). */
  result?: ReplayResult;
  events: MeridianEvent[];
}

export interface ReplayRowModel {
  cityId: string;
  /** 1-based, by best match. */
  rank: number;
  best: ReplayResult;
  /** Length 12, index = column. null = not scorable (renders as hatch). */
  cells: (ReplayCell | null)[];
}

/** Distinct result cities in order of their best match, each with 12 dense columns from `grid`. */
export function buildReplayRows(resp: ReplayResponse): ReplayRowModel[] {
  const gridByCity = new Map(resp.grid?.map((g) => [g.cityId, g.months]));
  const rows = new Map<string, ReplayRowModel>();
  for (const r of resp.results) {
    let row = rows.get(r.cityId);
    if (!row) {
      const stage1 = gridByCity.get(r.cityId);
      row = {
        cityId: r.cityId,
        rank: rows.size + 1,
        best: r,
        cells: Array.from({ length: 12 }, (_, col) => {
          const m = stage1?.[col];
          return typeof m === "number" ? { match: points(m), events: [] } : null;
        }),
      };
      rows.set(r.cityId, row);
    }
    row.cells[monthToCol(r.month)] = { match: points(r.match), result: r, events: r.events ?? [] };
    if (r.match > row.best.match) row.best = r;
  }
  return [...rows.values()];
}

/** Header marks: the template's own month, and (when bent) the month it is bent to. */
export function replayMarks(
  templateMonth: number | undefined,
  targetMonth: number | undefined
): { col: number; kind: "template" | "target" }[] {
  const marks: { col: number; kind: "template" | "target" }[] = [];
  if (templateMonth) marks.push({ col: monthToCol(templateMonth), kind: "template" });
  if (targetMonth && targetMonth !== templateMonth) marks.push({ col: monthToCol(targetMonth), kind: "target" });
  return marks;
}

export const resultKey = (r: Pick<ReplayResult, "cityId" | "month"> & { week?: number }): string =>
  r.week !== undefined ? `${r.cityId}:w${r.week}` : `${r.cityId}:${r.month}`;

export interface WeekCell extends ReplayCell {
  /** True when the figure is the month's, shown flat across its weeks (the city has no weekly normals). */
  monthly?: boolean;
}

export interface WeekRowModel {
  cityId: string;
  rank: number;
  best: ReplayResult;
  /** Length 52, index = week - 1. */
  cells: (WeekCell | null)[];
}

/**
 * Week-resolution rows: each result city across 52 weeks. A city with weekly normals shows its
 * weekly stage-1 scores with its ranked weeks overlaid; a city matched by month shows its month's
 * figure flat across that month's weeks, marked `monthly`.
 */
export function buildWeekRows(resp: ReplayResponse): WeekRowModel[] {
  const weekGrid = new Map(resp.weekGrid?.map((g) => [g.cityId, g.weeks]));
  const monthGrid = new Map(resp.grid?.map((g) => [g.cityId, g.months]));
  const rows = new Map<string, WeekRowModel>();
  for (const r of resp.results) {
    let row = rows.get(r.cityId);
    if (!row) {
      const weekly = weekGrid.get(r.cityId);
      const monthly = monthGrid.get(r.cityId);
      row = {
        cityId: r.cityId,
        rank: rows.size + 1,
        best: r,
        cells: Array.from({ length: 52 }, (_, i): WeekCell | null => {
          if (weekly) {
            const m = weekly[i];
            return typeof m === "number" ? { match: points(m), events: [] } : null;
          }
          const m = monthly?.[monthOfWeek(i + 1) - 1];
          return typeof m === "number" ? { match: points(m), events: [], monthly: true } : null;
        }),
      };
      rows.set(r.cityId, row);
    }
    if (r.week !== undefined) {
      row.cells[r.week - 1] = { match: points(r.match), result: r, events: r.events ?? [] };
    } else {
      // A month-resolution result stands for every week of its month.
      row.cells.forEach((cell, i) => {
        if (monthOfWeek(i + 1) === r.month) row!.cells[i] = { match: points(r.match), result: r, events: r.events ?? [], monthly: true };
      });
    }
    if (r.match > row.best.match) row.best = r;
  }
  return [...rows.values()];
}
