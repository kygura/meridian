// Seasons: trips as month spans you can take any year (types.ts MonthSpan), made
// concrete only when a year is chosen. Pure helpers; no fetching.

import type { MonthSpan, Trip, TripNode } from "../types";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function isMonth(m: unknown): m is number {
  return Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 12;
}

export function isMonthSpan(s: unknown): s is MonthSpan {
  return !!s && typeof s === "object" && isMonth((s as MonthSpan).start) && isMonth((s as MonthSpan).end);
}

/** Months in the span, in travel order: {11, 2} → [11, 12, 1, 2]. */
export function spanMonths(span: MonthSpan): number[] {
  const out: number[] = [];
  for (let m = span.start; ; m = (m % 12) + 1) {
    out.push(m);
    if (m === span.end || out.length === 12) return out;
  }
}

/** Number of months covered. */
export function spanLength(span: MonthSpan): number {
  return spanMonths(span).length;
}

/** Does the span cover this month (1-12)? */
export function spanHas(span: MonthSpan, month: number): boolean {
  return spanMonths(span).includes(month);
}

/** "Feb", "Feb–Jul", "Nov–Feb"; long form "February to July". */
export function spanLabel(span: MonthSpan, form: "short" | "long" = "short"): string {
  const names = form === "short" ? SHORT : LONG;
  if (span.start === span.end) return names[span.start - 1];
  return form === "short"
    ? `${names[span.start - 1]}–${names[span.end - 1]}`
    : `${names[span.start - 1]} to ${names[span.end - 1]}`;
}

export function monthName(m: number, form: "short" | "long" = "short"): string {
  return (form === "short" ? SHORT : LONG)[m - 1] ?? "";
}

/**
 * The trip's season: from the first placed stop's start to the last placed stop's
 * end, else the trip's own season, else null (not placed in the year yet).
 */
export function tripSeason(trip: Pick<Trip, "nodes" | "season">): MonthSpan | null {
  const placed = trip.nodes.filter((n) => isMonthSpan(n.months));
  if (placed.length) return { start: placed[0].months!.start, end: placed[placed.length - 1].months!.end };
  return isMonthSpan(trip.season) ? trip.season : null;
}

/** "Feb–Jul · any year", "Feb–Jul 2027", "Nov 2027 – Feb 2028", or null without a season. */
export function seasonText(trip: Pick<Trip, "nodes" | "season" | "year">): string | null {
  const s = tripSeason(trip);
  if (!s) return null;
  if (!trip.year) return `${spanLabel(s)} · any year`;
  return s.start > s.end
    ? `${monthName(s.start)} ${trip.year} – ${monthName(s.end)} ${trip.year + 1}`
    : `${spanLabel(s)} ${trip.year}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export interface DatedSpan {
  /** YYYY-MM-DD, first day of the first month. */
  start: string;
  /** YYYY-MM-DD, last day of the last month. */
  end: string;
}

/**
 * The calendar year each month falls in when a season starting in `seasonStart`
 * is taken in `year`: months before the start belong to the following year.
 */
export function yearOfMonth(month: number, seasonStart: number, year: number): number {
  return month >= seasonStart ? year : year + 1;
}

/** Real dates for a span, when its season is taken in `year`. */
export function datedSpan(span: MonthSpan, year: number, seasonStart = span.start): DatedSpan {
  const y0 = yearOfMonth(span.start, seasonStart, year);
  const y1 = span.end >= span.start ? y0 : y0 + 1;
  return {
    start: `${y0}-${pad(span.start)}-01`,
    end: `${y1}-${pad(span.end)}-${pad(lastDay(y1, span.end))}`,
  };
}

/** Each stop's dates for the trip's season in `year` (null for stops not placed). */
export function stopDates(trip: Pick<Trip, "nodes" | "season">, year: number): (DatedSpan | null)[] {
  const season = tripSeason(trip);
  return trip.nodes.map((n) => (isMonthSpan(n.months) ? datedSpan(n.months, year, season?.start ?? n.months.start) : null));
}

/**
 * Departure hint for the leg leaving stop `legIndex`: the first day of the next
 * stop's months, in the chosen year. Undefined without a year or placed stop.
 */
export function legDepartureHint(trip: Pick<Trip, "nodes" | "season" | "year">, legIndex: number): string | undefined {
  if (!trip.year) return undefined;
  const dates = stopDates(trip, trip.year);
  // -2 is the flight home (tripPlan.RETURN_LEG): leave on the last stop's last day.
  if (legIndex === -2) return dates[dates.length - 1]?.end;
  // -1 is the flight out from the departure: arrive for the first stop (same as i + 1 = 0).
  return dates[legIndex + 1]?.start;
}

/**
 * The years this season can still be taken, soonest first. A season that has
 * already started this year counts from next year.
 */
export function upcomingYears(span: MonthSpan, now: Date = new Date(), count = 3): number[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const first = span.start > m ? y : y + 1;
  return Array.from({ length: count }, (_, i) => first + i);
}

/** Fit of a stop to its months: mean comfort over them, or null without data. */
export function stopComfort(months: MonthSpan | undefined, scores: { score: number }[] | null | undefined): number | null {
  if (!months || !scores || scores.length !== 12) return null;
  const ms = spanMonths(months);
  return Math.round(ms.reduce((a, m) => a + scores[m - 1].score, 0) / ms.length);
}

/** Replace a node's months (or clear them) without touching anything else. */
export function withMonths(node: TripNode, months: MonthSpan | undefined): TripNode {
  const { months: _old, ...rest } = node;
  return months ? { ...rest, months } : rest;
}

export interface SeasonEvent {
  id: string;
  title: string;
  kind: string;
  cityIds: string[];
  month: number;
  date?: string;
  recurring: boolean;
}

/**
 * Events at a stop while you're there. Recurring events match on month alone (they
 * happen every year); dated ones (eclipses, moving holidays like Tết) only once a
 * year is chosen and the date falls inside the stop's dates.
 */
export function stopEvents(
  node: TripNode,
  events: SeasonEvent[],
  dates: DatedSpan | null,
): SeasonEvent[] {
  if (!isMonthSpan(node.months)) return [];
  return events.filter((e) => {
    if (!e.cityIds.includes(node.cityId)) return false;
    if (e.recurring) return spanHas(node.months!, e.month);
    return !!(dates && e.date && e.date >= dates.start && e.date <= dates.end);
  });
}
