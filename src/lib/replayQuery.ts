// Pure helpers for the replay controls (DESIGN-journal.md §7.2). No React, no fetch.

import type { Fingerprint, FingerprintDim, Journey, ReplayQuery, ReplayWeights } from "../types";
import { MONTHS, formatEur, monthOf } from "./journal";

export interface ReplayControls {
  tempC: number;
  spendPct: number;
  crowd: number;
  monthShift: number;
  anyMonth: boolean;
  weights: ReplayWeights;
  /** 1-based months; empty = every month. */
  months: number[];
  regions: string[];
  excludeVisited: boolean;
  maxFlightHours: number | null;
  /** null = the server's home city. */
  fromCityId: string | null;
  tags: string[];
}

export const DEFAULT_WEIGHTS: ReplayWeights = { climate: 0.45, spend: 0.2, crowd: 0.2, flight: 0.15 };

export const DEFAULT_CONTROLS: ReplayControls = {
  tempC: 0,
  spendPct: 0,
  crowd: 0,
  monthShift: 0,
  anyMonth: false,
  weights: DEFAULT_WEIGHTS,
  months: [],
  regions: [],
  excludeVisited: false,
  maxFlightHours: null,
  fromCityId: null,
  tags: [],
};

export function resetBend(c: ReplayControls): ReplayControls {
  return { ...c, tempC: 0, spendPct: 0, crowd: 0, monthShift: 0, anyMonth: false };
}

export interface ReplayTemplateRef {
  journeyId: string;
  stopIndex: number | null;
}

export function buildQuery(c: ReplayControls, t: ReplayTemplateRef): ReplayQuery {
  const constraints: NonNullable<ReplayQuery["constraints"]> = {};
  if (c.months.length) constraints.months = [...c.months].sort((a, b) => a - b);
  if (c.regions.length) constraints.regions = c.regions;
  if (c.excludeVisited) constraints.excludeVisited = true;
  if (c.maxFlightHours !== null) constraints.maxFlightHours = c.maxFlightHours;
  if (c.fromCityId) constraints.fromCityId = c.fromCityId;
  if (c.tags.length) constraints.tags = c.tags;
  return {
    template: { journeyId: t.journeyId, ...(t.stopIndex !== null ? { stopIndex: t.stopIndex } : {}) },
    bend: { tempC: c.tempC, spendPct: c.spendPct, crowd: c.crowd, monthShift: c.anyMonth ? null : c.monthShift },
    weights: c.weights,
    ...(Object.keys(constraints).length ? { constraints } : {}),
  };
}

/** The controls a stored query was built from (inverse of buildQuery); `month` pins the months constraint to one window. */
export function controlsFromQuery(q: ReplayQuery, month?: number): ReplayControls {
  const c = q.constraints ?? {};
  return {
    ...DEFAULT_CONTROLS,
    tempC: q.bend.tempC ?? 0,
    spendPct: q.bend.spendPct ?? 0,
    crowd: q.bend.crowd ?? 0,
    monthShift: q.bend.monthShift ?? 0,
    anyMonth: q.bend.monthShift === null,
    weights: q.weights ?? DEFAULT_WEIGHTS,
    months: month ? [month] : [...(c.months ?? [])],
    regions: [...(c.regions ?? [])],
    excludeVisited: !!c.excludeVisited,
    maxFlightHours: c.maxFlightHours ?? null,
    fromCityId: c.fromCityId ?? null,
    tags: [...(c.tags ?? [])],
  };
}

/** Row-level watch: the same query narrowed to one city and month (spec R7 cityIds). */
export function narrowQuery(q: ReplayQuery, cityId: string, month: number): ReplayQuery {
  return { ...q, constraints: { ...q.constraints, cityIds: [cityId], months: [month] } };
}

// ── Template ─────────────────────────────────────────────────────────

export function templateFingerprint(j: Journey | undefined, stopIndex: number | null): Fingerprint | undefined {
  if (!j) return undefined;
  return stopIndex !== null ? j.stops[stopIndex]?.fingerprint : j.fingerprint;
}

/** The template's own month (before the bend), 1-12. */
export function templateMonth(j: Journey | undefined, stopIndex: number | null): number | undefined {
  if (!j) return undefined;
  const fp = templateFingerprint(j, stopIndex);
  if (fp?.month) return fp.month;
  return monthOf(stopIndex !== null ? j.stops[stopIndex]?.arrive ?? j.startDate : j.startDate);
}

/** `month` moved by `shift`, wrapped into 1-12. */
export function shiftMonth(month: number, shift: number): number {
  return ((((month - 1 + shift) % 12) + 12) % 12) + 1;
}

export interface CardItem {
  key: string;
  text: string;
  /** Anything but "ok" renders an em dash plus a chip. */
  status: "ok" | "pending" | "absent";
}

/** `MAY · 21°C · 4 MM · €96/DAY · CROWD 62 (PROXY)` as items, so each dimension can carry its own status chip. */
export function templateCard(fp: Fingerprint | undefined): CardItem[] {
  const item = (key: FingerprintDim, value: number | undefined, text: (n: number) => string): CardItem => {
    const status = fp?.status[key] ?? "absent";
    return { key, text: status === "ok" && typeof value === "number" ? text(value) : "—", status: fp ? status : "absent" };
  };
  return [
    item("month", fp?.month, (n) => MONTHS[n - 1] ?? "—"),
    item("tempC", fp?.tempC, (n) => `${Math.round(n)}°C`),
    item("precipMm", fp?.precipMm, (n) => `${Math.round(n)} MM`),
    item("dailySpendEur", fp?.dailySpendEur, (n) => `${formatEur(n)}/DAY`),
    item("crowdProxy", fp?.crowdProxy, (n) => `CROWD ${Math.round(n)} (PROXY)`),
  ];
}

// ── Weights ──────────────────────────────────────────────────────────

export type WeightKey = keyof ReplayWeights;
export const WEIGHT_KEYS: WeightKey[] = ["climate", "spend", "crowd", "flight"];

/** Which weighted dimensions the template can score. Unknown (no fingerprint yet) counts as scorable. */
export function scorableWeights(fp: Fingerprint | undefined, climate: "observed" | "normal" | "none" | undefined): Record<WeightKey, boolean> {
  return {
    climate: climate !== "none",
    spend: !fp || (fp.status.dailySpendEur === "ok" && typeof fp.dailySpendEur === "number"),
    crowd: !fp || typeof fp.crowdProxy === "number",
    // Flight always has the deal-rating fallback server-side.
    flight: true,
  };
}

/** Normalized share (whole %) per weight; null for an unscorable dimension. */
export function weightShares(w: ReplayWeights, scorable: Record<WeightKey, boolean>): Record<WeightKey, number | null> {
  const total = WEIGHT_KEYS.reduce((n, k) => n + (scorable[k] ? w[k] : 0), 0);
  const out = {} as Record<WeightKey, number | null>;
  for (const k of WEIGHT_KEYS) out[k] = !scorable[k] ? null : total > 0 ? Math.round((w[k] / total) * 100) : 0;
  return out;
}

// ── Readouts ─────────────────────────────────────────────────────────

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export function tempReadout(v: number): { text: string; spoken: string } {
  return {
    text: `${signed(v)} °C`,
    spoken: v === 0 ? "same temperature" : `${Math.abs(v)} degrees ${v > 0 ? "warmer" : "cooler"}`,
  };
}

export function spendReadout(v: number): { text: string; spoken: string } {
  return {
    text: `${signed(v)} %`,
    spoken: v === 0 ? "same spend" : `${Math.abs(v)} percent ${v > 0 ? "more" : "less"} spend`,
  };
}

export function crowdReadout(v: number): { text: string; spoken: string } {
  return {
    text: v === 0 ? "SAME" : `${v < 0 ? "FEWER" : "MORE"} ${Math.abs(v)}`,
    spoken: v === 0 ? "same crowds" : `${v < 0 ? "fewer" : "more"} crowds by ${Math.abs(v)}`,
  };
}

export function monthReadout(shift: number, any: boolean, base: number | undefined): { text: string; spoken: string } {
  if (any) return { text: "ANY", spoken: "any month" };
  const target = base ? MONTHS[shiftMonth(base, shift) - 1] : undefined;
  return {
    text: `${signed(shift)} MO${target ? ` → ${target}` : ""}`,
    spoken: shift === 0 ? "same month" : `${Math.abs(shift)} months ${shift > 0 ? "later" : "earlier"}`,
  };
}

/** `TEMPLATE LISBON MAY · +3°C · −25 % SPEND · MONTHS JUN` for the watch sheet. */
export function querySummary(q: ReplayQuery, title: string): string {
  const parts = [`TEMPLATE ${title.toUpperCase()}`];
  const b = q.bend;
  if (b.tempC) parts.push(`${signed(b.tempC)}°C`);
  if (b.spendPct) parts.push(`${signed(b.spendPct)} % SPEND`);
  if (b.crowd) parts.push(`${b.crowd < 0 ? "FEWER" : "MORE"} CROWDS ${Math.abs(b.crowd)}`);
  if (b.monthShift === null) parts.push("ANY MONTH");
  else if (b.monthShift) parts.push(`${signed(b.monthShift)} MO`);
  const c = q.constraints;
  if (c?.cityIds?.length) parts.push(`CITY ${c.cityIds.join(", ").toUpperCase()}`);
  if (c?.months?.length) parts.push(`MONTHS ${c.months.map((m) => MONTHS[m - 1]).join(" ")}`);
  if (c?.regions?.length) parts.push(`IN ${c.regions.join(", ").toUpperCase()}`);
  if (c?.excludeVisited) parts.push("NEW PLACES ONLY");
  if (c?.maxFlightHours) parts.push(`≤ ${c.maxFlightHours} H FLIGHT`);
  if (c?.tags?.length) parts.push(`EVENTS ${c.tags.join(", ").toUpperCase()}`);
  return parts.join(" · ");
}
