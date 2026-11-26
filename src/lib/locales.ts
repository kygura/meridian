// Locales: researched home bases, hubs and destinations for a nomadic rotation (ADR 0022).
//
// A Locale is a place checked as somewhere to live for weeks or months
// (a base), pass through (a hub) or visit once in a set window (a destination). It can cover
// more than one City ("Da Nang / Hoi An", "Sri Lanka south coast"); the first city id is the
// anchor whose Comfort Index and place data stand for the whole locale.
//
// Every month of a locale reads, in order: the owner's Personal Window for the anchor city
// (ADR 0011), then the anchor city's Comfort Index lowered by seasonal hazards. The field
// check's own month rating rides along unscored (ADR 0024). From those months
// come the ideal staying windows: the longest runs of great or good months, trimmed to the
// locale's stay length and, when known, to the passport's day limit. Pure: no React, no fetch.

import type { MonthSpan } from "../types";
import {
  comfortFit,
  nextWindow,
  newStayId,
  personalWindowFor,
  type ComfortLookup,
  type FitLevel,
  type LeadTime,
  type PlaceProfile,
  type RotationPlace,
  type RotationStay,
} from "./rotation";
import { monthName, spanHas, spanLabel } from "./season";
import { haversineKm } from "./geo";
import { proximity } from "./tripRisk";
import type { MapAnomaly, MeridianEvent } from "../types";
import dataset from "../../data/locales.json";

// ── Types ────────────────────────────────────────────────────────────

/** base = live there for weeks or months; hub = a few days between bases; destination = one time-boxed visit. */
export type LocaleRole = "base" | "hub" | "destination";
export const LOCALE_ROLES: LocaleRole[] = ["base", "hub", "destination"];

/** The field check's rating of one month. */
export type ResearchLevel = "best" | "good" | "fair" | "avoid";

export interface LocaleNote {
  /** 1–12. */
  months: number[];
  kind: ResearchLevel;
  reason: string;
}

export interface LocaleEvent {
  month: number;
  name: string;
  kind: "nature" | "festival" | "season";
}

/** Tourist season of a month. */
export type Tourism = "low" | "shoulder" | "high";

/** A stretch of the year, MM-DD to MM-DD, wrapping the new year when it ends before it starts. */
export interface DayWindow {
  from: string;
  to: string;
}

/**
 * The field check's 1–10 scores, each measured against a fixed anchor (ADR 0024): climate is
 * months rated best or good, air is annual PM2.5, cost is the all-in month in EUR, longstay is
 * how long a remote worker on an EU, US or UK passport can legally stay.
 */
export interface LocaleScores {
  climate: number;
  air: number;
  cost: number;
  safety: number;
  health: number;
  internet: number;
  food: number;
  nomad: number;
  longstay: number;
}

export interface Locale {
  id: string;
  name: string;
  country: string;
  region: string;
  role: LocaleRole;
  /** Meridian City ids. The first is the anchor. */
  cityIds: string[];
  /** Where in the locale, when the cities are only nearby ("Kotor; Tivat is the dataset's city"). */
  area?: string;
  summary: string;
  /** Twelve month ratings from the field check, January first. Not scored. */
  months: ResearchLevel[];
  monthNotes: LocaleNote[];
  scores: LocaleScores;
  stay: { minWeeks: number; idealWeeks: number; maxWeeks: number; why: string };
  /** All-in cost for one person. `per: "trip"` for a destination priced per visit. */
  cost?: { min: number; max: number; currency: string; per: "month" | "trip"; note?: string };
  entry?: { summary: string; source: string; checked: string };
  events?: LocaleEvent[];
  airport?: string;
  /** Weeks ahead to book a stay here. */
  leadWeeks?: LeadTime;
  /** What the field check could not pin down, or what is changing. */
  caveats?: string;
  sources: string[];
}

export interface LocaleDataset {
  version: number;
  checked: string;
  sources: string[];
  method: string;
  regions: string[];
  locales: Locale[];
}

export const LOCALE_DATA = dataset as unknown as LocaleDataset;
export const LOCALES: Locale[] = LOCALE_DATA.locales;

export function localeById(id: string): Locale | undefined {
  return LOCALES.find((l) => l.id === id);
}

export const anchorOf = (l: Pick<Locale, "cityIds">): string => l.cityIds[0];

// ── Month fit ────────────────────────────────────────────────────────

const RESEARCH_FIT: Record<ResearchLevel, Exclude<FitLevel, "unknown" | "poor">> = {
  best: "great",
  good: "good",
  fair: "fair",
  avoid: "avoid",
};

const FIT_RANK: Record<FitLevel, number> = { unknown: -1, avoid: 0, poor: 1, fair: 2, good: 3, great: 4 };

export const RESEARCH_LABEL: Record<ResearchLevel, string> = {
  best: "Best",
  good: "Good",
  fair: "Fair",
  avoid: "Avoid",
};

/** A seasonal hazard that reaches a locale (from the map's anomalies, data/phenomena.json). */
export interface HazardHit {
  label: string;
  type?: string;
  months: number[];
  /** severity × proximity, as trip risk scores it: 0.75 is "watch", 1.75 "caution". */
  score: number;
  km: number;
}

/** What Meridian's own data says about a locale, joined by the screen. */
export interface LocaleSignals {
  /** The owner's Personal Windows for the anchor city (the rotation's Place Profile). */
  profile?: PlaceProfile;
  /** The anchor city's monthly Comfort Index (temperature, rain, air, desert). */
  comfort?: ComfortLookup;
  /** Seasonal hazards within reach of the anchor city. */
  hazards?: HazardHit[];
  /** Tourist season by month (1–12) from measured visitor nights, when measured. */
  crowds?: (Tourism | undefined)[];
}

export interface LocaleMonth {
  /** 1–12. */
  month: number;
  level: FitLevel;
  /** Where the level came from: the owner's rotation window, or the Comfort Index. */
  source: "personal" | "comfort" | "none";
  why: string;
  /** The anchor city's Comfort Index for the month, when known. */
  comfort?: number;
  /** The worst hazard in season that lowered the month. */
  hazard?: HazardHit;
  /** Tourist season from measured visitor nights. */
  tourism?: Tourism;
  /** The field check's rating of the month, with its reason. Not scored. */
  research?: { level: FitLevel; text: string };
  /** The field check reads two or more levels away from the level shown. */
  researchDiffers?: boolean;
}

/** The note that explains a month, the one matching its rating first. */
export function noteFor(l: Pick<Locale, "monthNotes" | "months">, month: number): LocaleNote | undefined {
  const hits = l.monthNotes.filter((n) => n.months.includes(month));
  const level = l.months[month - 1];
  return hits.find((n) => n.kind === level) ?? hits[0];
}

// ── Day windows ──────────────────────────────────────────────────────

/** Days in each month of a common year: windows are read without a year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const dayOfYear = (mmdd: string): number => {
  const [m, d] = mmdd.split("-").map(Number);
  return MONTH_DAYS.slice(0, m - 1).reduce((a, b) => a + b, 0) + Math.min(d, MONTH_DAYS[m - 1]) - 1;
};

/** The window's days of the year (0–364), as one or two [start, end) ranges. */
export function windowRanges(w: DayWindow): [number, number][] {
  const a = dayOfYear(w.from);
  const b = dayOfYear(w.to) + 1;
  return a < b ? [[a, b]] : [[a, 365], [0, b]];
}

/** Days of a month (1–12) that a window covers. */
export function daysInMonth(w: DayWindow, month: number): number {
  const ms = MONTH_DAYS.slice(0, month - 1).reduce((x, y) => x + y, 0);
  const me = ms + MONTH_DAYS[month - 1];
  return windowRanges(w).reduce((n, [a, b]) => n + Math.max(0, Math.min(b, me) - Math.max(a, ms)), 0);
}

export const TOURISM_LABEL: Record<Tourism, string> = { low: "Low season", shoulder: "Shoulder season", high: "High season" };

export interface Segment {
  /** Fractions of the twelve months shown, 0–1. */
  left: number;
  width: number;
}

/**
 * Where a window falls on a calendar of twelve months starting at `startMonth` (1–12): one
 * or two segments, as fractions of the twelve months. Every month has the same width, so a
 * day's position is its month's place plus how far into the month it is.
 */
export function windowSegments(w: DayWindow, startMonth: number): Segment[] {
  return rangeSegments(windowRanges(w), startMonth);
}

/** Days of the year a week of the year covers (index 0 = week 1; week 52 runs to the year's end). */
export function weekRange(i: number): [number, number] {
  return [i * 7, i === 51 ? 365 : i * 7 + 7];
}

/** Day-of-year ranges ([start, end), 0–365) as segments of a calendar starting at `startMonth`. */
export function rangeSegments(ranges: [number, number][], startMonth: number): Segment[] {
  const S = dayOfYear(`${String(startMonth).padStart(2, "0")}-01`);
  /** Calendar position, in months, of a day `rel` days after the calendar starts (0–365). */
  const pos = (rel: number): number => {
    let m = startMonth - 1;
    let k = 0;
    while (k < 12 && rel >= MONTH_DAYS[m]) {
      rel -= MONTH_DAYS[m];
      m = (m + 1) % 12;
      k++;
    }
    return k + (k < 12 ? rel / MONTH_DAYS[m] : 0);
  };
  const out: Segment[] = [];
  for (const [a, b] of ranges) {
    // Split at the calendar's start so every piece runs forward on it.
    const pieces: [number, number][] = a < S && b > S ? [[a, S], [S, b]] : [[a, b]];
    for (const [x, y] of pieces) {
      const rx = (x - S + 365) % 365;
      const ry = rx + (y - x);
      out.push({ left: pos(rx) / 12, width: (pos(ry) - pos(rx)) / 12 });
    }
  }
  // Join pieces that touch (a window wrapping December into January on a January calendar).
  const sorted = out.filter((g) => g.width > 1e-9).sort((p, q) => p.left - q.left);
  const joined: Segment[] = [];
  for (const g of sorted) {
    const last = joined[joined.length - 1];
    if (last && Math.abs(last.left + last.width - g.left) < 1e-9) last.width += g.width;
    else joined.push({ ...g });
  }
  return joined;
}

/** A month span (whole months) on the same calendar. */
export function spanSegments(span: MonthSpan, startMonth: number): Segment[] {
  const endDay = MONTH_DAYS[span.end - 1];
  return windowSegments({ from: `${String(span.start).padStart(2, "0")}-01`, to: `${String(span.end).padStart(2, "0")}-${endDay}` }, startMonth);
}

/** The month a hazard lowers the fit: "watch" one level, "caution" or worse to avoid. */
export const HAZARD_WATCH = 0.75;
export const HAZARD_AVOID = 1.75;
const DOWN: Record<FitLevel, FitLevel> = { great: "good", good: "fair", fair: "poor", poor: "poor", avoid: "avoid", unknown: "unknown" };

/** Seasonal hazards (anomalies with months) within reach of a point, scored as trip risk scores a place. */
export function hazardHits(lat: number, lng: number, anomalies: MapAnomaly[]): HazardHit[] {
  const out: HazardHit[] = [];
  for (const a of anomalies) {
    if (a.kind !== "hazard" || !a.months?.length) continue;
    const km = haversineKm([lng, lat], [a.lng, a.lat]);
    const score = a.severity * proximity(km);
    if (score < 0.05) continue;
    out.push({ label: a.label, ...(a.type ? { type: a.type } : {}), months: a.months, score: Math.round(score * 100) / 100, km: Math.round(km) });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Tourist season by month from Meridian's computed tourism seasons (peak and shoulder, from measured visitor nights). */
export function crowdsFromEvents(events: Pick<MeridianEvent, "kind" | "tags" | "month" | "months">[]): (Tourism | undefined)[] | undefined {
  const out: (Tourism | undefined)[] = Array(12).fill(undefined);
  let any = false;
  for (const e of events) {
    if (e.kind !== "season") continue;
    const t: Tourism | undefined = e.tags.includes("peak-season") ? "high" : e.tags.includes("shoulder-season") ? "shoulder" : undefined;
    if (!t) continue;
    any = true;
    for (const m of e.months ?? [e.month]) if (out[m - 1] !== "high") out[m - 1] = t;
  }
  if (!any) return undefined;
  return out.map((t) => t ?? "low");
}

/** The field check's reading of a month. */
export function researchFor(l: Locale, month: number): LocaleMonth["research"] {
  const r = l.months[month - 1];
  if (!r) return undefined;
  return { level: RESEARCH_FIT[r], text: noteFor(l, month)?.reason ?? RESEARCH_LABEL[r] };
}

/**
 * One month of a locale from Meridian's own data. The owner's rotation window wins; else the
 * anchor city's Comfort Index, lowered by any seasonal hazard in reach (one level at "watch",
 * to avoid at "caution"). The field check rides along unscored, flagged when it differs.
 */
export function localeMonth(l: Locale, month: number, sig: LocaleSignals = {}): LocaleMonth {
  const score = sig.comfort?.(anchorOf(l))?.[month - 1]?.score;
  const c = typeof score === "number" && Number.isFinite(score) ? Math.round(score) : undefined;
  const tourism = sig.crowds?.[month - 1];
  const hazard = (sig.hazards ?? []).filter((h) => h.months.includes(month)).sort((a, b) => b.score - a.score)[0];
  const research = researchFor(l, month);
  const finish = (m: LocaleMonth): LocaleMonth => {
    const out: LocaleMonth = { ...m };
    if (c !== undefined) out.comfort = c;
    if (tourism) out.tourism = tourism;
    if (research) {
      out.research = research;
      out.researchDiffers = m.level !== "unknown" && Math.abs(FIT_RANK[m.level] - FIT_RANK[research.level]) >= 2;
    }
    return out;
  };

  const w = personalWindowFor(sig.profile, month);
  if (w) {
    const level: FitLevel = w.kind === "peak" ? "great" : w.kind === "shoulder" ? "fair" : "avoid";
    const label = w.kind === "peak" ? "Your peak" : w.kind === "shoulder" ? "Your shoulder" : "You avoid";
    return finish({ month, level, source: "personal", why: w.reason ? `${label}: ${w.reason}` : label });
  }
  if (c === undefined) return finish({ month, level: "unknown", source: "none", why: "No comfort data yet" });
  let level: FitLevel = comfortFit(c);
  let why = `Comfort ${c}`;
  if (hazard && hazard.score >= HAZARD_WATCH) {
    level = hazard.score >= HAZARD_AVOID ? "avoid" : DOWN[level];
    why += ` · ${hazard.label}`;
  }
  return finish({ month, level, source: "comfort", why, ...(hazard && hazard.score >= HAZARD_WATCH ? { hazard } : {}) });
}

/** The twelve months of a locale, January first. */
export function localeYear(l: Locale, sig: LocaleSignals = {}): LocaleMonth[] {
  return Array.from({ length: 12 }, (_, i) => localeMonth(l, i + 1, sig));
}

/** Week-of-year fits from weekly normals (index 0 = week 1), for drawing; months stay the unit of planning. */
export function weekLevels(weeks: { score: number }[] | null | undefined): FitLevel[] | null {
  if (!weeks || weeks.length !== 52) return null;
  return weeks.map((w) => (Number.isFinite(w.score) ? comfortFit(w.score) : "unknown"));
}

/** Meridian Beauty percentile (among all cities) at which a place justifies a base even when it is never comfortable. */
export const BEAUTY_UNLOCK = 85;

/** Percentile (0–100) of a value among all values, as the share at or below it. */
export function percentileOf(value: number | undefined, all: number[]): number | null {
  if (value === undefined || !all.length) return null;
  let n = 0;
  for (const v of all) if (v <= value) n++;
  return Math.round((100 * n) / all.length);
}

/** How close to its best month a month must be to join a "worth it" run, in Comfort points. */
export const RELATIVE_BAND = 10;

/** Average weeks in a month. */
export const WEEKS_PER_MONTH = 4.348;

export interface StayWindow {
  /** The months in a row that suit the place (great or good, or fair when nothing is better). */
  run: MonthSpan;
  runMonths: number;
  /** Months of the run rated great. */
  great: number;
  /** Where to be: the ideal stay length placed on the run's best months. */
  stay: MonthSpan;
  /** Stay length in weeks after the run, the locale's range and the day limit. */
  weeks: { min: number; ideal: number; max: number };
  /** True when the passport's day limit, not the season, sets the maximum. */
  capped: boolean;
  /** True when the run is only fair months. */
  fallback: boolean;
  /** True when no month is even fair and Beauty justifies a base anyway: the run is the place's most tolerable months. */
  relative: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Runs of months (1–12) passing `ok`, wrapping the new year. A year where every month passes is one run from January. */
export function monthRuns(ok: (month: number) => boolean): number[][] {
  const pass = Array.from({ length: 12 }, (_, i) => ok(i + 1));
  if (pass.every(Boolean)) return [Array.from({ length: 12 }, (_, i) => i + 1)];
  if (!pass.some(Boolean)) return [];
  // Start just after a failing month so no run is split across December/January.
  const start = pass.findIndex((p) => !p);
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let k = 1; k <= 12; k++) {
    const i = (start + k) % 12;
    if (pass[i]) cur.push(i + 1);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * The ideal windows to be in a locale, best first. A window is a run of great or good months
 * (fair months when there is no such run). Its stay is the locale's ideal length, in whole
 * months, placed on the stretch of the run with the most great months; its weeks are the
 * locale's range cut to the run and to `capDays`, the passport's day limit, when given.
 */
export function stayWindows(l: Locale, months: LocaleMonth[], capDays?: number | null, fromMonth = 1, beautyPct?: number | null): StayWindow[] {
  const level = (m: number) => months[m - 1]?.level ?? "unknown";
  let fallback = false;
  let relative = false;
  let runs = monthRuns((m) => level(m) === "great" || level(m) === "good");
  if (!runs.length) {
    runs = monthRuns((m) => level(m) === "fair");
    fallback = true;
  }
  if ((!runs.length || fallback) && (beautyPct ?? 0) >= BEAUTY_UNLOCK) {
    // Never better than fair, but beautiful enough to justify a base: its most tolerable months,
    // within RELATIVE_BAND Comfort points of its peak, when that stretch is longer than the fair one.
    const scores = months.map((m) => (m.level === "avoid" ? undefined : m.comfort));
    const peak = Math.max(...scores.map((c) => c ?? -1));
    if (peak >= 0) {
      const tolerable = monthRuns((m) => scores[m - 1] !== undefined && scores[m - 1]! >= peak - RELATIVE_BAND);
      const longest = (rs: number[][]) => Math.max(0, ...rs.map((r) => r.length));
      if (longest(tolerable) > longest(runs)) {
        // One worth-it window: the longest tolerable stretch, not every month that scrapes in.
        runs = [tolerable.reduce((a, b) => (b.length > a.length ? b : a))];
        relative = true;
        fallback = false;
      }
    }
  }

  const out = runs.map((run): StayWindow => {
    const runWeeks = run.length * WEEKS_PER_MONTH;
    const capWeeks = capDays && capDays > 0 ? capDays / 7 : Infinity;
    const max = Math.min(l.stay.maxWeeks, runWeeks, capWeeks);
    const min = Math.min(l.stay.minWeeks, max);
    const ideal = Math.max(min, Math.min(l.stay.idealWeeks, max));
    const stayLen = Math.min(run.length, Math.max(1, Math.round(ideal / WEEKS_PER_MONTH)));
    // Slide a stayLen-month frame along the run; keep the one with most great months (earliest on ties).
    // Ties go to the frame with fewer high-season months (crowds and prices), then to the one starting soonest from `fromMonth`.
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i + stayLen <= run.length; i++) {
      const frame = run.slice(i, i + stayLen);
      const score =
        frame.filter((m) => level(m) === "great").length * 100 -
        frame.filter((m) => months[m - 1]?.tourism === "high").length * 10 -
        ((frame[0] - fromMonth + 12) % 12) / 12;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    const frame = run.slice(best, best + stayLen);
    return {
      run: { start: run[0], end: run[run.length - 1] },
      runMonths: run.length,
      great: run.filter((m) => level(m) === "great").length,
      stay: { start: frame[0], end: frame[frame.length - 1] },
      weeks: { min: r1(min), ideal: r1(ideal), max: r1(max) },
      capped: capWeeks < Math.min(l.stay.maxWeeks, runWeeks),
      fallback,
      relative,
    };
  });
  return out.sort((a, b) => b.great - a.great || b.runMonths - a.runMonths);
}

/** "6–10 wk", or days for a hub: "3–5 days". */
export function weeksText(w: { min: number; max: number }): string {
  if (w.max < 2) {
    const a = Math.round(w.min * 7);
    const b = Math.round(w.max * 7);
    return a === b ? `${b} days` : `${a}–${b} days`;
  }
  const a = Math.round(w.min);
  const b = Math.round(w.max);
  return a === b ? `${b} wk` : `${a}–${b} wk`;
}

export function windowText(w: StayWindow): string {
  return `${spanLabel(w.stay)} · ${weeksText(w.weeks)}`;
}

// ── Ranking ──────────────────────────────────────────────────────────

export interface MonthPick {
  locale: Locale;
  fit: LocaleMonth;
}

/**
 * Locales ranked for one month. A month inside a "worth it" window counts as fair, so a
 * beautiful place shows in its most tolerable months; then fit, then Beauty, then name.
 */
export function bestForMonth(
  locales: Locale[],
  years: Map<string, LocaleMonth[]>,
  month: number,
  opts: { beauty?: Map<string, number>; windows?: Map<string, StayWindow[]> } = {}
): MonthPick[] {
  const effective = (l: Locale, f: LocaleMonth): number => {
    const worth = opts.windows?.get(l.id)?.some((w) => w.relative && spanHas(w.run, month));
    return Math.max(FIT_RANK[f.level], worth ? FIT_RANK.fair : -1);
  };
  return locales
    .map((locale) => ({ locale, fit: years.get(locale.id)?.[month - 1] ?? { month, level: "unknown" as FitLevel, source: "none" as const, why: "" } }))
    .sort(
      (a, b) =>
        effective(b.locale, b.fit) - effective(a.locale, a.fit) ||
        (opts.beauty?.get(b.locale.id) ?? 0) - (opts.beauty?.get(a.locale.id) ?? 0) ||
        a.locale.name.localeCompare(b.locale.name)
    );
}

/** Weights of the field check's overall score; they sum to 1 (ADR 0024). */
export const SCORE_WEIGHTS: Record<keyof LocaleScores, number> = {
  climate: 0.15,
  air: 0.1,
  cost: 0.14,
  safety: 0.12,
  health: 0.08,
  internet: 0.1,
  food: 0.07,
  nomad: 0.1,
  longstay: 0.14,
};

/** The field check's overall score, 1–10, one decimal. */
export function researchScore(l: Pick<Locale, "scores">): number {
  let sum = 0;
  for (const k of Object.keys(SCORE_WEIGHTS) as (keyof LocaleScores)[]) sum += SCORE_WEIGHTS[k] * l.scores[k];
  return Math.round(sum * 10) / 10;
}

/** Rank (1 = best) of every locale among those of its role, by the field check's overall score. */
export function researchRanks(locales: Locale[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const role of LOCALE_ROLES) {
    const list = locales.filter((l) => l.role === role).sort((a, b) => researchScore(b) - researchScore(a) || a.name.localeCompare(b.name));
    list.forEach((l, i) => out.set(l.id, i + 1));
  }
  return out;
}

export function fitRank(level: FitLevel): number {
  return FIT_RANK[level];
}

/** Mean of the Meridian metric values present (0–100), or null with none. */
export function meanOf(values: (number | undefined | null)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

// ── Into the rotation ────────────────────────────────────────────────

/**
 * An idea stay for the next time a window comes round, ready for the rotation's stay API.
 * Its nights are the window's weeks, its budget the field check's upper cost (as written, never
 * converted), and its lead time the locale's when it has one.
 */
export function stayFromLocale(l: Locale, place: RotationPlace, w: StayWindow, today: string): RotationStay {
  const hub = l.role === "hub";
  const monthly = l.cost && l.cost.per === "month" ? { amount: l.cost.max, currency: l.cost.currency } : undefined;
  const notes = [
    `From Locales: ${l.name}. Ideal ${windowText(w)}.`,
    l.months.length ? `Best ${l.months.map((r, i) => (r === "best" ? monthName(i + 1) : null)).filter(Boolean).join(", ") || "—"}.` : "",
    l.entry?.summary ? `Entry: ${l.entry.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: newStayId(),
    place,
    kind: hub ? "pass-through" : "base",
    status: "idea",
    window: nextWindow(w.stay, today),
    minNights: Math.max(1, Math.round(w.weeks.min * 7)),
    maxNights: Math.max(1, Math.round(w.weeks.max * 7)),
    ...(monthly ? { budgetMonthly: monthly } : {}),
    ...(l.leadWeeks ? { leadTime: l.leadWeeks } : {}),
    notes,
    origin: { kind: "manual" },
  };
}
