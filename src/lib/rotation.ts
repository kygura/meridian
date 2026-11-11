// Rotation: residence planning, separate from a Trip (ADR 0011).
//
// A Rotation is the owner's rolling calendar of Rotation Stays: bases held for weeks or
// months and short pass-throughs between them, with no return leg. A Trip leaves a home
// airport and comes back; a Rotation does not. Pure and free of browser imports, so the
// server (reminders for a daily job) and the client compute the same things.
//
// Dates are YYYY-MM-DD calendar days with no zone. A stay runs from `start` (the move-in
// day) to `end` (the move-out day): nights = end − start. One stay's move-out day may be
// the next one's move-in day; that is a move, not an overlap.

import type { City, Journey, LegMode, MonthSpan, MoneyInput, Trip, TripLodging, TripNode } from "../types";
import { buildLeg, type LandmassOf, type TripLeg } from "./legs";
import type { FlightHub } from "./geo";
import { stayLinks, type BookLink } from "./bookLinks";
import { comfortBin } from "./seasonality";
import { spanMonths } from "./season";

// ── Types ────────────────────────────────────────────────────────────

/** base = a slow stay of weeks or months; pass-through = a hub or transit of a few days. */
export type StayKind = "base" | "pass-through";
export const STAY_KINDS: StayKind[] = ["base", "pass-through"];

export type StayStatus = "idea" | "planned" | "booked" | "current" | "done";
export const STAY_STATUSES: StayStatus[] = ["idea", "planned", "booked", "current", "done"];

/** A City as a rotation needs it. `country` keys visa counting (ADR 0011, extension points). */
export interface RotationPlace {
  cityId: string;
  name: string;
  country?: string;
  iata?: string;
  lat: number;
  lng: number;
}

/** A month window, YYYY-MM to YYYY-MM inclusive, for a stay whose dates are not fixed yet. */
export interface MonthWindow {
  from: string;
  to: string;
}

/** Weeks before the move-in day to book by. A range reads "8–10 weeks"; the deadline uses `max`. */
export interface LeadTime {
  min: number;
  max: number;
}

export interface RotationStay {
  id: string;
  place: RotationPlace;
  kind: StayKind;
  status: StayStatus;
  /** Move-in day, YYYY-MM-DD. */
  start?: string;
  /** Move-out day, YYYY-MM-DD. */
  end?: string;
  /** Months it should fall in, before dates are fixed. Ignored once start and end are set. */
  window?: MonthWindow;
  minNights?: number;
  maxNights?: number;
  /** What the owner means to spend a month here, all in. */
  budgetMonthly?: MoneyInput;
  /** The rent actually agreed, per month. */
  rentMonthly?: MoneyInput;
  /** Where: the same shape as a trip stop's Stay. */
  lodging?: TripLodging;
  notes?: string;
  /** A solver re-planning the rotation keeps locked stays where they are. */
  locked?: boolean;
  /** Overrides the place's and the default lead time for this one stay. */
  leadTime?: LeadTime;
  /** Where this stay came from when it was converted or proposed. */
  origin?: StayOrigin;
  /** Server-set on every write. */
  updatedAt?: string;
}

export type StayOrigin =
  | { kind: "manual" }
  | { kind: "trip"; tripId: string }
  | { kind: "journey"; journeyId: string; stopIndex: number }
  | { kind: "solver"; runId?: string };

export type WindowKind = "peak" | "shoulder" | "avoid";
export const WINDOW_KINDS: WindowKind[] = ["peak", "shoulder", "avoid"];

/**
 * The owner's own reading of a place's months ("Chiang Mai, Mar–Apr, avoid: burning
 * season, air quality"). Overrides the Comfort Index wherever a rotation is scored or shown.
 */
export interface PersonalWindow {
  id: string;
  kind: WindowKind;
  months: MonthSpan;
  reason?: string;
  /** Who wrote it: by hand, or an importer (Notion) with its own record id for re-imports. */
  source?: { kind: "manual" | "notion" | "import"; ref?: string };
}

/** What the owner keeps about one place, independent of any stay there. */
export interface PlaceProfile {
  cityId: string;
  name: string;
  country?: string;
  windows: PersonalWindow[];
  /** Book this far ahead for stays here (Azores 8–10 weeks, safari lodges a year). */
  leadTime?: LeadTime;
  notes?: string;
  updatedAt?: string;
}

export interface RotationSettings {
  name: string;
  /** Optional: a rotation has no return leg, but the owner may still keep a home airport. */
  home?: RotationPlace;
  /** How far ahead the calendar rolls, 12–18 months. */
  horizonMonths: number;
  updatedAt?: string;
}

export interface RotationState {
  settings: RotationSettings;
  stays: RotationStay[];
  places: PlaceProfile[];
}

export const DEFAULT_SETTINGS: RotationSettings = { name: "My rotation", horizonMonths: 18 };
export const MIN_HORIZON = 12;
export const MAX_HORIZON = 18;

// ── Dates ────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isYearMonth(s: unknown): s is string {
  return typeof s === "string" && YM.test(s);
}

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((ms(b) - ms(a)) / DAY);
}

export function addDays(d: string, n: number): string {
  return iso(ms(d) + n * DAY);
}

/** Today as YYYY-MM-DD in the runtime's local calendar. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "2027-03" → "2027-03-01". */
export function monthStart(ym: string): string {
  return `${ym}-01`;
}

/** The day after the month ends: "2027-03" → "2027-04-01" (a move-out day). */
export function monthEndExclusive(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
}

export function yearMonthOf(d: string): string {
  return d.slice(0, 7);
}

// ── Spans ────────────────────────────────────────────────────────────

/**
 * The days a stay occupies: its dates, or else its month window (first day of the first
 * month to the day after the last). `approx` marks the window case.
 */
export interface StaySpan {
  start: string;
  end: string;
  approx: boolean;
}

export function hasDates(s: Pick<RotationStay, "start" | "end">): boolean {
  return isIsoDate(s.start) && isIsoDate(s.end) && s.start! < s.end!;
}

export function staySpan(s: Pick<RotationStay, "start" | "end" | "window">): StaySpan | null {
  if (hasDates(s)) return { start: s.start!, end: s.end!, approx: false };
  if (s.window && isYearMonth(s.window.from) && isYearMonth(s.window.to) && s.window.from <= s.window.to) {
    return { start: monthStart(s.window.from), end: monthEndExclusive(s.window.to), approx: true };
  }
  return null;
}

/** Nights between move-in and move-out; null without fixed dates. */
export function stayNights(s: Pick<RotationStay, "start" | "end">): number | null {
  return hasDates(s) ? daysBetween(s.start!, s.end!) : null;
}

/** Stays with a span, in calendar order (then by id, so the order is stable). */
export function orderStays<T extends RotationStay>(stays: T[]): T[] {
  const key = (s: T) => staySpan(s)?.start ?? "9999-99-99";
  return [...stays].sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
}

// ── Status and current location ──────────────────────────────────────

/**
 * The status to show on `today`: a planned or booked stay whose dates contain today is
 * current; one that has ended is done. An idea stays an idea, whatever its dates.
 */
export function effectiveStatus(s: RotationStay, today: string): StayStatus {
  if (s.status === "idea" || !hasDates(s)) return s.status;
  if (s.start! <= today && today < s.end!) return "current";
  if (s.end! <= today) return "done";
  return s.status === "current" || s.status === "done" ? "booked" : s.status;
}

/**
 * Where the owner is on `today`: the dated stay containing it (move-in day inclusive,
 * move-out day exclusive). On a moving day that is the stay being moved into. Ideas never
 * count. Null between stays.
 */
export function currentStay<T extends RotationStay>(stays: T[], today: string): T | null {
  const here = stays.filter((s) => s.status !== "idea" && hasDates(s) && s.start! <= today && today < s.end!);
  if (!here.length) return null;
  // Overlapping stays: the most recent move-in wins.
  return here.sort((a, b) => b.start!.localeCompare(a.start!))[0];
}

export interface WhatsNext {
  current: RotationStay | null;
  /** Nights left in the current base, counting tonight. */
  daysLeft: number | null;
  /** The next move-out or move-in day after today. */
  nextMoveDate: string | null;
  /** The stay that move goes to, when one is planned. */
  next: RotationStay | null;
  /** Days from today to the next move. */
  daysToMove: number | null;
}

export function whatsNext(stays: RotationStay[], today: string): WhatsNext {
  const current = currentStay(stays, today);
  const future = orderStays(stays.filter((s) => s.status !== "idea" && hasDates(s) && s.start! > today));
  const next = future[0] ?? null;
  const nextMoveDate = current ? current.end! : (next?.start ?? null);
  return {
    current,
    daysLeft: current ? daysBetween(today, current.end!) : null,
    nextMoveDate,
    next: current ? (future.find((s) => s.start! >= current.end!) ?? next) : next,
    daysToMove: nextMoveDate ? daysBetween(today, nextMoveDate) : null,
  };
}

// ── Gaps, overlaps and length ────────────────────────────────────────

export type IssueKind = "gap" | "overlap" | "too-short" | "too-long" | "bad-dates";

export interface RotationIssue {
  kind: IssueKind;
  /** The stays involved, in calendar order. */
  stayIds: string[];
  /** Days of gap or overlap; nights short or over for a length issue. */
  days: number;
  /** First day affected. */
  from?: string;
  /** Day after the last day affected. */
  to?: string;
  /** True when a side is only a month window, so the real dates may still fit. */
  tentative: boolean;
  message: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Gaps (nights with no stay between consecutive stays) and overlaps (two stays holding
 * the same nights), plus stays outside their own minimum and maximum length. Ideas are
 * left out: they are options, not commitments.
 */
export function rotationIssues(stays: RotationStay[]): RotationIssue[] {
  const out: RotationIssue[] = [];
  const committed = stays.filter((s) => s.status !== "idea");
  for (const s of committed) {
    if ((s.start || s.end) && !hasDates(s) && isIsoDate(s.start) && isIsoDate(s.end)) {
      out.push({ kind: "bad-dates", stayIds: [s.id], days: 0, tentative: false, message: `${s.place.name}: moves out before it moves in.` });
    }
    const n = stayNights(s);
    if (n === null) continue;
    if (s.minNights && n < s.minNights) {
      out.push({ kind: "too-short", stayIds: [s.id], days: s.minNights - n, from: s.start, to: s.end, tentative: false, message: `${s.place.name} is ${plural(n, "night")}, under its minimum of ${s.minNights}.` });
    }
    if (s.maxNights && n > s.maxNights) {
      out.push({ kind: "too-long", stayIds: [s.id], days: n - s.maxNights, from: s.start, to: s.end, tentative: false, message: `${s.place.name} is ${plural(n, "night")}, over its maximum of ${s.maxNights}.` });
    }
  }
  const spanned = orderStays(committed.filter((s) => staySpan(s)));
  for (let i = 0; i < spanned.length - 1; i++) {
    const a = spanned[i];
    const b = spanned[i + 1];
    const sa = staySpan(a)!;
    const sb = staySpan(b)!;
    const tentative = sa.approx || sb.approx;
    if (sb.start > sa.end) {
      // Window-only stays are allowed to be shorter than their window; a gap still shows.
      const days = daysBetween(sa.end, sb.start);
      out.push({ kind: "gap", stayIds: [a.id, b.id], days, from: sa.end, to: sb.start, tentative, message: `${plural(days, "night")} with nowhere to stay between ${a.place.name} and ${b.place.name}.` });
    }
    // Overlap against every later stay that starts before this one ends (not only the next).
    for (let j = i + 1; j < spanned.length; j++) {
      const c = spanned[j];
      const sc = staySpan(c)!;
      if (sc.start >= sa.end) break;
      const to = sc.end < sa.end ? sc.end : sa.end;
      const days = daysBetween(sc.start, to);
      // Two month windows sharing a month is how windows look before dates are fixed.
      if (sa.approx && sc.approx) continue;
      out.push({ kind: "overlap", stayIds: [a.id, c.id], days, from: sc.start, to, tentative: sa.approx || sc.approx, message: `${a.place.name} and ${c.place.name} both hold ${plural(days, "night")}.` });
    }
  }
  return out;
}

// ── Fit: personal windows first, then the Comfort Index ──────────────

export type FitLevel = "great" | "good" | "fair" | "poor" | "avoid" | "unknown";
const FIT_RANK: Record<Exclude<FitLevel, "unknown">, number> = { avoid: 0, poor: 1, fair: 2, good: 3, great: 4 };
const RANK_FIT: Exclude<FitLevel, "unknown">[] = ["avoid", "poor", "fair", "good", "great"];

export interface MonthFit {
  /** YYYY-MM */
  month: string;
  /** Nights of the stay in this month. */
  nights: number;
  level: FitLevel;
  source: "personal" | "comfort" | "none";
  /** The personal window's reason, or "Comfort 72" for the index. */
  why: string;
}

export interface StayFit {
  level: FitLevel;
  /** "personal" when any month used a personal window. */
  source: "personal" | "comfort" | "none";
  months: MonthFit[];
  summary: string;
}

/** A city's Comfort Index months (index 0 = January), or null when not covered. */
export type ComfortLookup = (cityId: string) => { score: number }[] | null | undefined;

/** Personal window covering a month (1-12) for a place; avoid beats peak beats shoulder when they overlap. */
export function personalWindowFor(profile: PlaceProfile | undefined, month: number): PersonalWindow | undefined {
  if (!profile) return undefined;
  const hits = profile.windows.filter((w) => spanMonths(w.months).includes(month));
  const order: WindowKind[] = ["avoid", "peak", "shoulder"];
  return hits.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0];
}

/** The Comfort Index bins (seasonality.ts) folded into five fit levels. */
export function comfortFit(score: number): Exclude<FitLevel, "avoid" | "unknown"> {
  const bin = comfortBin(score);
  return bin >= 5 ? "great" : bin === 4 ? "good" : bin === 3 ? "fair" : "poor";
}

export function monthFit(cityId: string, ym: string, profile: PlaceProfile | undefined, comfort?: ComfortLookup): Omit<MonthFit, "nights"> {
  const m = Number(ym.slice(5, 7));
  const w = personalWindowFor(profile, m);
  if (w) {
    const level: FitLevel = w.kind === "peak" ? "great" : w.kind === "shoulder" ? "fair" : "avoid";
    const label = w.kind === "peak" ? "Your peak" : w.kind === "shoulder" ? "Your shoulder" : "You avoid";
    return { month: ym, level, source: "personal", why: w.reason ? `${label}: ${w.reason}` : label };
  }
  const score = comfort?.(cityId)?.[m - 1]?.score;
  if (typeof score === "number" && Number.isFinite(score)) {
    return { month: ym, level: comfortFit(score), source: "comfort", why: `Comfort ${Math.round(score)}` };
  }
  return { month: ym, level: "unknown", source: "none", why: "No comfort data" };
}

/** Nights of [start, end) falling in each calendar month. */
export function nightsByMonth(start: string, end: string): { month: string; nights: number }[] {
  const out: { month: string; nights: number }[] = [];
  let ym = yearMonthOf(start);
  while (monthStart(ym) < end) {
    const a = monthStart(ym) > start ? monthStart(ym) : start;
    const b = monthEndExclusive(ym) < end ? monthEndExclusive(ym) : end;
    const n = daysBetween(a, b);
    if (n > 0) out.push({ month: ym, nights: n });
    ym = addMonths(ym, 1);
  }
  return out;
}

/**
 * How well a stay's months suit its place. Each month reads the owner's personal window
 * first and the Comfort Index only where there is none. The stay's level is the
 * night-weighted mean of its months, except that a week or more (or over a quarter of the
 * stay) in a month the owner avoids makes the whole stay "avoid".
 */
export function stayFit(stay: RotationStay, profile: PlaceProfile | undefined, comfort?: ComfortLookup): StayFit {
  const span = staySpan(stay);
  if (!span) return { level: "unknown", source: "none", months: [], summary: "No dates or months yet" };
  const months: MonthFit[] = nightsByMonth(span.start, span.end).map(({ month, nights }) => ({
    ...monthFit(stay.place.cityId, month, profile, comfort),
    nights,
  }));
  const total = months.reduce((a, m) => a + m.nights, 0);
  const known = months.filter((m) => m.level !== "unknown");
  const source = months.some((m) => m.source === "personal") ? "personal" : known.length ? "comfort" : "none";
  const avoid = months.filter((m) => m.level === "avoid");
  const avoidNights = avoid.reduce((a, m) => a + m.nights, 0);
  if (avoid.length && (avoidNights >= 7 || avoidNights / total > 0.25)) {
    return { level: "avoid", source, months, summary: avoid[0].why };
  }
  const knownNights = known.reduce((a, m) => a + m.nights, 0);
  if (!knownNights) return { level: "unknown", source, months, summary: "No comfort data or personal window" };
  const mean = known.reduce((a, m) => a + FIT_RANK[m.level as Exclude<FitLevel, "unknown">] * m.nights, 0) / knownNights;
  const level = RANK_FIT[Math.round(mean)];
  const personal = months.find((m) => m.source === "personal");
  const summary = personal ? personal.why : `Comfort Index for ${months.length === 1 ? "the month" : "these months"}`;
  return { level, source, months, summary };
}

export const FIT_LABEL: Record<FitLevel, string> = {
  great: "Great fit",
  good: "Good fit",
  fair: "Fair fit",
  poor: "Poor fit",
  avoid: "Avoid",
  unknown: "Fit unknown",
};

// ── Booking lead times ───────────────────────────────────────────────

/**
 * Default weeks ahead to book, by type and length. A rule of thumb, stated as one: a
 * pass-through is a hotel or hostel (3 weeks); a base under four weeks, 4 weeks; one to
 * three months of monthly rental, 8 weeks; longer, 12 weeks.
 */
export function defaultLeadTime(kind: StayKind, nights: number | null): LeadTime {
  if (kind === "pass-through") return { min: 2, max: 3 };
  if (nights !== null && nights < 28) return { min: 3, max: 4 };
  if (nights === null || nights <= 92) return { min: 6, max: 8 };
  return { min: 10, max: 12 };
}

export const LEAD_TIME_METHOD =
  "Default lead times: pass-through 2–3 weeks, a base under four weeks 3–4 weeks, one to three months 6–8 weeks, longer 10–12 weeks. Set your own per place or per stay.";

export interface LeadTimeChoice {
  lead: LeadTime;
  basis: "stay" | "place" | "default";
}

export function leadTimeFor(stay: RotationStay, profile?: PlaceProfile): LeadTimeChoice {
  if (stay.leadTime) return { lead: stay.leadTime, basis: "stay" };
  if (profile?.leadTime) return { lead: profile.leadTime, basis: "place" };
  const span = staySpan(stay);
  const nights = span ? daysBetween(span.start, span.end) : null;
  return { lead: defaultLeadTime(stay.kind, nights), basis: "default" };
}

/** Book by: the move-in day (or the window's first day) minus the longer lead time. */
export function bookBy(stay: RotationStay, profile?: PlaceProfile): string | null {
  const span = staySpan(stay);
  if (!span) return null;
  return addDays(span.start, -leadTimeFor(stay, profile).lead.max * 7);
}

/** Stays that still need booking: ideas and planned stays that have not started. */
export function needsBooking(stay: RotationStay, today: string): boolean {
  const st = effectiveStatus(stay, today);
  if (st !== "idea" && st !== "planned") return false;
  const span = staySpan(stay);
  return !!span && span.start > today;
}

export interface Deadline {
  stayId: string;
  place: RotationPlace;
  bookBy: string;
  /** Negative when overdue. */
  daysLeft: number;
  moveIn: string;
  approx: boolean;
  lead: LeadTime;
  basis: LeadTimeChoice["basis"];
  status: StayStatus;
}

/** Every upcoming booking deadline, soonest first. */
export function bookingDeadlines(state: Pick<RotationState, "stays" | "places">, today: string): Deadline[] {
  const profiles = new Map(state.places.map((p) => [p.cityId, p]));
  const out: Deadline[] = [];
  for (const s of state.stays) {
    if (!needsBooking(s, today)) continue;
    const profile = profiles.get(s.place.cityId);
    const by = bookBy(s, profile)!;
    const span = staySpan(s)!;
    const lt = leadTimeFor(s, profile);
    out.push({
      stayId: s.id,
      place: s.place,
      bookBy: by,
      daysLeft: daysBetween(today, by),
      moveIn: span.start,
      approx: span.approx,
      lead: lt.lead,
      basis: lt.basis,
      status: effectiveStatus(s, today),
    });
  }
  return out.sort((a, b) => a.bookBy.localeCompare(b.bookBy) || a.stayId.localeCompare(b.stayId));
}

export interface Reminder {
  stayId: string;
  /** overdue: the book-by date has passed; due: it is within the notice period. */
  kind: "overdue" | "due";
  bookBy: string;
  daysLeft: number;
  /** One plain line for a notification. */
  message: string;
  /** Monthly-rental searches, prefilled with the city and dates. */
  links: BookLink[];
}

/**
 * Reminders a daily job should send on `today`: stays still to book whose book-by date is
 * within `noticeDays` or already past. Pure: the caller decides how to send them and how
 * to avoid sending one twice (the stay id plus book-by date is a stable key).
 */
export function dueReminders(state: Pick<RotationState, "stays" | "places">, today: string, noticeDays = 14): Reminder[] {
  const byId = new Map(state.stays.map((s) => [s.id, s]));
  return bookingDeadlines(state, today)
    .filter((d) => d.daysLeft <= noticeDays)
    .map((d) => {
      const stay = byId.get(d.stayId)!;
      const overdue = d.daysLeft < 0;
      const when = overdue
        ? `was due ${formatShortDate(d.bookBy)} (${plural(-d.daysLeft, "day")} ago)`
        : d.daysLeft === 0
          ? "is due today"
          : `is due ${formatShortDate(d.bookBy)} (in ${plural(d.daysLeft, "day")})`;
      return {
        stayId: d.stayId,
        kind: overdue ? "overdue" : "due",
        bookBy: d.bookBy,
        daysLeft: d.daysLeft,
        message: `Book ${d.place.name} for ${d.approx ? "around " : ""}${formatShortDate(d.moveIn)}: booking ${when}.`,
        links: rentalLinks(stay),
      } satisfies Reminder;
    });
}

/** "12 Mar 2027". */
export function formatShortDate(d: string): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d.slice(8, 10))} ${M[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

/**
 * Monthly-rental searches for a stay: Flatio, Airbnb (monthly pricing from 28 nights) and
 * Booking.com, prefilled with the city and the stay's dates or window. Only the city,
 * country and dates go into the URLs.
 */
export function rentalLinks(stay: RotationStay): BookLink[] {
  const span = staySpan(stay);
  const links = stayLinks({
    place: { name: stay.place.name, country: stay.place.country },
    checkIn: span?.start,
    checkOut: span?.end,
  });
  if (!links.some((l) => l.site === "flatio")) {
    links.push({
      site: "flatio",
      label: "Flatio",
      url: `https://www.flatio.com/s/${encodeURIComponent(stay.place.name)}`,
      prefills: "city only; set the dates there",
    });
  }
  const order = ["flatio", "airbnb", "booking"];
  return links.sort((a, b) => order.indexOf(a.site) - order.indexOf(b.site));
}

// ── Travel legs between consecutive stays ────────────────────────────

export interface RotationLeg {
  fromStayId: string;
  toStayId: string;
  /** The move day: the earlier stay's move-out (or the later one's move-in). */
  date?: string;
  leg: TripLeg;
}

export function placeNode(p: RotationPlace): TripNode {
  return { cityId: p.cityId, name: p.name, iata: p.iata, lat: p.lat, lng: p.lng };
}

/**
 * One leg per move between consecutive committed stays (ideas left out), estimated with the
 * same formulas as trip legs (legs.ts): flight time and cost from great-circle distance,
 * ground legs by mode. No return leg. Two stays in the same city are no move.
 */
export function rotationLegs(stays: RotationStay[], hubs: FlightHub[] = [], landmassOf?: LandmassOf, modes?: Record<string, LegMode>): RotationLeg[] {
  const ordered = orderStays(stays.filter((s) => s.status !== "idea" && staySpan(s)));
  const out: RotationLeg[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    if (a.place.cityId === b.place.cityId) continue;
    const from = placeNode(a.place);
    const mode = modes?.[b.id];
    const leg = buildLeg(i, from, placeNode(b.place), hubs, mode ? { fromCityId: from.cityId, mode } : undefined, landmassOf);
    out.push({ fromStayId: a.id, toStayId: b.id, date: hasDates(a) ? a.end : staySpan(b)!.start, leg });
  }
  return out;
}

// ── Totals ───────────────────────────────────────────────────────────

/** Average days per month (365.25 / 12). */
export const DAYS_PER_MONTH = 30.4375;

export interface MonthlyCost {
  currency: string;
  /** Night-weighted mean monthly amount over the stays that have one. */
  perMonth: number;
  /** Months of stays this covers. */
  months: number;
  /** Rent where the owner entered it, else the budget. */
  basis: "rent" | "budget" | "mixed";
}

export interface RotationTotals {
  /** First day of the horizon and the day after it ends. */
  from: string;
  to: string;
  horizonMonths: number;
  /** Months of the horizon held by a committed stay (dates or window). */
  monthsCovered: number;
  /** Of those, months with fixed dates. */
  monthsDated: number;
  /** Per currency, never converted. */
  costPerMonth: MonthlyCost[];
  /** Moves inside the horizon, scaled to twelve months. */
  movesPerYear: number;
  moves: number;
  /** Estimated travel between stays in the horizon, USD (legs.ts formulas). */
  travelCostUsd: number;
  travelHours: number;
}

export function horizonRange(today: string, horizonMonths: number): { from: string; to: string } {
  const from = monthStart(yearMonthOf(today));
  return { from, to: monthStart(addMonths(yearMonthOf(today), horizonMonths)) };
}

function clip(span: StaySpan, from: string, to: string): number {
  const a = span.start > from ? span.start : from;
  const b = span.end < to ? span.end : to;
  return Math.max(0, daysBetween(a, b));
}

export function rotationTotals(state: RotationState, today: string, legs: RotationLeg[]): RotationTotals {
  const horizonMonths = clampHorizon(state.settings.horizonMonths);
  const { from, to } = horizonRange(today, horizonMonths);
  const committed = state.stays.filter((s) => s.status !== "idea");
  // Union of nights, so overlapping stays are not counted twice.
  const covered = new Set<string>();
  const dated = new Set<string>();
  const costs = new Map<string, { sum: number; nights: number; rent: number; budget: number }>();
  for (const s of committed) {
    const span = staySpan(s);
    if (!span) continue;
    const nights = clip(span, from, to);
    for (let i = 0; i < nights; i++) {
      const d = addDays(span.start > from ? span.start : from, i);
      covered.add(d);
      if (!span.approx) dated.add(d);
    }
    const money = s.rentMonthly ?? s.budgetMonthly;
    if (money && nights > 0) {
      const c = costs.get(money.currency) ?? { sum: 0, nights: 0, rent: 0, budget: 0 };
      c.sum += money.amount * nights;
      c.nights += nights;
      if (s.rentMonthly) c.rent += 1;
      else c.budget += 1;
      costs.set(money.currency, c);
    }
  }
  const inHorizon = legs.filter((l) => l.date && l.date >= from && l.date < to);
  const totalDays = daysBetween(from, to);
  return {
    from,
    to,
    horizonMonths,
    monthsCovered: round1(covered.size / DAYS_PER_MONTH),
    monthsDated: round1(dated.size / DAYS_PER_MONTH),
    costPerMonth: [...costs.entries()]
      .map(([currency, c]) => ({
        currency,
        perMonth: Math.round(c.sum / c.nights),
        months: round1(c.nights / DAYS_PER_MONTH),
        basis: (c.rent && c.budget ? "mixed" : c.rent ? "rent" : "budget") as MonthlyCost["basis"],
      }))
      .sort((a, b) => b.months - a.months),
    moves: inHorizon.length,
    movesPerYear: round1((inHorizon.length / totalDays) * 365.25),
    travelCostUsd: inHorizon.reduce((a, l) => a + l.leg.cost, 0),
    travelHours: round1(inHorizon.reduce((a, l) => a + l.leg.hours, 0)),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function clampHorizon(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_SETTINGS.horizonMonths;
  return Math.max(MIN_HORIZON, Math.min(MAX_HORIZON, v));
}

// ── Timeline geometry ────────────────────────────────────────────────

export interface TimelineMonth {
  ym: string;
  /** Left edge as a fraction of the timeline, 0..1. */
  left: number;
  width: number;
}

/** Month columns of the horizon, each sized by its days. */
export function timelineMonths(from: string, to: string): TimelineMonth[] {
  const total = daysBetween(from, to);
  const out: TimelineMonth[] = [];
  for (let ym = yearMonthOf(from); monthStart(ym) < to; ym = addMonths(ym, 1)) {
    out.push({ ym, left: daysBetween(from, monthStart(ym)) / total, width: daysBetween(monthStart(ym), monthEndExclusive(ym)) / total });
  }
  return out;
}

/** Where a day falls on the timeline, 0..1 (clamped). */
export function timelineX(day: string, from: string, to: string): number {
  return Math.max(0, Math.min(1, daysBetween(from, day) / daysBetween(from, to)));
}

// ── Conversions ──────────────────────────────────────────────────────

export function newStayId(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `st-${Date.now().toString(36)}-${rnd}`;
}

export function placeFromCity(c: Pick<City, "id" | "name" | "country" | "iata" | "lat" | "lng">): RotationPlace {
  return { cityId: c.id, name: c.name, country: c.country || undefined, iata: c.iata, lat: c.lat, lng: c.lng };
}

/** Under two weeks is a pass-through; anything longer is a base. */
export const PASS_THROUGH_MAX_NIGHTS = 13;

export function kindForNights(nights: number | null): StayKind {
  return nights !== null && nights <= PASS_THROUGH_MAX_NIGHTS ? "pass-through" : "base";
}

/** Next calendar occurrence of a month span from today: the year whose window has not ended yet. */
export function nextWindow(span: MonthSpan, today: string): MonthWindow {
  const months = spanMonths(span);
  const y = Number(today.slice(0, 4));
  for (const year of [y - 1, y, y + 1]) {
    const from = `${year}-${String(span.start).padStart(2, "0")}`;
    const to = addMonths(from, months.length - 1);
    if (monthEndExclusive(to) > today) return { from, to };
  }
  const from = `${y + 1}-${String(span.start).padStart(2, "0")}`;
  return { from, to: addMonths(from, months.length - 1) };
}

/**
 * Turn a Trip into rotation stays: one per placed stop, in route order. A stop with dates
 * keeps them; one with months gets a month window in the trip's year, or the next time
 * those months come round. The departure becomes the optional home airport; the return leg
 * is dropped, since a rotation does not go home. Statuses: a stop with a booked stay is
 * booked, a confirmed trip's stops planned, anything else an idea.
 */
export function tripToRotation(
  trip: Trip,
  today: string,
  cityOf?: (cityId: string) => Pick<City, "country"> | undefined,
  makeId: () => string = newStayId
): { stays: RotationStay[]; home?: RotationPlace } {
  const stays: RotationStay[] = [];
  const seasonStart = trip.nodes.find((n) => n.months)?.months?.start ?? trip.season?.start;
  for (const node of trip.nodes) {
    const place: RotationPlace = {
      cityId: node.cityId,
      name: node.name,
      country: cityOf?.(node.cityId)?.country || undefined,
      iata: node.iata,
      lat: node.lat,
      lng: node.lng,
    };
    let start: string | undefined;
    let end: string | undefined;
    let window: MonthWindow | undefined;
    if (isIsoDate(node.arrive) && isIsoDate(node.depart) && node.arrive < node.depart) {
      start = node.arrive;
      end = node.depart;
    } else if (node.months) {
      if (trip.year) {
        // Months before the season's start fall in the next calendar year (ADR 0007).
        const y = seasonStart && node.months.start < seasonStart ? trip.year + 1 : trip.year;
        const from = `${y}-${String(node.months.start).padStart(2, "0")}`;
        window = { from, to: addMonths(from, spanMonths(node.months).length - 1) };
      } else {
        window = nextWindow(node.months, today);
      }
    }
    const span = staySpan({ start, end, window });
    const nights = span && !span.approx ? daysBetween(span.start, span.end) : null;
    const kind: StayKind = nights !== null ? kindForNights(nights) : "base";
    const booked = !!node.lodging?.bookingRef;
    stays.push({
      id: makeId(),
      place,
      kind,
      status: booked ? "booked" : trip.status === "confirmed" ? "planned" : "idea",
      start,
      end,
      window,
      lodging: node.lodging,
      notes: node.notes,
      origin: { kind: "trip", tripId: trip.id },
    });
  }
  const dep = trip.departure;
  const home = dep
    ? { cityId: dep.cityId, name: dep.name, iata: dep.iata, lat: dep.lat, lng: dep.lng, country: cityOf?.(dep.cityId)?.country || undefined }
    : undefined;
  return { stays, home };
}

/**
 * A stay template from one stop of a past Journey: the place, the type and length it
 * actually had (as minimum and maximum), and, when the journal recorded what the lodging
 * cost, that cost scaled to a month as the budget, with the method in the notes. No dates:
 * the owner places the template.
 */
export function journeyStayTemplate(
  journey: Journey,
  stopIndex: number,
  cityOf: (cityId: string) => Pick<City, "id" | "name" | "country" | "iata" | "lat" | "lng"> | undefined,
  makeId: () => string = newStayId
): RotationStay | null {
  const stop = journey.stops[stopIndex];
  if (!stop) return null;
  const city = cityOf(stop.cityId);
  if (!city) return null;
  const nights = isIsoDate(stop.arrive) && isIsoDate(stop.depart) ? Math.max(0, daysBetween(stop.arrive, stop.depart)) : null;
  const notes: string[] = [`From ${journey.title} (${stop.arrive.slice(0, 7)}).`];
  let budgetMonthly: MoneyInput | undefined;
  const cost = stop.lodging?.cost;
  if (cost && nights && nights > 0) {
    budgetMonthly = { amount: Math.round((cost.amount / nights) * DAYS_PER_MONTH), currency: cost.currency };
    notes.push(
      `Budget: your ${stop.lodging!.name} cost ${cost.amount} ${cost.currency} for ${plural(nights, "night")}, scaled to ${DAYS_PER_MONTH} nights.`
    );
  }
  return {
    id: makeId(),
    place: placeFromCity(city),
    kind: kindForNights(nights),
    status: "idea",
    minNights: nights || undefined,
    maxNights: nights || undefined,
    budgetMonthly,
    lodging: stop.lodging ? { name: stop.lodging.name, kind: stop.lodging.kind } : undefined,
    notes: notes.join(" "),
    origin: { kind: "journey", journeyId: journey.id, stopIndex },
  };
}

/** Place a template: give it dates from a move-in day for its minimum length (or 30 nights). */
export function placeTemplate(t: RotationStay, start: string): RotationStay {
  const nights = t.minNights ?? (t.kind === "pass-through" ? 3 : 30);
  return { ...t, start, end: addDays(start, nights), window: undefined };
}

// ── Extension points (ADR 0011) ──────────────────────────────────────

/**
 * Visa and day counting: where the owner sleeps, by country, as date ranges. The visa
 * module (built separately, keyed by country and date ranges) takes this as its input.
 * Only committed stays with fixed dates count; window-only stays come back separately as
 * `tentative` so a planner can warn before dates are fixed.
 */
export interface Presence {
  stayId: string;
  country: string;
  /** First night, YYYY-MM-DD. */
  start: string;
  /** Move-out day, YYYY-MM-DD (exclusive). */
  end: string;
  tentative: boolean;
}

export function stayPresence(stays: RotationStay[]): Presence[] {
  const out: Presence[] = [];
  for (const s of orderStays(stays)) {
    if (s.status === "idea" || !s.place.country) continue;
    const span = staySpan(s);
    if (!span) continue;
    out.push({ stayId: s.id, country: s.place.country, start: span.start, end: span.end, tentative: span.approx });
  }
  return out;
}

/**
 * Solver input: the stays it must keep (locked), the pool of places with their windows and
 * lead times, and the horizon. A solver returns new stays with `origin: {kind: "solver"}`
 * and status "idea"; `rotationIssues` and `stayFit` are its constraints and objective.
 */
export interface SolverInput {
  locked: RotationStay[];
  pool: PlaceProfile[];
  from: string;
  to: string;
}

export function solverInput(state: RotationState, today: string): SolverInput {
  const { from, to } = horizonRange(today, clampHorizon(state.settings.horizonMonths));
  return { locked: orderStays(state.stays.filter((s) => s.locked)), pool: state.places, from, to };
}

/**
 * Merge personal windows from an importer (Notion) into a place: windows from that source
 * are replaced by the import (matched by `ref`, so a re-import updates rather than
 * duplicates), and windows the owner wrote by hand are kept.
 */
export function mergeImportedWindows(profile: PlaceProfile, imported: PersonalWindow[], sourceKind: "notion" | "import"): PlaceProfile {
  const kept = profile.windows.filter((w) => w.source?.kind !== sourceKind);
  const stamped = imported.map((w) => ({ ...w, source: { kind: sourceKind, ref: w.source?.ref } }));
  return { ...profile, windows: [...kept, ...stamped] };
}
