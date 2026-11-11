// Soft preferences for the solver (ADR 0015): "somewhere in SE Asia, Nov–Feb", "by the sea
// in summer", "no more than one long-haul per quarter". Each has a weight; the solver
// scores how much of it a rotation meets and shows that share.

import type { MonthSpan } from "../../types";
import { spanMonths } from "../season";
import { WORLD_REGIONS } from "../worldRegion";
import type { Candidate, Preference } from "./types";

/**
 * Sub-regions that the broad world regions are too coarse for, as country lists in the
 * city dataset's spelling. South-eastern Asia follows the UN M49 grouping.
 */
export const SUBREGIONS: Record<string, { label: string; countries: string[] }> = {
  "southeast-asia": {
    label: "Southeast Asia",
    countries: ["Brunei", "Cambodia", "Indonesia", "Laos", "Malaysia", "Myanmar", "Philippines", "Singapore", "Thailand", "Timor-Leste", "Vietnam"],
  },
  "southern-europe": {
    label: "Southern Europe",
    // UN M49 Southern Europe, plus Cyprus (Western Asia in M49).
    countries: ["Albania", "Andorra", "Bosnia and Herzegovina", "Croatia", "Cyprus", "Greece", "Italy", "Malta", "Montenegro", "North Macedonia", "Portugal", "San Marino", "Serbia", "Slovenia", "Spain"],
  },
  "latin-america": {
    label: "Latin America",
    countries: ["Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Costa Rica", "Cuba", "Dominican Republic", "Ecuador", "El Salvador", "Guatemala", "Honduras", "Mexico", "Nicaragua", "Panama", "Paraguay", "Peru", "Uruguay", "Venezuela"],
  },
};

/** Every region a region preference can name: sub-regions, broad regions, or "country:Name". */
export function regionOptions(): { value: string; label: string }[] {
  return [
    ...Object.entries(SUBREGIONS).map(([value, r]) => ({ value, label: r.label })),
    ...WORLD_REGIONS.map((r) => ({ value: r.value, label: r.label })),
  ];
}

export function regionLabel(region: string): string {
  if (region.startsWith("country:")) return region.slice(8);
  return SUBREGIONS[region]?.label ?? WORLD_REGIONS.find((r) => r.value === region)?.label ?? region;
}

/** Whether a candidate lies in a region preference's region. */
export function inRegion(c: Pick<Candidate, "place" | "region">, region: string): boolean {
  if (region.startsWith("country:")) return c.place.country === region.slice(8);
  const sub = SUBREGIONS[region];
  if (sub) return !!c.place.country && sub.countries.includes(c.place.country);
  return c.region === region;
}

export function monthsOf(span: MonthSpan): Set<number> {
  return new Set(spanMonths(span));
}

const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function spanLabel(span: MonthSpan): string {
  return span.start === span.end ? M[span.start - 1] : `${M[span.start - 1]}–${M[span.end - 1]}`;
}

/** Plain words for a preference: "Southeast Asia, Nov–Feb". */
export function preferenceLabel(p: Preference): string {
  if (p.label) return p.label;
  if (p.kind === "region") return `${regionLabel(p.region)}, ${spanLabel(p.months)}`;
  if (p.kind === "coast") return `By the sea (within ${p.maxKm} km), ${spanLabel(p.months)}`;
  return `At most ${p.maxPerQuarter} long-haul ${p.maxPerQuarter === 1 ? "flight" : "flights"} (${p.minHours} h or more) a quarter`;
}

/** Whether a month-scoped preference covers month m (1-12). Long-haul limits are per quarter, never per month. */
export function applies(p: Preference, m: number): boolean {
  return p.kind !== "long-haul" && monthsOf(p.months).has(m);
}

/**
 * Does a candidate meet a month-scoped preference in month m (1-12)? null when the
 * preference does not apply that month or the data to judge it is missing.
 */
export function meets(p: Preference, c: Candidate, m: number): boolean | null {
  if (p.kind === "long-haul") return null;
  if (!monthsOf(p.months).has(m)) return null;
  if (p.kind === "region") return inRegion(c, p.region);
  if (!c.coastKm) return null;
  return c.coastKm.value <= p.maxKm;
}
