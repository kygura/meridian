/**
 * Pure seasonality helpers — no React, no fetch.
 * Encoding rules follow DESIGN-heatmap.md §2 (bins) and §2.3 (best window).
 */

import type { SeasonMonth } from "./seasonalityApi";
import type { City, ShortlistEntry, TripNode } from "../types";

// ── Bins (DESIGN-heatmap.md §2) ─────────────────────────────────────

export const COMFORT_LABELS = [
  "HARSH",
  "THIN",
  "MILD",
  "FAIR",
  "GOOD",
  "PRIME",
] as const;

export type ComfortBin = 0 | 1 | 2 | 3 | 4 | 5;

/** The ONLY color logic in JS: score → bin index. Cells paint via CSS vars. */
export function comfortBin(score: number): ComfortBin {
  if (score >= 84) return 5;
  if (score >= 67) return 4;
  if (score >= 51) return 3;
  if (score >= 34) return 2;
  if (score >= 17) return 1;
  return 0;
}

/** CSS class for a heat cell, e.g. "heat-b3". */
export function heatClass(score: number): string {
  return `heat-b${comfortBin(score)}`;
}

export const MONTH_INITIALS = [
  "J",
  "F",
  "M",
  "A",
  "M",
  "J",
  "J",
  "A",
  "S",
  "O",
  "N",
  "D",
] as const;

export const MONTH_ABBR = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

// ── Best window (DESIGN-heatmap.md §2.3) ────────────────────────────

export interface BestWindow {
  /** 0-based month index (0 = January). */
  startMonth: number;
  endMonth: number;
  /** Month with the highest score inside the run. */
  peakMonth: number;
  /** True when the run crosses the December→January seam. */
  isWrap: boolean;
}

const CANDIDATE_MARGIN = 8;

/**
 * Strongest contiguous run of comfortable months, wrap-around aware.
 * Returns null when the input isn't a 12-month array.
 */
export function bestWindow(months: SeasonMonth[] | null | undefined): BestWindow | null {
  if (!months || months.length !== 12) return null;
  const scores = months.map((m) => m.score);
  const max = Math.max(...scores);
  const candidate = scores.map((s) => s >= max - CANDIDATE_MARGIN);
  const globalPeak = scores.indexOf(max);

  if (candidate.every(Boolean)) {
    // Whole year qualifies — represent as JAN–DEC, no wrap.
    return { startMonth: 0, endMonth: 11, peakMonth: globalPeak, isWrap: false };
  }

  // Enumerate circular runs (start = candidate month whose predecessor is not).
  const runs: Array<{ start: number; len: number }> = [];
  for (let i = 0; i < 12; i++) {
    const prev = (i + 11) % 12;
    if (candidate[i] && !candidate[prev]) {
      let len = 0;
      while (len < 12 && candidate[(i + len) % 12]) len++;
      runs.push({ start: i, len });
    }
  }

  const contains = (run: { start: number; len: number }, month: number) =>
    (month - run.start + 12) % 12 < run.len;

  // Longest run wins; ties prefer the run holding the global peak, then the
  // earliest start month.
  runs.sort(
    (a, b) =>
      b.len - a.len ||
      Number(contains(b, globalPeak)) - Number(contains(a, globalPeak)) ||
      a.start - b.start
  );

  const best = runs[0]!;
  const endMonth = (best.start + best.len - 1) % 12;

  let peakMonth = best.start;
  for (let k = 0; k < best.len; k++) {
    const m = (best.start + k) % 12;
    if (scores[m]! > scores[peakMonth]!) peakMonth = m;
  }

  return {
    startMonth: best.start,
    endMonth,
    peakMonth,
    isWrap: endMonth < best.start,
  };
}

/** True when the given 0-based month falls inside the (possibly wrapping) window. */
export function isMonthInWindow(window: BestWindow | null, month: number): boolean {
  if (!window) return false;
  const { startMonth, endMonth } = window;
  if (startMonth <= endMonth) return month >= startMonth && month <= endMonth;
  return month >= startMonth || month <= endMonth;
}

/** "MAY–SEP", single-month "MAY", full-year "JAN–DEC". */
export function formatBestSpan(window: BestWindow | null): string {
  if (!window) return "—";
  if (window.startMonth === window.endMonth) return MONTH_ABBR[window.startMonth]!;
  return `${MONTH_ABBR[window.startMonth]}–${MONTH_ABBR[window.endMonth]}`;
}

// ── Row assembly (DESIGN-heatmap.md §5) ─────────────────────────────

export type RowBadge = "SELECTED" | "SHORTLIST" | "TRIP" | "REGION";

export interface HeatRowDef {
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  badge: RowBadge;
}

interface AssembleArgs {
  selectedCityId: string | null;
  shortlist: Pick<ShortlistEntry, "cityId" | "name" | "country" | "iata">[];
  trips: Array<{ nodes: Array<Pick<TripNode, "cityId" | "name" | "iata">> }>;
  cities: Pick<City, "id" | "name" | "country" | "iata">[];
}

/**
 * Derived union of destination rows: selected city pinned first, then
 * shortlist, then trip cities. Deduped by cityId; badge precedence
 * SELECTED > SHORTLIST > TRIP.
 */
export function assembleCityRows(args: AssembleArgs): HeatRowDef[] {
  const { selectedCityId, shortlist, trips, cities } = args;
  const byId = new Map(cities.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rows: HeatRowDef[] = [];

  const push = (row: HeatRowDef) => {
    if (seen.has(row.cityId)) return;
    seen.add(row.cityId);
    rows.push(row);
  };

  if (selectedCityId) {
    const city = byId.get(selectedCityId);
    const fromShortlist = shortlist.find((s) => s.cityId === selectedCityId);
    if (city || fromShortlist) {
      push({
        cityId: selectedCityId,
        name: city?.name ?? fromShortlist?.name ?? selectedCityId,
        country: city?.country ?? fromShortlist?.country ?? "",
        iata: city?.iata ?? fromShortlist?.iata,
        badge: "SELECTED",
      });
    }
  }

  for (const s of shortlist) {
    const city = byId.get(s.cityId);
    push({
      cityId: s.cityId,
      name: s.name,
      country: s.country,
      iata: s.iata ?? city?.iata,
      badge: "SHORTLIST",
    });
  }

  for (const trip of trips) {
    for (const node of trip.nodes) {
      const city = byId.get(node.cityId);
      push({
        cityId: node.cityId,
        name: node.name,
        country: city?.country ?? "",
        iata: node.iata ?? city?.iata,
        badge: "TRIP",
      });
    }
  }

  return rows;
}

// ── Sorting (DESIGN-heatmap.md §3.3) ────────────────────────────────

export type SortMode = "best" | "az" | "peak";

function peakScore(months: SeasonMonth[] | null | undefined): number {
  if (!months || months.length === 0) return -1;
  return Math.max(...months.map((m) => m.score));
}

/**
 * Orders rows within a group. The pinned (selected) row is kept first
 * regardless of sort. Uncovered rows (no data) sort to the end for
 * "best" and "peak"; "az" is purely alphabetical.
 */
export function sortRows(
  rows: HeatRowDef[],
  data: Record<string, SeasonMonth[] | null | undefined>,
  mode: SortMode
): HeatRowDef[] {
  const pinned = rows.filter((r) => r.badge === "SELECTED");
  const rest = rows.filter((r) => r.badge !== "SELECTED");

  const sorted = [...rest].sort((a, b) => {
    if (mode === "az") return a.name.localeCompare(b.name);
    const da = data[a.cityId];
    const db = data[b.cityId];
    const covA = Array.isArray(da) && da.length === 12;
    const covB = Array.isArray(db) && db.length === 12;
    if (covA !== covB) return covA ? -1 : 1;
    if (!covA && !covB) return a.name.localeCompare(b.name);
    if (mode === "peak") {
      return peakScore(db) - peakScore(da) || a.name.localeCompare(b.name);
    }
    // "best": start month of the best window Jan→Dec, tie-broken by peak desc.
    const wa = bestWindow(da);
    const wb = bestWindow(db);
    return (
      (wa?.startMonth ?? 12) - (wb?.startMonth ?? 12) ||
      peakScore(db) - peakScore(da) ||
      a.name.localeCompare(b.name)
    );
  });

  return [...pinned, ...sorted];
}
