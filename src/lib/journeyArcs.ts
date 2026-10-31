// Pure builder for the globe journeys layer (DESIGN-journal.md §10). No React, no map.

import { flightPath, greatCirclePoints, type FlightHub, type LngLat } from "./geo";
import { monthOf, yearOf } from "./journal";
import type { Journey, SegmentMode } from "../types";

export interface ArcCity {
  lng: number;
  lat: number;
  name: string;
  iata?: string;
}

export interface JourneyScrubState {
  mode: "chrono" | "season";
  /** chrono: cursor year; undefined = ALL. */
  year?: number;
  /** season: 1-12; undefined = ALL. */
  month?: number;
}

export interface JourneyArc {
  journeyId: string;
  mode: SegmentMode;
  /** One path per piece (a hub-routed flight has two). */
  paths: LngLat[][];
  fromName: string;
  toName: string;
  date: string; // YYYY-MM-DD
  year: number;
  month: number; // 1-12
  number?: string;
}

export interface JourneyStopPoint {
  journeyId: string;
  coord: LngLat;
  label: string;
  year: number; // arrival year
  /** Every month (1-12) the stay touches. */
  months: number[];
}

export interface JourneyArcSet {
  arcs: JourneyArc[];
  stops: JourneyStopPoint[];
}

export function buildJourneyArcs(
  journeys: Journey[],
  cityOf: (id: string) => ArcCity | undefined,
  hubs: FlightHub[] = []
): JourneyArcSet {
  const arcs: JourneyArc[] = [];
  const stops: JourneyStopPoint[] = [];
  for (const j of journeys) {
    if (j.status !== "confirmed") continue;
    for (const g of j.segments) {
      const a = cityOf(g.fromCityId);
      const b = cityOf(g.toCityId);
      if (!a || !b) continue;
      const date = (/^\d{4}-\d{2}-\d{2}/.test(g.departAt) ? g.departAt : j.startDate).slice(0, 10);
      const from: LngLat = [a.lng, a.lat];
      const to: LngLat = [b.lng, b.lat];
      arcs.push({
        journeyId: j.id,
        mode: g.mode,
        paths: g.mode === "flight" ? flightPath(from, to, hubs).segments : [greatCirclePoints(from, to)],
        fromName: a.name,
        toName: b.name,
        date,
        year: yearOf(date),
        month: monthOf(date),
        number: g.number,
      });
    }
    for (const s of j.stops) {
      const c = cityOf(s.cityId);
      if (!c) continue;
      const first = monthOf(s.arrive);
      const last = s.depart >= s.arrive ? monthOf(s.depart) : first;
      const span = yearOf(s.depart) * 12 + last - (yearOf(s.arrive) * 12 + first);
      const months: number[] = [];
      for (let i = 0; i <= Math.min(Math.max(span, 0), 11); i++) months.push(((first - 1 + i) % 12) + 1);
      stops.push({
        journeyId: j.id,
        coord: [c.lng, c.lat],
        label: c.iata ?? c.name,
        year: yearOf(s.arrive),
        months,
      });
    }
  }
  return { arcs, stops };
}

export type ArcEmphasis = "normal" | "hi" | "faded";

/** null = not drawn. chrono: arcs up to the cursor year, earlier years faded. season: only that month, all years. */
export function emphasis(year: number, months: number[], scrub: JourneyScrubState): ArcEmphasis | null {
  if (scrub.mode === "season") {
    if (scrub.month === undefined) return "normal";
    return months.includes(scrub.month) ? "hi" : null;
  }
  if (scrub.year === undefined) return "normal";
  if (year > scrub.year) return null;
  return year === scrub.year ? "hi" : "faded";
}

export function scrubArcs(set: JourneyArcSet, scrub: JourneyScrubState) {
  const arcs: (JourneyArc & { emphasis: ArcEmphasis })[] = [];
  for (const a of set.arcs) {
    const e = emphasis(a.year, [a.month], scrub);
    if (e) arcs.push({ ...a, emphasis: e });
  }
  const stops: (JourneyStopPoint & { emphasis: ArcEmphasis })[] = [];
  for (const s of set.stops) {
    const e = emphasis(s.year, s.months, scrub);
    if (e) stops.push({ ...s, emphasis: e });
  }
  return { arcs, stops };
}

/** Ascending years of confirmed journeys' segments and stops (the years the scrubber can land on). */
export function journeyYears(journeys: Journey[]): number[] {
  const ys = new Set<number>();
  for (const j of journeys) {
    if (j.status !== "confirmed") continue;
    for (const g of j.segments) ys.add(yearOf(/^\d{4}-\d{2}-\d{2}/.test(g.departAt) ? g.departAt : j.startDate));
    for (const s of j.stops) ys.add(yearOf(s.arrive));
  }
  return [...ys].sort((a, b) => a - b);
}
