// Pure helpers for the journal UI (DESIGN-journal.md §1.3, §4, §5). No React, no fetch.

import { haversineKm } from "./geo";
import type { City, Experience, Journey, Money, Segment, SegmentMode, Stop } from "../types";

export type CityIndex = Map<string, City>;

export function cityIndex(cities: City[] | CityIndex): CityIndex {
  return cities instanceof Map ? cities : new Map(cities.map((c) => [c.id, c]));
}

// ── Dates (YYYY-MM-DD strings, parsed by hand: no timezone drift) ────

export const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function parts(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

export function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export function yearOf(s: string): number {
  return parts(s).y;
}

export function monthOf(s: string): number {
  return parts(s).m;
}

/** "12 MAY" */
export function formatDay(s: string): string {
  const p = parts(s);
  return `${p.d} ${MONTHS[p.m - 1] ?? "?"}`;
}

/** Timeline row range: "MAY 12 – 20", "MAY 28 – JUN 2", "DEC 28 2023 – JAN 3 2024". */
export function formatRange(a: string, b: string): string {
  const pa = parts(a);
  const pb = parts(b);
  const ma = MONTHS[pa.m - 1] ?? "?";
  const mb = MONTHS[pb.m - 1] ?? "?";
  if (pa.y !== pb.y) return `${ma} ${pa.d} ${pa.y} – ${mb} ${pb.d} ${pb.y}`;
  if (pa.m !== pb.m) return `${ma} ${pa.d} – ${mb} ${pb.d}`;
  if (pa.d !== pb.d) return `${ma} ${pa.d} – ${pb.d}`;
  return `${ma} ${pa.d}`;
}

/** Detail header range: "12 MAY – 20 MAY 2024". */
export function formatRangeLong(a: string, b: string): string {
  const pa = parts(a);
  const pb = parts(b);
  const end = `${formatDay(b)} ${pb.y}`;
  return pa.y === pb.y ? `${formatDay(a)} – ${end}` : `${formatDay(a)} ${pa.y} – ${end}`;
}

// ── Money ────────────────────────────────────────────────────────────

export function formatEur(n: number): string {
  return `€${Math.round(n).toLocaleString("en-US")}`;
}

/** EUR value of a Money, or an em dash when absent (absent is never zero). */
export function formatMoney(m: Money | undefined): string {
  if (!m) return "—";
  if (typeof m.eur === "number") return formatEur(m.eur);
  return `${m.amount.toLocaleString("en-US")} ${m.currency}`;
}

const eurOf = (m: Money | undefined): number | undefined =>
  m && typeof m.eur === "number" ? m.eur : undefined;

export interface Spend {
  stays: number;
  transport: number;
  experiences: number;
  total: number;
  /** False when no item carries money at all. */
  priced: boolean;
  /** Per category: false means nothing in it is priced (show "—", never 0). */
  has: { stays: boolean; transport: boolean; experiences: boolean };
}

export function spendBreakdown(j: Journey): Spend {
  const sum = (ms: (Money | undefined)[]) => {
    const vs = ms.map(eurOf).filter((v): v is number => v !== undefined);
    return { total: vs.reduce((a, v) => a + v, 0), has: vs.length > 0 };
  };
  const stays = sum(j.stops.map((s) => s.lodging?.cost));
  const transport = sum(j.segments.map((s) => s.cost));
  const experiences = sum(j.experiences.map((e) => e.cost));
  const has = { stays: stays.has, transport: transport.has, experiences: experiences.has };
  return {
    stays: stays.total,
    transport: transport.total,
    experiences: experiences.total,
    total: stays.total + transport.total + experiences.total,
    priced: has.stays || has.transport || has.experiences,
    has,
  };
}

/** Total EUR across lodging, segments and experiences; null when nothing is priced. */
export function spendEur(j: Journey): number | null {
  const s = spendBreakdown(j);
  return s.priced ? s.total : null;
}

// ── Geography ────────────────────────────────────────────────────────

/** Great-circle km over flight segments whose endpoints are both known. */
export function kmFlown(j: Journey, cities: City[] | CityIndex): number {
  const idx = cityIndex(cities);
  let km = 0;
  for (const seg of j.segments) {
    if (seg.mode !== "flight") continue;
    const a = idx.get(seg.fromCityId);
    const b = idx.get(seg.toCityId);
    if (a && b) km += haversineKm([a.lng, a.lat], [b.lng, b.lat]);
  }
  return km;
}

export function journeyNights(j: Journey): number {
  return Math.max(0, daysBetween(j.startDate, j.endDate));
}

export function stopNights(s: Stop): number {
  return Math.max(0, daysBetween(s.arrive, s.depart));
}

export interface JournalStats {
  journeys: number;
  countries: number;
  cities: number;
  nights: number;
  km: number;
  spendEur: number;
  /** Confirmed journeys with no money recorded. */
  unpriced: number;
}

/** Header stats over the confirmed journeys in `journeys` (drafts never count). */
export function journeyStats(journeys: Journey[], cities: City[] | CityIndex): JournalStats {
  const idx = cityIndex(cities);
  const countries = new Set<string>();
  const cityIds = new Set<string>();
  const out: JournalStats = { journeys: 0, countries: 0, cities: 0, nights: 0, km: 0, spendEur: 0, unpriced: 0 };
  for (const j of journeys) {
    if (j.status !== "confirmed") continue;
    out.journeys++;
    out.nights += journeyNights(j);
    out.km += kmFlown(j, idx);
    const spend = spendBreakdown(j);
    if (spend.priced) out.spendEur += spend.total;
    else out.unpriced++;
    for (const s of j.stops) {
      cityIds.add(s.cityId);
      const c = idx.get(s.cityId);
      if (c?.country) countries.add(c.country);
    }
  }
  out.countries = countries.size;
  out.cities = cityIds.size;
  return out;
}

// ── Filters and grouping ─────────────────────────────────────────────

export interface JournalFilters {
  year: number | null;
  /** 0 = any. */
  minRating: number;
  /** A journey must carry every selected tag. */
  tags: string[];
  drafts: boolean;
}

export const DEFAULT_FILTERS: JournalFilters = { year: null, minRating: 0, tags: [], drafts: false };

export function filtersActive(f: JournalFilters): boolean {
  return f.year !== null || f.minRating > 0 || f.tags.length > 0 || f.drafts;
}

export function sortJourneys(journeys: Journey[]): Journey[] {
  return [...journeys].sort(
    (a, b) => b.startDate.localeCompare(a.startDate) || b.endDate.localeCompare(a.endDate)
  );
}

export function filterJourneys(journeys: Journey[], f: JournalFilters): Journey[] {
  return sortJourneys(
    journeys.filter(
      (j) =>
        (f.drafts || j.status === "confirmed") &&
        (f.year === null || yearOf(j.startDate) === f.year) &&
        (f.minRating === 0 || (j.rating ?? 0) >= f.minRating) &&
        f.tags.every((t) => j.tags.includes(t))
    )
  );
}

/** Years present, newest first. */
export function journalYears(journeys: Journey[]): number[] {
  return [...new Set(journeys.map((j) => yearOf(j.startDate)))].sort((a, b) => b - a);
}

export function journalTags(journeys: Journey[]): string[] {
  return [...new Set(journeys.flatMap((j) => j.tags))].sort();
}

export interface YearGroup {
  year: number;
  journeys: Journey[];
  nights: number;
  cities: number;
}

/** Newest year first, newest journey first inside each year. */
export function groupByYear(journeys: Journey[]): YearGroup[] {
  const by = new Map<number, Journey[]>();
  for (const j of sortJourneys(journeys)) {
    const y = yearOf(j.startDate);
    by.set(y, [...(by.get(y) ?? []), j]);
  }
  return [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, js]) => ({
      year,
      journeys: js,
      nights: js.reduce((n, j) => n + journeyNights(j), 0),
      cities: new Set(js.flatMap((j) => j.stops.map((s) => s.cityId))).size,
    }));
}

// ── Labels ───────────────────────────────────────────────────────────

export const MODE_GLYPH: Record<SegmentMode, string> = {
  flight: "✈",
  train: "═",
  bus: "▭",
  car: "◇",
  ferry: "≈",
  other: "·",
};

export const MODE_LABEL: Record<SegmentMode, string> = {
  flight: "Flight",
  train: "Train",
  bus: "Bus",
  car: "Car",
  ferry: "Ferry",
  other: "Other",
};

export function modeGlyphs(segments: Segment[]): string {
  return segments.map((s) => MODE_GLYPH[s.mode] ?? "·").join(" ");
}

export function cityLabel(id: string, cities: CityIndex): string {
  const c = cities.get(id);
  return c ? c.iata ?? c.name : id;
}

/** "LIS → OPO → LIS" */
export function chainLabel(j: Journey, cities: City[] | CityIndex): string {
  const idx = cityIndex(cities);
  return j.stops.map((s) => cityLabel(s.cityId, idx)).join(" → ");
}

/** "3 of 5" / "Not rated" */
export function ratingText(r: number | undefined): string {
  return r ? `${r} of 5` : "Not rated";
}

export function plural(n: number, one: string, many = `${one}S`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// ── Observed vs normal (§5 fingerprint sentence) ─────────────────────

export interface ComfortSentence {
  kind: "kinder" | "rougher" | "same" | "unknown";
  /** Observed minus normal, nights-weighted; absent when kind is "unknown". */
  delta?: number;
  text: string;
}

export const COMFORT_DELTA = 8;

/** Nights-weighted mean of observed.comfort - observed.normalComfort over stops that have it. */
export function comfortSentence(stops: Stop[]): ComfortSentence {
  let w = 0;
  let obs = 0;
  let norm = 0;
  for (const s of stops) {
    if (!s.observed) continue;
    const n = Math.max(1, stopNights(s));
    w += n;
    obs += s.observed.comfort * n;
    norm += s.observed.normalComfort * n;
  }
  if (w === 0) return { kind: "unknown", text: "Weather for these dates hasn't been fetched yet." };
  const o = Math.round(obs / w);
  const nrm = Math.round(norm / w);
  const delta = obs / w - norm / w;
  if (delta >= COMFORT_DELTA) {
    return { kind: "kinder", delta, text: `You got a kinder week than usual — comfort ${o} against a normal ${nrm}.` };
  }
  if (delta <= -COMFORT_DELTA) {
    return { kind: "rougher", delta, text: `A rougher week than the season usually gives — ${o} against ${nrm}.` };
  }
  return { kind: "same", delta, text: "About what the season usually gives." };
}

// ── Detail itinerary (§5) ────────────────────────────────────────────

/** "15 MAY" or "15 MAY 09:40" for an ISO date or datetime. */
export function formatWhen(s: string): string {
  const time = /T(\d{2}:\d{2})/.exec(s)?.[1];
  return time ? `${formatDay(s)} ${time}` : formatDay(s);
}

/** Great-circle km between two known cities, else undefined. */
export function legKm(g: Segment, cities: CityIndex): number | undefined {
  const a = cities.get(g.fromCityId);
  const b = cities.get(g.toCityId);
  return a && b ? haversineKm([a.lng, a.lat], [b.lng, b.lat]) : undefined;
}

export interface Itinerary {
  /** legs[i] joins stops[i] -> stops[i+1]; null when no segment covers the pair. */
  legs: (Segment | null)[];
  /** Segments that do not join consecutive stops (side trips), in original order. */
  other: Segment[];
  /** Experiences per stop (by city, preferring the stop whose dates contain the day). */
  doneByStop: Experience[][];
  /** Experiences whose city is not a stop of this journey. */
  doneOther: Experience[];
}

export function itinerary(j: Journey): Itinerary {
  const used = new Set<number>();
  const legs = j.stops.slice(0, -1).map((s, i) => {
    const at = j.segments.findIndex(
      (g, gi) => !used.has(gi) && g.fromCityId === s.cityId && g.toCityId === j.stops[i + 1].cityId
    );
    if (at >= 0) used.add(at);
    return at >= 0 ? j.segments[at] : null;
  });
  const doneByStop: Experience[][] = j.stops.map(() => []);
  const doneOther: Experience[] = [];
  for (const x of [...j.experiences].sort((a, b) => a.date.localeCompare(b.date))) {
    const inRange = j.stops.findIndex((s) => s.cityId === x.cityId && s.arrive <= x.date && x.date <= s.depart);
    const at = inRange >= 0 ? inRange : j.stops.findIndex((s) => s.cityId === x.cityId);
    if (at >= 0) doneByStop[at].push(x);
    else doneOther.push(x);
  }
  return { legs, other: j.segments.filter((_, i) => !used.has(i)), doneByStop, doneOther };
}
