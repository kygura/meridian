// The city metric surfaces (GET /api/metrics/surface/:id) the map can colour and filter
// cities by: the original social, political, infrastructure and economic signals.
// Pure: no React, no fetch.

import type { MetricSurface } from "../types";

export type MetricId = "stability" | "quality" | "connectivity" | "cost" | "tourism";

export interface MetricDef {
  id: MetricId;
  label: string;
  /** What the signal stands for. */
  theme: string;
  /** "min": higher is better, threshold is a floor. "max": lower is better, threshold is a ceiling. */
  direction: "min" | "max";
  low: string;
  high: string;
}

export const METRICS: MetricDef[] = [
  { id: "stability", label: "Safety", theme: "Political stability", direction: "min", low: "Unsettled", high: "Very stable" },
  { id: "quality", label: "Quality of life", theme: "Social", direction: "min", low: "Low", high: "High" },
  { id: "connectivity", label: "Internet", theme: "Infrastructure", direction: "min", low: "Poor", high: "Excellent" },
  { id: "cost", label: "Affordability", theme: "Economic", direction: "min", low: "Pricey", high: "Affordable" },
  { id: "tourism", label: "Crowds", theme: "Tourism pressure", direction: "max", low: "Quiet", high: "Crowded" },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export type MetricThresholds = Partial<Record<MetricId, number>>;

/** Thresholds that actually filter (a floor of 0 or a ceiling of 100 lets everything through). */
export function activeThresholds(t: MetricThresholds): [MetricId, number][] {
  return (Object.entries(t) as [MetricId, number][]).filter(([id, v]) => {
    const def = METRIC_BY_ID.get(id);
    if (!def || !Number.isFinite(v)) return false;
    return def.direction === "min" ? v > 0 : v < 100;
  });
}

/** cityId -> normalized value, per surface. */
export type MetricIndex = Partial<Record<MetricId, Map<string, number>>>;

export function indexSurfaces(surfaces: Record<string, MetricSurface | undefined>, ids: MetricId[]): MetricIndex {
  const out: MetricIndex = {};
  for (const id of ids) {
    const s = surfaces[id];
    if (!s) continue;
    const m = new Map<string, number>();
    for (const v of s.values) if (typeof v.normalized === "number") m.set(v.locationId, v.normalized);
    out[id] = m;
  }
  return out;
}

/** Does a city pass every active threshold? Missing values fail a threshold. */
export function passesThresholds(cityId: string, active: [MetricId, number][], index: MetricIndex): boolean {
  for (const [id, v] of active) {
    const value = index[id]?.get(cityId);
    if (value === undefined) return false;
    const def = METRIC_BY_ID.get(id)!;
    if (def.direction === "min" ? value < v : value > v) return false;
  }
  return true;
}
