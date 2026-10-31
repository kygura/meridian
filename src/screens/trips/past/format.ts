// Plain-language formatting for Trips › Past. Pure, no React.
// lib/journal's formatters return the old upper-case labels ("12 MAY"); the v3 UI uses
// sentence case ("12 May"), so dates, plurals and condition wording live here.

import type { Fingerprint, FingerprintDim, Journey, ProvenanceSource, Stop } from "../../../types";
import { COMFORT_DELTA } from "../../../lib/journal";

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

/** "12 May" */
export function day(s: string): string {
  const p = parts(s);
  return `${p.d} ${MONTH_SHORT[p.m - 1] ?? ""}`.trim();
}

/** "12 May 2024" */
export function dayYear(s: string): string {
  return `${day(s)} ${parts(s).y}`;
}

/**
 * Compact range. "12–20 May 2024", "28 May – 2 Jun 2024", "28 Dec 2023 – 3 Jan 2024".
 * `withYear: false` drops the year when both ends share it (rows already grouped by year).
 */
export function range(a: string, b: string, withYear = true): string {
  if (!a) return "";
  if (!b) b = a;
  const pa = parts(a);
  const pb = parts(b);
  const y = withYear ? ` ${pb.y}` : "";
  if (pa.y !== pb.y) return `${dayYear(a)} – ${dayYear(b)}`;
  if (pa.m !== pb.m) return `${day(a)} – ${day(b)}${y}`;
  if (pa.d !== pb.d) return `${pa.d}–${pb.d} ${MONTH_SHORT[pb.m - 1]}${y}`;
  return `${day(a)}${y}`;
}

/** "15 May, 09:40" or "15 May" for an ISO date or datetime. */
export function when(s: string): string {
  if (!s) return "";
  const time = /T(\d{2}:\d{2})/.exec(s)?.[1];
  return time ? `${day(s)}, ${time}` : day(s);
}

export const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** "1 night", "3 nights", "2 cities" (pass `many` for irregular plurals). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "ADD AT LEAST ONE STOP" -> "Add at least one stop" (journalForm messages are upper case). */
export function sentence(msg: string): string {
  const t = msg.trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Stop names joined with arrows: "Lisbon → Porto → Madrid". */
export function stopChain(j: Pick<Journey, "stops">, nameOf: (cityId: string) => string): string {
  const names: string[] = [];
  for (const s of j.stops) {
    const n = nameOf(s.cityId);
    if (names[names.length - 1] !== n) names.push(n);
  }
  return names.join(" → ");
}

// ── Conditions ───────────────────────────────────────────────────────

export const WEATHER_PENDING = "Weather pending — checks again later";
export const CROWDS_PENDING = "Crowds pending — checks again later";

/** 0-100 crowd level in words. */
export function crowdWord(n: number): string {
  if (n < 25) return "Quiet";
  if (n < 50) return "Fairly quiet";
  if (n < 75) return "Busy";
  return "Very busy";
}

export type ConditionState = "ok" | "pending" | "none";

export interface Condition {
  state: ConditionState;
  /** Main line: "22°C, usually 19°C". */
  text: string;
  /** Second line: "Nicer than usual · comfort 78 vs 70". */
  detail?: string;
  /** For a small badge. */
  tone?: "success" | "warning" | "neutral";
  badge?: string;
}

const isPending = (fp: Fingerprint | undefined, dims: FingerprintDim[]) =>
  !!fp && dims.some((d) => fp.status?.[d] === "pending");

/** Observed weather against the month's normal for one stop. */
export function weatherCondition(s: Stop, journeyFp?: Fingerprint): Condition {
  const o = s.observed;
  if (o) {
    const temp = `${Math.round(o.tempC)}°C`;
    const text = o.normalTempC !== undefined ? `${temp}, usually ${Math.round(o.normalTempC)}°C` : temp;
    const delta = o.comfort - o.normalComfort;
    const rain = `${Math.round(o.precipMm)} mm rain a month`;
    const comfort = `comfort ${Math.round(o.comfort)} vs ${Math.round(o.normalComfort)} usually`;
    if (delta >= COMFORT_DELTA) {
      return { state: "ok", text, detail: `${rain} · ${comfort}`, tone: "success", badge: "Nicer than usual" };
    }
    if (delta <= -COMFORT_DELTA) {
      return { state: "ok", text, detail: `${rain} · ${comfort}`, tone: "warning", badge: "Rougher than usual" };
    }
    return { state: "ok", text, detail: `${rain} · ${comfort}`, tone: "neutral", badge: "About usual" };
  }
  const weatherDims: FingerprintDim[] = ["comfort", "tempC", "precipMm"];
  if (isPending(s.fingerprint, weatherDims) || (!s.fingerprint && isPending(journeyFp, weatherDims))) {
    return { state: "pending", text: WEATHER_PENDING };
  }
  return { state: "none", text: "No weather recorded for these dates" };
}

/** Crowd level for one stop: your own call wins over the estimate. */
export function crowdCondition(s: Stop, journeyFp?: Fingerprint): Condition {
  if (s.crowdOverride !== undefined) {
    return { state: "ok", text: crowdWord(s.crowdOverride), detail: "Your own rating" };
  }
  const fp = s.fingerprint;
  if (fp && fp.status?.crowdProxy === "ok" && fp.crowdProxy !== undefined) {
    const partial = fp.crowdFlags?.length ? " (holiday data incomplete)" : "";
    return { state: "ok", text: crowdWord(fp.crowdProxy), detail: `Estimated from the season and school holidays${partial}` };
  }
  if (isPending(fp, ["crowdProxy"]) || (!fp && isPending(journeyFp, ["crowdProxy"]))) {
    return { state: "pending", text: CROWDS_PENDING };
  }
  return { state: "none", text: "No crowd estimate" };
}

// ── Fingerprint rows ─────────────────────────────────────────────────

export interface FingerprintRow {
  dim: FingerprintDim;
  label: string;
  state: ConditionState;
  value: string;
  /** Bar fill 0-1, fixed display scales. */
  fill: number;
  note?: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const eur = (n: number) => `€${num(n)}`;

const DIMS: {
  dim: FingerprintDim;
  label: string;
  value: (f: Fingerprint) => number | undefined;
  text: (n: number) => string;
  fill: (n: number) => number;
}[] = [
  { dim: "month", label: "Month", value: (f) => f.month, text: (n) => MONTH_LONG[n - 1] ?? "", fill: (n) => n / 12 },
  { dim: "comfort", label: "Comfort", value: (f) => f.comfort, text: (n) => `${Math.round(n)} of 100`, fill: (n) => n / 100 },
  { dim: "tempC", label: "Temperature", value: (f) => f.tempC, text: (n) => `${Math.round(n)}°C`, fill: (n) => (n + 10) / 50 },
  { dim: "precipMm", label: "Rain", value: (f) => f.precipMm, text: (n) => `${Math.round(n)} mm a month`, fill: (n) => n / 300 },
  { dim: "dailySpendEur", label: "Spend per day", value: (f) => f.dailySpendEur, text: eur, fill: (n) => n / 400 },
  { dim: "flightCostEurPer1000km", label: "Flights per 1,000 km", value: (f) => f.flightCostEurPer1000km, text: eur, fill: (n) => n / 400 },
  { dim: "crowdProxy", label: "Crowds", value: (f) => f.crowdProxy, text: crowdWord, fill: (n) => n / 100 },
];

export function fingerprintRows(fp: Fingerprint): FingerprintRow[] {
  return DIMS.map((d) => {
    const status = fp.status?.[d.dim] ?? "absent";
    const v = d.value(fp);
    if (status === "ok" && v !== undefined) {
      const note = d.dim === "crowdProxy" ? (fp.crowdIsOverride ? "Your own rating" : "Estimate") : undefined;
      return { dim: d.dim, label: d.label, state: "ok", value: d.text(v), fill: clamp01(d.fill(v)), note };
    }
    if (status === "pending") return { dim: d.dim, label: d.label, state: "pending", value: "Pending", fill: 0 };
    return { dim: d.dim, label: d.label, state: "none", value: "No data", fill: 0 };
  });
}

/** True when any weather dimension is still waiting on the weather service. */
export function weatherPending(fp: Fingerprint | undefined): boolean {
  return isPending(fp, ["comfort", "tempC", "precipMm"]);
}

// ── Provenance ───────────────────────────────────────────────────────

const SOURCE: Record<ProvenanceSource, string | null> = {
  manual: null,
  booking: "From a booking",
  gmail: "From email",
  jsonld: "From email",
  calendar: "From calendar",
  timeline: "From location history",
  photo: "From photos",
};

export function sourceLabel(source: ProvenanceSource | undefined): string | null {
  return source ? SOURCE[source] ?? null : null;
}
