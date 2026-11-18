// Event kinds (ADR 0021): labels, a short legend line and the order the map legend lists them in.
// Pure helpers shared by the map, the trip season view and the tests.

import type { MeridianEvent } from "../types";

export type EventKind = MeridianEvent["kind"];

export const EVENT_KIND_LABELS: Record<EventKind, string> = {
  festival: "Festival",
  eclipse: "Solar eclipse",
  sky: "Sky",
  nature: "Nature",
  season: "Tourism season",
  culture: "Culture",
  sport: "Sport",
  other: "Event",
};

/** Kinds the live sources produce, in legend order. The map leaves "season" off by default. */
export const LIVE_EVENT_KINDS: EventKind[] = ["festival", "nature", "sky", "eclipse", "season"];

/** Kinds that draw one marker per event and city. Peak and shoulder seasons are too many for that. */
export const MAP_DEFAULT_KINDS: EventKind[] = ["festival", "nature", "sky", "eclipse", "culture", "sport", "other"];

/** A kind's label; an unknown kind (from a newer server) reads as a plain event. */
export function eventKindLabel(kind: string): string {
  return (EVENT_KIND_LABELS as Record<string, string>)[kind] ?? EVENT_KIND_LABELS.other;
}

/** Whether the map draws this kind without the "season" switch. */
export function isMapDefaultKind(kind: string): boolean {
  return kind !== "season";
}

/** The months an event covers: `months` when present and valid, else its `month`. */
export function eventMonths(e: { month: number; months?: number[] }): number[] {
  const ok = (e.months ?? []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  return ok.length ? ok : [e.month];
}

/** Whether a month (1-12) falls in the event's months. */
export function eventInMonth(e: { month: number; months?: number[] }, month: number): boolean {
  return eventMonths(e).includes(month);
}

/**
 * Months in the order a window runs through the year: sorted, rotated to start where a
 * run begins (a month whose predecessor is not in the set), so [12, 1, 2] stays 12, 1, 2.
 * With several runs the earliest start in the calendar year goes first.
 */
export function orderMonths(months: Iterable<number>): number[] {
  const set = new Set([...months].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12));
  if (set.size === 0) return [];
  if (set.size === 12) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const prev = (m: number) => (m === 1 ? 12 : m - 1);
  const first = Math.min(...[...set].filter((m) => !set.has(prev(m))));
  const out: number[] = [];
  for (let i = 0; i < 12; i++) {
    const m = ((first - 1 + i) % 12) + 1;
    if (set.has(m)) out.push(m);
  }
  return out;
}

/** CSS custom property that colours a kind on the map and in its key. */
export const EVENT_KIND_COLOR_VAR: Record<EventKind, string> = {
  festival: "--accent",
  nature: "--success",
  sky: "--info",
  eclipse: "--warning",
  season: "--trip-c",
  culture: "--accent",
  sport: "--accent",
  other: "--accent",
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Every year", or the months a recurring event covers ("Mar to Apr"). */
export function recurringWhen(e: { month: number; months?: number[] }): string {
  const ms = eventMonths(e);
  if (ms.length < 2) return "Every year";
  return `${MONTH_SHORT[ms[0]! - 1]} to ${MONTH_SHORT[ms[ms.length - 1]! - 1]}`;
}
