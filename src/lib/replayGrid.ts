// ReplayResponse -> heatmap grid model. The ONE place where replay's 1-based months
// (spec R3) meet the heatmap's 0-based columns: use monthToCol / colToMonth, never `- 1` elsewhere.

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

export const resultKey = (r: Pick<ReplayResult, "cityId" | "month">): string => `${r.cityId}:${r.month}`;
