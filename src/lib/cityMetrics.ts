// The city metric surfaces (GET /api/metrics/surface/:id) the map can colour and filter
// cities by. Each is computed from measured data (ADR 0008, ADR 0013); `basis` says what from
// and how local it is. A city the data doesn't cover has no value on that surface.
// Pure: no React, no fetch.

import type { MetricSurface } from "../types";

export type MetricId = "stability" | "quality" | "beauty" | "connectivity" | "cost" | "tourism" | "health";

export interface MetricDef {
  id: MetricId;
  label: string;
  /** What the signal stands for. */
  theme: string;
  /** "min": higher is better, threshold is a floor. "max": lower is better, threshold is a ceiling. */
  direction: "min" | "max";
  low: string;
  high: string;
  /** Where the numbers come from and how local they are, in one line. */
  basis: string;
}

export const METRICS: MetricDef[] = [
  {
    id: "stability",
    label: "Safety",
    theme: "Political stability",
    direction: "min",
    low: "Unsettled",
    high: "Very stable",
    basis: "Country figures: World Bank political stability and the homicide rate.",
  },
  {
    id: "quality",
    label: "Quality of life",
    theme: "How good it is to live there",
    direction: "min",
    low: "Low",
    high: "High",
    basis: "Mostly country figures (human development, life satisfaction, homicides); air is measured at major cities.",
  },
  {
    id: "beauty",
    label: "Beauty",
    theme: "Natural setting and built character",
    direction: "min",
    low: "Plain",
    high: "Striking",
    basis: "City figures: terrain, water, heritage sites, photos and notable places nearby.",
  },
  {
    id: "connectivity",
    label: "Internet",
    theme: "Download speed",
    direction: "min",
    low: "Slow",
    high: "Fast",
    basis: "City figures: Ookla speed tests within 5 to 20 km of the centre. 5 Mbps scores 0, 300 Mbps scores 100.",
  },
  {
    id: "cost",
    label: "Affordability",
    theme: "Monthly cost",
    direction: "min",
    low: "Pricey",
    high: "Affordable",
    basis: "An estimate of monthly cost for one person. City prices for about 170 cities (Eurostat), the country’s price level elsewhere (World Bank).",
  },
  {
    id: "tourism",
    label: "Crowds",
    theme: "Tourism pressure",
    direction: "max",
    low: "Quiet",
    high: "Crowded",
    basis: "Country figures: visitors from abroad per resident a year (UN Tourism). The same for every city in a country.",
  },
  {
    id: "health",
    label: "Healthcare",
    theme: "Service coverage",
    direction: "min",
    low: "Limited",
    high: "Strong",
    basis: "Country figures: the WHO index of essential health service coverage.",
  },
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
