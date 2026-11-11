// Climate traits for the map's Seasons layer. Pure: no React, no fetch.
//
// The seasonality dataset holds 12 monthly normals per city (mean temperature, total
// precipitation, Comfort Index). This module reads more than "comfortable or not" out of
// them: how warm, how wet, how green, whether it snows, and lets the map search and filter
// for those conditions. The greenery figure is a proxy (recent rain x warmth for growth),
// not satellite NDVI; label it as such in the UI.

import { airBand, type AirBand } from "./comfort";

export interface ClimateMonth {
  score: number;
  tempC: number;
  precipMm: number;
  /** Monthly mean PM2.5 in ug/m3; absent where the air-quality data hasn't reached the place. */
  pm25?: number;
}

export type Warmth = "freezing" | "cold" | "cool" | "mild" | "warm" | "hot";
export type Wetness = "arid" | "dry" | "moderate" | "wet" | "soaked";
export type Greenery = "barren" | "sparse" | "green" | "lush";

export interface MonthTraits {
  comfort: number;
  tempC: number;
  precipMm: number;
  warmth: Warmth;
  wetness: Wetness;
  /** 0-100 vegetation proxy. */
  lush: number;
  greenery: Greenery;
  snowy: boolean;
  /** Monthly mean PM2.5 in ug/m3, when known. */
  pm25?: number;
  air?: AirBand;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function warmthOf(tempC: number): Warmth {
  if (tempC < 0) return "freezing";
  if (tempC < 10) return "cold";
  if (tempC < 17) return "cool";
  if (tempC < 23) return "mild";
  if (tempC < 28) return "warm";
  return "hot";
}

export function wetnessOf(precipMm: number): Wetness {
  if (precipMm < 10) return "arid";
  if (precipMm < 40) return "dry";
  if (precipMm < 100) return "moderate";
  if (precipMm < 200) return "wet";
  return "soaked";
}

/**
 * Vegetation proxy, 0-100, for month `i` (0-based). Water comes from the last three
 * months of rain (soil memory) blended with the annual total; growth is shut off by
 * frost and eased back by extreme heat.
 */
export function lushIndex(months: ClimateMonth[], i: number): number {
  const n = months.length;
  if (!n) return 0;
  const at = (k: number) => months[((k % n) + n) % n]!;
  const recent = (at(i).precipMm + at(i - 1).precipMm + at(i - 2).precipMm) / 3;
  const annual = months.reduce((s, m) => s + m.precipMm, 0) * (12 / n);
  const water = 0.6 * clamp01((recent - 15) / 85) + 0.4 * clamp01((annual - 250) / 1250);
  const t = at(i).tempC;
  let growth: number;
  if (t <= 0) growth = 0;
  else if (t < 8) growth = t / 8;
  else if (t <= 32) growth = 1;
  else growth = Math.max(0.5, 1 - (0.5 * (t - 32)) / 8);
  return Math.round(100 * water * growth);
}

export function greeneryOf(lush: number): Greenery {
  if (lush < 20) return "barren";
  if (lush < 45) return "sparse";
  if (lush < 70) return "green";
  return "lush";
}

/** Traits for one month (1-12) of a 12-month profile, or null when the month is missing. */
export function monthTraits(months: ClimateMonth[], month: number): MonthTraits | null {
  const m = months[month - 1];
  if (!m || !Number.isFinite(m.tempC) || !Number.isFinite(m.precipMm)) return null;
  const lush = lushIndex(months, month - 1);
  return {
    comfort: m.score,
    tempC: m.tempC,
    precipMm: m.precipMm,
    warmth: warmthOf(m.tempC),
    wetness: wetnessOf(m.precipMm),
    lush,
    greenery: greeneryOf(lush),
    snowy: m.tempC <= 1 && m.precipMm >= 15,
    ...(typeof m.pm25 === "number" && Number.isFinite(m.pm25) ? { pm25: m.pm25, air: airBand(m.pm25) } : {}),
  };
}

// ── Conditions: the searchable vocabulary ──────────────────────────────

export type ConditionGroup = "warmth" | "wetness" | "greenery" | "snow" | "air";
/** Air conditions merge "hazardous" into "unhealthy" so the filter stays four chips. */
export type AirCondition = "clean" | "moderate" | "poor" | "unhealthy";
export type ConditionId = `warmth:${Warmth}` | `wetness:${Wetness}` | `greenery:${Greenery}` | "snow:snowy" | `air:${AirCondition}`;

export interface Condition {
  id: ConditionId;
  group: ConditionGroup;
  label: string;
  /** Range or definition, shown under the label. */
  detail: string;
  keywords: string[];
}

export const CONDITIONS: Condition[] = [
  { id: "warmth:freezing", group: "warmth", label: "Freezing", detail: "Below 0°C", keywords: ["frozen", "icy", "subzero", "arctic", "frost"] },
  { id: "warmth:cold", group: "warmth", label: "Cold", detail: "0–10°C", keywords: ["chilly", "wintry", "winter", "coat"] },
  { id: "warmth:cool", group: "warmth", label: "Cool", detail: "10–17°C", keywords: ["crisp", "fresh", "brisk", "autumn", "fall"] },
  { id: "warmth:mild", group: "warmth", label: "Mild", detail: "17–23°C", keywords: ["temperate", "spring", "pleasant", "comfortable", "t-shirt"] },
  { id: "warmth:warm", group: "warmth", label: "Warm", detail: "23–28°C", keywords: ["balmy", "summer", "summery", "sunny"] },
  { id: "warmth:hot", group: "warmth", label: "Hot", detail: "28°C and up", keywords: ["scorching", "heat", "sweltering", "tropical", "baking"] },
  { id: "wetness:arid", group: "wetness", label: "Arid", detail: "Under 10 mm rain", keywords: ["desert", "rainless", "parched", "bone-dry"] },
  { id: "wetness:dry", group: "wetness", label: "Dry", detail: "10–40 mm rain", keywords: ["sunny", "clear", "fair", "dry-season"] },
  { id: "wetness:moderate", group: "wetness", label: "Some rain", detail: "40–100 mm rain", keywords: ["moderate", "showers", "changeable"] },
  { id: "wetness:wet", group: "wetness", label: "Wet", detail: "100–200 mm rain", keywords: ["rainy", "damp", "drizzle", "umbrella"] },
  { id: "wetness:soaked", group: "wetness", label: "Very wet", detail: "200 mm rain and up", keywords: ["monsoon", "downpour", "soaked", "deluge", "rainy-season"] },
  { id: "greenery:barren", group: "greenery", label: "Barren", detail: "Little growth", keywords: ["desert", "bare", "brown", "dusty", "rocky"] },
  { id: "greenery:sparse", group: "greenery", label: "Sparse", detail: "Scrub and steppe", keywords: ["scrub", "steppe", "savanna", "golden", "semi-arid"] },
  { id: "greenery:green", group: "greenery", label: "Green", detail: "Leafy and growing", keywords: ["leafy", "verdant", "blooming", "bloom", "meadow"] },
  { id: "greenery:lush", group: "greenery", label: "Lush", detail: "Dense and verdant", keywords: ["jungle", "rainforest", "verdant", "overgrown", "tropical"] },
  { id: "snow:snowy", group: "snow", label: "Snowy", detail: "Freezing with precipitation", keywords: ["snow", "ski", "skiing", "powder", "white"] },
  { id: "air:clean", group: "air", label: "Clean air", detail: "PM2.5 under 10 µg/m³", keywords: ["breathe", "fresh", "pure", "unpolluted", "clear-air"] },
  { id: "air:moderate", group: "air", label: "Moderate air", detail: "PM2.5 10–25 µg/m³", keywords: ["haze", "hazy", "city-air"] },
  { id: "air:poor", group: "air", label: "Poor air", detail: "PM2.5 25–55 µg/m³", keywords: ["smog", "smoggy", "pollution", "polluted"] },
  { id: "air:unhealthy", group: "air", label: "Unhealthy air", detail: "PM2.5 over 55 µg/m³", keywords: ["smoke", "smoky", "burning", "burning-season", "wildfire", "toxic"] },
];

const CONDITION_BY_ID = new Map(CONDITIONS.map((c) => [c.id, c]));

export function conditionById(id: string): Condition | undefined {
  return CONDITION_BY_ID.get(id as ConditionId);
}

export const GROUP_LABELS: Record<ConditionGroup, string> = {
  warmth: "Temperature",
  wetness: "Rain",
  greenery: "Greenery",
  snow: "Snow",
  air: "Air quality",
};

export interface ClimateFilter {
  /** OR within a group, AND across groups. */
  conditions: ConditionId[];
  /** Minimum Comfort Index, 0 = off. */
  minComfort: number;
}

export const EMPTY_FILTER: ClimateFilter = { conditions: [], minComfort: 0 };

export function isFilterActive(f: ClimateFilter): boolean {
  return f.conditions.length > 0 || f.minComfort > 0;
}

function traitFor(group: ConditionGroup, t: MonthTraits): string {
  switch (group) {
    case "warmth":
      return `warmth:${t.warmth}`;
    case "wetness":
      return `wetness:${t.wetness}`;
    case "greenery":
      return `greenery:${t.greenery}`;
    case "snow":
      return t.snowy ? "snow:snowy" : "";
    case "air":
      // A month with no air-quality figure cannot be said to have clean air, so it never matches an air condition.
      return t.air ? `air:${t.air === "hazardous" ? "unhealthy" : t.air}` : "";
  }
}

/** Does a month meet the filter? */
export function matchesFilter(t: MonthTraits, f: ClimateFilter): boolean {
  if (f.minComfort > 0 && t.comfort < f.minComfort) return false;
  const byGroup = new Map<ConditionGroup, Set<string>>();
  for (const id of f.conditions) {
    const c = CONDITION_BY_ID.get(id);
    if (!c) continue;
    const set = byGroup.get(c.group) ?? new Set<string>();
    set.add(id);
    byGroup.set(c.group, set);
  }
  for (const [group, ids] of byGroup) if (!ids.has(traitFor(group, t))) return false;
  return true;
}

// ── Presets ────────────────────────────────────────────────────────────

export interface ClimatePreset {
  id: string;
  label: string;
  keywords: string[];
  filter: ClimateFilter;
}

export const PRESETS: ClimatePreset[] = [
  { id: "beach", label: "Beach weather", keywords: ["beach", "swim", "sea", "sun", "coast"], filter: { conditions: ["warmth:warm", "warmth:hot", "wetness:arid", "wetness:dry", "wetness:moderate"], minComfort: 0 } },
  { id: "green-mild", label: "Green and mild", keywords: ["hike", "hiking", "walk", "nature", "spring"], filter: { conditions: ["warmth:mild", "warmth:warm", "greenery:green", "greenery:lush"], minComfort: 0 } },
  { id: "tropical", label: "Tropical lush", keywords: ["jungle", "rainforest", "tropics"], filter: { conditions: ["warmth:warm", "warmth:hot", "greenery:lush"], minComfort: 0 } },
  { id: "desert", label: "Desert sun", keywords: ["desert", "dunes", "sahara"], filter: { conditions: ["warmth:warm", "warmth:hot", "greenery:barren"], minComfort: 0 } },
  { id: "crisp", label: "Crisp and dry", keywords: ["autumn", "fall", "city", "walking"], filter: { conditions: ["warmth:cool", "wetness:arid", "wetness:dry"], minComfort: 0 } },
  { id: "escape-heat", label: "Escape the heat", keywords: ["cool", "summer", "heatwave", "escape"], filter: { conditions: ["warmth:cool", "warmth:mild"], minComfort: 0 } },
  { id: "snow", label: "Snow season", keywords: ["ski", "snow", "winter", "christmas"], filter: { conditions: ["snow:snowy"], minComfort: 0 } },
  { id: "breathe", label: "Breathe easy", keywords: ["breathe", "clean", "fresh", "asthma", "lungs"], filter: { conditions: ["air:clean"], minComfort: 0 } },
  { id: "pleasant", label: "Comfortable", keywords: ["pleasant", "nice", "best", "comfort", "ideal"], filter: { conditions: [], minComfort: 70 } },
];

// ── Search ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["and", "&", "but", "with", "the", "a", "an", "+", "or", "weather", "climate", "very", "somewhere", "places", "place"]);

function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,;/]+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOP_WORDS.has(t));
}

const hay = (label: string, keywords: string[]) => [label.toLowerCase(), ...keywords];
const hits = (words: string[], token: string) => words.some((w) => w.startsWith(token) || w.split(/[\s-]/).some((p) => p.startsWith(token)));

export interface ClimateSearch {
  conditions: Condition[];
  presets: ClimatePreset[];
  /** Conditions read off a free-text phrase ("warm dry green"), one best guess per word. */
  parsed: ConditionId[];
}

/** Match a free-text query against conditions and presets. */
export function searchClimate(query: string): ClimateSearch {
  const toks = tokens(query);
  if (!toks.length) return { conditions: CONDITIONS, presets: PRESETS, parsed: [] };
  const anyTok = (words: string[]) => toks.some((t) => hits(words, t));
  const conditions = CONDITIONS.filter((c) => anyTok(hay(c.label, c.keywords)));
  const presets = PRESETS.filter((p) => anyTok(hay(p.label, p.keywords)));
  const parsed: ConditionId[] = [];
  for (const t of toks) {
    // Exact label first ("dry" is Dry, not every keyword containing it), then keywords.
    const exact = CONDITIONS.find((c) => c.label.toLowerCase() === t || c.id.split(":")[1] === t);
    const byKeyword = exact ?? CONDITIONS.find((c) => c.keywords.includes(t));
    const loose = byKeyword ?? (t.length >= 3 ? CONDITIONS.find((c) => hits(hay(c.label, c.keywords), t)) : undefined);
    if (loose && !parsed.includes(loose.id)) parsed.push(loose.id);
  }
  return { conditions, presets, parsed };
}

/** Add or remove one condition. */
export function toggleCondition(list: ConditionId[], id: ConditionId): ConditionId[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Short summary of a filter, e.g. "Warm or Hot · Dry · Comfort 70+". */
export function describeFilter(f: ClimateFilter): string {
  const parts: string[] = [];
  for (const group of Object.keys(GROUP_LABELS) as ConditionGroup[]) {
    const labels = f.conditions.map((id) => CONDITION_BY_ID.get(id)).filter((c) => c?.group === group).map((c) => c!.label);
    if (labels.length) parts.push(labels.join(" or "));
  }
  if (f.minComfort > 0) parts.push(`Comfort ${f.minComfort}+`);
  return parts.join(" · ");
}

// ── Tint modes ─────────────────────────────────────────────────────────

export type ClimateMode = "comfort" | "temperature" | "rainfall" | "greenery" | "air";

export const CLIMATE_MODES: { value: ClimateMode; label: string; low: string; high: string }[] = [
  { value: "comfort", label: "Comfort", low: "Harsh", high: "Pleasant" },
  { value: "temperature", label: "Temp", low: "Cold", high: "Hot" },
  { value: "rainfall", label: "Rain", low: "Dry", high: "Wet" },
  { value: "greenery", label: "Green", low: "Barren", high: "Lush" },
  { value: "air", label: "Air", low: "Clean", high: "Smoky" },
];

const TEMP_STEPS = [-5, 5, 12, 18, 24, 29];
const RAIN_STEPS = [10, 30, 60, 100, 150, 220];
const LUSH_STEPS = [10, 25, 40, 55, 70, 85];
/** PM2.5 (ug/m3) edges: under 5 is step 0, then the clean / moderate / poor / unhealthy cut-offs at 10, 25, 55 and beyond. */
const AIR_STEPS = [5, 10, 18, 25, 55, 100];

const stepOf = (v: number, edges: number[]) => edges.filter((e) => v >= e).length;

/** Ramp step 0-6 for a raw value in a tint mode (comfort 0-100, °C, mm, lush 0-100). */
export function valueStep(mode: ClimateMode, v: number): number {
  switch (mode) {
    case "comfort":
      return 1 + Math.max(0, Math.min(5, Math.round((v / 100) * 5)));
    case "temperature":
      return stepOf(v, TEMP_STEPS);
    case "rainfall":
      return stepOf(v, RAIN_STEPS);
    case "greenery":
      return stepOf(v, LUSH_STEPS);
    case "air":
      return stepOf(v, AIR_STEPS);
  }
}

/** Ramp step 0-6 for a month in a tint mode. Comfort skips step 0 (too close to plain land). */
export function modeStep(mode: ClimateMode, t: MonthTraits): number {
  const v = mode === "comfort" ? t.comfort : mode === "temperature" ? t.tempC : mode === "rainfall" ? t.precipMm : mode === "air" ? (t.pm25 ?? 0) : t.lush;
  return valueStep(mode, v);
}

/** Token names of the 7-step ramp a mode paints with. */
export function modeRampVars(mode: ClimateMode): string[] {
  const prefix = mode === "comfort" ? "--ramp" : mode === "temperature" ? "--temp" : mode === "rainfall" ? "--wet" : mode === "air" ? "--smoke" : "--green";
  return [0, 1, 2, 3, 4, 5, 6].map((i) => `${prefix}-${i}`);
}
