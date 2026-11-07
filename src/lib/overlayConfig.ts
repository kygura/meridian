/**
 * Map overlay configuration: what the globe tints, which cities pass the filters, and
 * which signals (events, conflicts, disasters) are drawn. Pure: no React, no fetch.
 *
 * Weather is split into variables (temperature, rainfall, greenness, dryness, comfort)
 * and named conditions (warm, cold, lush, dry ...). Everything weather-related is derived
 * from the monthly temperature and rainfall normals in data/seasonality.json, so
 * "greenness" is a proxy from rain and warmth, not a satellite vegetation index.
 */

import { countryKey } from "./countryNames";
import { comfortBin } from "./seasonality";
import type { Phenomenon } from "./phenomena";
import type { MeridianEvent } from "../types";

// ── Metrics ─────────────────────────────────────────────────────────

export type WeatherVar = "comfort" | "temperature" | "rainfall" | "greenness" | "dryness";
export type SocietyVar = "stability" | "quality" | "cost" | "tourism" | "connectivity" | "density";
export type MetricKey = WeatherVar | SocietyVar;
export type MetricGroup = "weather" | "social" | "political" | "infrastructure";

export interface MetricDef {
  id: MetricKey;
  label: string;
  group: MetricGroup;
  hint: string;
  /** Native range of the value: the slider domain and the full-range "no filter" state. */
  domain: [number, number];
  unit: string;
  /** Legend end labels, low to high. */
  low: string;
  high: string;
  /** Varies by month (weather) or is one number per city. */
  monthly: boolean;
  /** Modelled or synthesized rather than measured. Shown as "Estimated" in the UI. */
  estimated: boolean;
  step: number;
}

export const GROUP_LABELS: Record<MetricGroup, string> = {
  weather: "Weather",
  social: "Social",
  political: "Political",
  infrastructure: "Infrastructure",
};

export const METRICS: MetricDef[] = [
  { id: "comfort", label: "Comfort", group: "weather", hint: "Temperature band minus rain penalty", domain: [0, 100], unit: "", low: "Harsh", high: "Pleasant", monthly: true, estimated: false, step: 5 },
  { id: "temperature", label: "Temperature", group: "weather", hint: "Mean monthly temperature", domain: [-30, 45], unit: "°C", low: "Cold", high: "Hot", monthly: true, estimated: false, step: 1 },
  { id: "rainfall", label: "Rainfall", group: "weather", hint: "Monthly precipitation total", domain: [0, 400], unit: "mm", low: "Dry", high: "Wet", monthly: true, estimated: false, step: 10 },
  { id: "greenness", label: "Greenness", group: "weather", hint: "Rain and warmth together (proxy, not satellite)", domain: [0, 100], unit: "", low: "Barren", high: "Lush", monthly: true, estimated: true, step: 5 },
  { id: "dryness", label: "Dryness", group: "weather", hint: "How little rain falls", domain: [0, 100], unit: "", low: "Humid", high: "Arid", monthly: true, estimated: true, step: 5 },
  { id: "stability", label: "Stability", group: "political", hint: "Political stability, by country", domain: [0, 100], unit: "", low: "Volatile", high: "Stable", monthly: false, estimated: true, step: 5 },
  { id: "quality", label: "Quality of life", group: "social", hint: "Overall livability", domain: [0, 100], unit: "", low: "Low", high: "High", monthly: false, estimated: true, step: 5 },
  { id: "cost", label: "Affordability", group: "social", hint: "Higher is cheaper to live in", domain: [0, 100], unit: "", low: "Pricey", high: "Affordable", monthly: false, estimated: true, step: 5 },
  { id: "tourism", label: "Crowds", group: "social", hint: "Tourism pressure", domain: [0, 100], unit: "", low: "Quiet", high: "Crowded", monthly: false, estimated: true, step: 5 },
  { id: "connectivity", label: "Internet", group: "infrastructure", hint: "Connection quality", domain: [0, 100], unit: "", low: "Poor", high: "Excellent", monthly: false, estimated: true, step: 5 },
  { id: "density", label: "City size", group: "infrastructure", hint: "Population relative to the largest city", domain: [0, 100], unit: "", low: "Small", high: "Megacity", monthly: false, estimated: false, step: 5 },
];

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));
export function metricDef(id: MetricKey): MetricDef {
  return BY_ID.get(id)!;
}

export const SOCIETY_KEYS: SocietyVar[] = ["stability", "quality", "cost", "tourism", "connectivity", "density"];
export const isSociety = (k: MetricKey): k is SocietyVar => (SOCIETY_KEYS as string[]).includes(k);

// ── Weather derivations ─────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 0-100 vegetation proxy from the month's normals. Needs water (full marks at 130 mm)
 * and warmth (growth starts at 2°C, full at 14°C), and fades above 34°C heat stress.
 */
export function greenness(tempC: number, precipMm: number): number {
  const water = clamp((precipMm - 20) / (130 - 20), 0, 1);
  const warmth = clamp((tempC - 2) / (14 - 2), 0, 1);
  const heat = tempC > 34 ? clamp((40 - tempC) / 6, 0, 1) : 1;
  return Math.round(100 * water * warmth * heat);
}

/** 0-100: 100 at no rain, 0 at 100 mm a month or more. */
export function dryness(precipMm: number): number {
  return Math.round(100 * (1 - clamp(precipMm / 100, 0, 1)));
}

export interface ClimateMonth {
  score: number;
  tempC: number;
  precipMm: number;
}

// ── Conditions ──────────────────────────────────────────────────────

export type ConditionId =
  | "freezing" | "cold" | "cool" | "mild" | "warm" | "hot"
  | "arid" | "dry" | "damp" | "wet"
  | "lush" | "snowy" | "pleasant";

export type ConditionGroup = "temperature" | "moisture" | "character";

export interface ConditionDef {
  id: ConditionId;
  label: string;
  group: ConditionGroup;
  /** Plain-language rule, shown as the chip's tooltip. */
  rule: string;
  test: (m: ClimateMonth) => boolean;
}

export const CONDITION_GROUPS: { id: ConditionGroup; label: string }[] = [
  { id: "temperature", label: "Temperature" },
  { id: "moisture", label: "Moisture" },
  { id: "character", label: "Character" },
];

export const CONDITIONS: ConditionDef[] = [
  { id: "freezing", label: "Freezing", group: "temperature", rule: "Below 0°C", test: (m) => m.tempC < 0 },
  { id: "cold", label: "Cold", group: "temperature", rule: "0 to 10°C", test: (m) => m.tempC >= 0 && m.tempC < 10 },
  { id: "cool", label: "Cool", group: "temperature", rule: "10 to 18°C", test: (m) => m.tempC >= 10 && m.tempC < 18 },
  { id: "mild", label: "Mild", group: "temperature", rule: "18 to 26°C", test: (m) => m.tempC >= 18 && m.tempC < 26 },
  { id: "warm", label: "Warm", group: "temperature", rule: "26 to 32°C", test: (m) => m.tempC >= 26 && m.tempC < 32 },
  { id: "hot", label: "Hot", group: "temperature", rule: "32°C and up", test: (m) => m.tempC >= 32 },
  { id: "arid", label: "Arid", group: "moisture", rule: "Under 20 mm of rain", test: (m) => m.precipMm < 20 },
  { id: "dry", label: "Dry", group: "moisture", rule: "20 to 50 mm", test: (m) => m.precipMm >= 20 && m.precipMm < 50 },
  { id: "damp", label: "Damp", group: "moisture", rule: "50 to 120 mm", test: (m) => m.precipMm >= 50 && m.precipMm < 120 },
  { id: "wet", label: "Wet", group: "moisture", rule: "120 mm and up", test: (m) => m.precipMm >= 120 },
  { id: "lush", label: "Lush & green", group: "character", rule: "Greenness 55 or more: plenty of rain and warmth", test: (m) => greenness(m.tempC, m.precipMm) >= 55 },
  { id: "snowy", label: "Snow likely", group: "character", rule: "At or below 1°C with 30 mm or more of precipitation", test: (m) => m.tempC <= 1 && m.precipMm >= 30 },
  { id: "pleasant", label: "Pleasant", group: "character", rule: "Comfort score 67 or more", test: (m) => comfortBin(m.score) >= 4 },
];

const COND_BY_ID = new Map(CONDITIONS.map((c) => [c.id, c]));
export const conditionDef = (id: ConditionId) => COND_BY_ID.get(id)!;

/** Every condition a month satisfies. */
export function monthConditions(m: ClimateMonth): ConditionId[] {
  return CONDITIONS.filter((c) => c.test(m)).map((c) => c.id);
}

// ── Signals ─────────────────────────────────────────────────────────

export type EventKind = MeridianEvent["kind"];
export const EVENT_KINDS: { id: EventKind; label: string }[] = [
  { id: "festival", label: "Festivals" },
  { id: "eclipse", label: "Eclipses" },
  { id: "culture", label: "Culture" },
  { id: "sport", label: "Sport" },
  { id: "other", label: "Other" },
];

export type DisasterType = "quake" | "storm" | "fire" | "flood" | "drought" | "volcano";
export const DISASTER_TYPES: { id: DisasterType; label: string }[] = [
  { id: "quake", label: "Quake" },
  { id: "storm", label: "Storm" },
  { id: "fire", label: "Fire" },
  { id: "flood", label: "Flood" },
  { id: "drought", label: "Drought" },
  { id: "volcano", label: "Volcano" },
];

export type Severity = 1 | 2 | 3;

export interface SignalConfig {
  /** Festivals, eclipses and other dated events pinned to their cities. */
  events: boolean;
  /** Only events in the selected month (off: the whole year). */
  eventsThisMonthOnly: boolean;
  /** Empty = every kind. */
  eventKinds: EventKind[];
  conflicts: boolean;
  disasters: boolean;
  /** Empty = every type. */
  disasterTypes: DisasterType[];
  /** Conflicts and disasters below this severity are hidden. */
  minSeverity: Severity;
}

// ── Config ──────────────────────────────────────────────────────────

/** How a weather filter treats the 12 months. */
export type MonthScope = "month" | "any" | "all";

export interface OverlayConfig {
  /** Country tint: which metric colours the land. */
  tint: MetricKey | "none";
  /** Flip the ramp (so "dry" reads dark, say). */
  invertTint: boolean;
  /** Weather conditions to match. Same group = either; different groups = both. */
  conditions: ConditionId[];
  /** "month": the selected month. "any": at least one month. "all": year-round. */
  monthScope: MonthScope;
  /** Value filters in each metric's native unit. A missing key = full range = off. */
  ranges: Partial<Record<MetricKey, [number, number]>>;
  /** Cities that fail the filters: "dim" fades them, "hide" removes them. */
  nonMatches: "dim" | "hide";
  signals: SignalConfig;
}

export const DEFAULT_SIGNALS: SignalConfig = {
  events: false,
  eventsThisMonthOnly: true,
  eventKinds: [],
  conflicts: false,
  disasters: false,
  disasterTypes: [],
  minSeverity: 1,
};

export const DEFAULT_OVERLAY: OverlayConfig = {
  tint: "comfort",
  invertTint: false,
  conditions: [],
  monthScope: "month",
  ranges: {},
  nonMatches: "dim",
  signals: DEFAULT_SIGNALS,
};

const KEYS = new Set<string>(METRICS.map((m) => m.id));
const COND_IDS = new Set<string>(CONDITIONS.map((c) => c.id));

/** Coerce anything (old or hand-edited localStorage) into a valid config. */
export function normalizeOverlay(raw: unknown): OverlayConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<OverlayConfig>;
  const s = (r.signals && typeof r.signals === "object" ? r.signals : {}) as Partial<SignalConfig>;
  const ranges: OverlayConfig["ranges"] = {};
  if (r.ranges && typeof r.ranges === "object") {
    for (const [k, v] of Object.entries(r.ranges)) {
      if (!KEYS.has(k) || !Array.isArray(v) || v.length !== 2) continue;
      const def = metricDef(k as MetricKey);
      const lo = clamp(Number(v[0]), def.domain[0], def.domain[1]);
      const hi = clamp(Number(v[1]), def.domain[0], def.domain[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      ranges[k as MetricKey] = [Math.min(lo, hi), Math.max(lo, hi)];
    }
  }
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const inList = <T extends string>(v: unknown, list: { id: T }[]): T[] =>
    Array.isArray(v) ? v.filter((x): x is T => list.some((l) => l.id === x)) : [];
  return {
    tint: r.tint === "none" || (typeof r.tint === "string" && KEYS.has(r.tint)) ? (r.tint as OverlayConfig["tint"]) : DEFAULT_OVERLAY.tint,
    invertTint: bool(r.invertTint, false),
    conditions: Array.isArray(r.conditions) ? r.conditions.filter((c): c is ConditionId => COND_IDS.has(c)) : [],
    monthScope: r.monthScope === "any" || r.monthScope === "all" ? r.monthScope : "month",
    ranges,
    nonMatches: r.nonMatches === "hide" ? "hide" : "dim",
    signals: {
      events: bool(s.events, false),
      eventsThisMonthOnly: bool(s.eventsThisMonthOnly, true),
      eventKinds: inList(s.eventKinds, EVENT_KINDS),
      conflicts: bool(s.conflicts, false),
      disasters: bool(s.disasters, false),
      disasterTypes: inList(s.disasterTypes, DISASTER_TYPES),
      minSeverity: s.minSeverity === 2 || s.minSeverity === 3 ? s.minSeverity : 1,
    },
  };
}

/** The ranges that actually narrow something (not the full domain). */
export function activeRanges(cfg: OverlayConfig): [MetricKey, [number, number]][] {
  const out: [MetricKey, [number, number]][] = [];
  for (const [k, v] of Object.entries(cfg.ranges) as [MetricKey, [number, number]][]) {
    const [d0, d1] = metricDef(k).domain;
    if (v[0] > d0 || v[1] < d1) out.push([k, v]);
  }
  return out;
}

export function filtersActive(cfg: OverlayConfig): boolean {
  return cfg.conditions.length > 0 || activeRanges(cfg).length > 0;
}

/** Number of narrowing filters, for the menu badge. */
export function filterCount(cfg: OverlayConfig): number {
  const groups = new Set(cfg.conditions.map((c) => conditionDef(c).group));
  return groups.size + activeRanges(cfg).length;
}

export function signalsActive(s: SignalConfig): boolean {
  return s.events || s.conflicts || s.disasters;
}

// ── Profiles and matching ───────────────────────────────────────────

/** Everything known about one city. */
export interface CityProfile {
  /** 12 entries, Jan..Dec. Undefined when the climate dataset doesn't cover the city. */
  climate?: ClimateMonth[];
  /** One value per society metric, 0-100. */
  scores: Partial<Record<SocietyVar, number>>;
}

/** Raw (native-unit) value of a metric for a city in a month, or null if unknown. */
export function metricValue(key: MetricKey, p: CityProfile, month: number): number | null {
  if (isSociety(key)) return p.scores[key] ?? null;
  const m = p.climate?.[month - 1];
  return m ? weatherValue(key, m) : null;
}

function weatherValue(key: WeatherVar, m: ClimateMonth): number {
  switch (key) {
    case "comfort": return m.score;
    case "temperature": return m.tempC;
    case "rainfall": return m.precipMm;
    case "greenness": return greenness(m.tempC, m.precipMm);
    case "dryness": return dryness(m.precipMm);
  }
}

/** Raw value -> 0-100 across the metric's domain (what the ramp is indexed by). */
export function normalizeMetric(key: MetricKey, raw: number): number {
  const [lo, hi] = metricDef(key).domain;
  return clamp(((raw - lo) / (hi - lo)) * 100, 0, 100);
}

/** "27°C", "84 mm", "72". */
export function formatMetric(key: MetricKey, raw: number): string {
  const d = metricDef(key);
  const n = key === "temperature" ? raw.toFixed(1).replace(/\.0$/, "") : String(Math.round(raw));
  return d.unit ? `${n}${d.unit === "°C" ? "" : " "}${d.unit}` : n;
}

function weatherPasses(m: ClimateMonth, byGroup: Map<ConditionGroup, ConditionId[]>, weatherRanges: [WeatherVar, [number, number]][]): boolean {
  for (const ids of byGroup.values()) if (!ids.some((id) => conditionDef(id).test(m))) return false;
  for (const [k, [lo, hi]] of weatherRanges) {
    const v = weatherValue(k, m);
    if (v < lo || v > hi) return false;
  }
  return true;
}

/**
 * Does a city pass every filter? Weather filters follow `monthScope`; society ranges
 * ignore the month. A city missing data a filter needs does not match.
 */
export function matchesCity(cfg: OverlayConfig, p: CityProfile, month: number): boolean {
  const ranges = activeRanges(cfg);
  for (const [k, [lo, hi]] of ranges) {
    if (!isSociety(k)) continue;
    const v = p.scores[k];
    if (v === undefined || v < lo || v > hi) return false;
  }
  const weatherRanges = ranges.filter((r): r is [WeatherVar, [number, number]] => !isSociety(r[0]));
  if (cfg.conditions.length === 0 && weatherRanges.length === 0) return true;
  if (!p.climate || p.climate.length !== 12) return false;

  const byGroup = new Map<ConditionGroup, ConditionId[]>();
  for (const id of cfg.conditions) {
    const g = conditionDef(id).group;
    byGroup.set(g, [...(byGroup.get(g) ?? []), id]);
  }
  const pass = (i: number) => weatherPasses(p.climate![i]!, byGroup, weatherRanges);
  if (cfg.monthScope === "month") return pass(month - 1);
  const months = Array.from({ length: 12 }, (_, i) => i);
  return cfg.monthScope === "any" ? months.some(pass) : months.every(pass);
}

/** Months (1-12) in which a city passes the weather filters. For the "when" readout. */
export function matchingMonths(cfg: OverlayConfig, p: CityProfile): number[] {
  const out: number[] = [];
  for (let m = 1; m <= 12; m++) if (matchesCity(cfg, p, m)) out.push(m);
  return out;
}

// ── Country tint ────────────────────────────────────────────────────

/**
 * Mean of a metric over each country's cities, as 0-100 ramp positions keyed by
 * countryKey. Cities without the value are skipped, so a country needs one covered city.
 */
export function countryTint(
  cities: { id: string; country: string }[],
  profiles: ReadonlyMap<string, CityProfile>,
  key: MetricKey,
  month: number
): Map<string, number> {
  const sum = new Map<string, { total: number; n: number }>();
  for (const c of cities) {
    const p = profiles.get(c.id);
    if (!p) continue;
    const v = metricValue(key, p, month);
    if (v === null) continue;
    const k = countryKey(c.country);
    const acc = sum.get(k) ?? { total: 0, n: 0 };
    acc.total += normalizeMetric(key, v);
    acc.n += 1;
    sum.set(k, acc);
  }
  const out = new Map<string, number>();
  for (const [k, { total, n }] of sum) out.set(k, total / n);
  return out;
}

// ── Signal filtering ────────────────────────────────────────────────

export function visibleEvents(events: MeridianEvent[], s: SignalConfig, month: number): MeridianEvent[] {
  if (!s.events) return [];
  return events.filter(
    (e) => (!s.eventsThisMonthOnly || e.month === month) && (s.eventKinds.length === 0 || s.eventKinds.includes(e.kind))
  );
}

export function visibleConflicts(items: Phenomenon[], s: SignalConfig): Phenomenon[] {
  return s.conflicts ? items.filter((p) => p.sev >= s.minSeverity) : [];
}

export function visibleDisasters(items: Phenomenon[], s: SignalConfig): Phenomenon[] {
  if (!s.disasters) return [];
  return items.filter(
    (p) => p.sev >= s.minSeverity && (s.disasterTypes.length === 0 || s.disasterTypes.includes((p.type ?? "") as DisasterType))
  );
}
