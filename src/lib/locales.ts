// Locales: researched home bases, hubs and destinations for a nomadic rotation (ADR 0022).
//
// A Locale is a place the owner has researched as somewhere to live for weeks or months
// (a base), pass through (a hub) or visit once in a set window (a destination). It can cover
// more than one City ("Da Nang / Hoi An", "Sri Lanka south coast"); the first city id is the
// anchor whose Comfort Index and place data stand for the whole locale.
//
// Every month of a locale reads, in order: the owner's Personal Window for the anchor city
// (ADR 0011), the locale's own researched rating, then the Comfort Index. From those months
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
import { monthName, spanLabel } from "./season";
import dataset from "../../data/locales.json";

// ── Types ────────────────────────────────────────────────────────────

/** base = live there for weeks or months; hub = a few days between bases; destination = one time-boxed visit. */
export type LocaleRole = "base" | "hub" | "destination";
export const LOCALE_ROLES: LocaleRole[] = ["base", "hub", "destination"];

/** The researched rating of one month. */
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

/** The owner's own 1–10 scores from their research, where the research has them. */
export interface LocaleScores {
  climate: number;
  health: number;
  food: number;
  cost: number;
  connect: number;
  safe: number;
  qol: number;
  overall: number;
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
  /** Twelve researched ratings, January first. */
  months: ResearchLevel[];
  notes: LocaleNote[];
  stay: { minWeeks: number; idealWeeks: number; maxWeeks: number; why: string };
  /** All-in cost for one person, as researched. `per: "trip"` for a destination priced per visit. */
  cost?: { min: number; max: number; currency: string; per: "month" | "trip"; note?: string };
  scores?: LocaleScores;
  /** Place in the research's asymmetry ranking (price against quality), 1 = widest gap. */
  asymmetry?: number;
  entry?: { summary: string; source: string; checked: string };
  events?: LocaleEvent[];
  airport?: string;
  /** Weeks ahead to book a stay here, when the research says so. */
  leadWeeks?: LeadTime;
  /** Where the review found the owner's original notes wrong or out of date. */
  corrections?: string;
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

export interface LocaleMonth {
  /** 1–12. */
  month: number;
  level: FitLevel;
  source: "personal" | "research" | "comfort" | "none";
  why: string;
  /** The anchor city's Comfort Index for the month, when known. */
  comfort?: number;
  /** The Comfort Index reads two or more levels away from the level shown. */
  disagrees?: boolean;
}

/** The note that explains a month, the one matching its rating first. */
export function noteFor(l: Pick<Locale, "notes" | "months">, month: number): LocaleNote | undefined {
  const hits = l.notes.filter((n) => n.months.includes(month));
  const level = l.months[month - 1];
  return hits.find((n) => n.kind === level) ?? hits[0];
}

export function localeMonth(l: Locale, month: number, profile?: PlaceProfile, comfort?: ComfortLookup): LocaleMonth {
  const score = comfort?.(anchorOf(l))?.[month - 1]?.score;
  const c = typeof score === "number" && Number.isFinite(score) ? Math.round(score) : undefined;
  const cLevel = c === undefined ? undefined : comfortFit(c);
  const withComfort = (m: Omit<LocaleMonth, "comfort" | "disagrees">): LocaleMonth => {
    if (c === undefined) return m;
    const gap = m.source === "comfort" ? 0 : Math.abs(FIT_RANK[m.level] - FIT_RANK[cLevel!]);
    return { ...m, comfort: c, disagrees: m.level !== "unknown" && gap >= 2 };
  };

  const w = personalWindowFor(profile, month);
  if (w) {
    const level: FitLevel = w.kind === "peak" ? "great" : w.kind === "shoulder" ? "fair" : "avoid";
    const label = w.kind === "peak" ? "Your peak" : w.kind === "shoulder" ? "Your shoulder" : "You avoid";
    return withComfort({ month, level, source: "personal", why: w.reason ? `${label}: ${w.reason}` : label });
  }
  const r = l.months[month - 1];
  if (r) {
    const note = noteFor(l, month);
    return withComfort({ month, level: RESEARCH_FIT[r], source: "research", why: note?.reason ?? RESEARCH_LABEL[r] });
  }
  if (cLevel) return withComfort({ month, level: cLevel, source: "comfort", why: `Comfort ${c}` });
  return { month, level: "unknown", source: "none", why: "No research or comfort data" };
}

/** The twelve months of a locale, January first. */
export function localeYear(l: Locale, profile?: PlaceProfile, comfort?: ComfortLookup): LocaleMonth[] {
  return Array.from({ length: 12 }, (_, i) => localeMonth(l, i + 1, profile, comfort));
}

// ── Ideal staying windows ────────────────────────────────────────────

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
export function stayWindows(l: Locale, months: LocaleMonth[], capDays?: number | null): StayWindow[] {
  const level = (m: number) => months[m - 1]?.level ?? "unknown";
  let fallback = false;
  let runs = monthRuns((m) => level(m) === "great" || level(m) === "good");
  if (!runs.length) {
    runs = monthRuns((m) => level(m) === "fair");
    fallback = true;
  }
  const out = runs.map((run): StayWindow => {
    const runWeeks = run.length * WEEKS_PER_MONTH;
    const capWeeks = capDays && capDays > 0 ? capDays / 7 : Infinity;
    const max = Math.min(l.stay.maxWeeks, runWeeks, capWeeks);
    const min = Math.min(l.stay.minWeeks, max);
    const ideal = Math.max(min, Math.min(l.stay.idealWeeks, max));
    const stayLen = Math.min(run.length, Math.max(1, Math.round(ideal / WEEKS_PER_MONTH)));
    // Slide a stayLen-month frame along the run; keep the one with most great months (earliest on ties).
    let best = 0;
    let bestGreat = -1;
    for (let i = 0; i + stayLen <= run.length; i++) {
      const g = run.slice(i, i + stayLen).filter((m) => level(m) === "great").length;
      if (g > bestGreat) {
        best = i;
        bestGreat = g;
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

/** Locales ranked for one month: fit first, then the owner's overall score, then name. */
export function bestForMonth(locales: Locale[], years: Map<string, LocaleMonth[]>, month: number): MonthPick[] {
  return locales
    .map((locale) => ({ locale, fit: years.get(locale.id)?.[month - 1] ?? { month, level: "unknown" as FitLevel, source: "none" as const, why: "" } }))
    .sort(
      (a, b) =>
        FIT_RANK[b.fit.level] - FIT_RANK[a.fit.level] ||
        (b.locale.scores?.overall ?? 0) - (a.locale.scores?.overall ?? 0) ||
        a.locale.name.localeCompare(b.locale.name)
    );
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
 * Its nights are the window's weeks, its budget the research's upper cost (as written, never
 * converted), and its lead time the locale's when the research gives one.
 */
export function stayFromLocale(l: Locale, place: RotationPlace, w: StayWindow, today: string): RotationStay {
  const hub = l.role === "hub";
  const monthly = l.cost && l.cost.per === "month" ? { amount: l.cost.max, currency: l.cost.currency } : undefined;
  const notes = [
    `From locale research: ${l.name}. Ideal ${windowText(w)}.`,
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
