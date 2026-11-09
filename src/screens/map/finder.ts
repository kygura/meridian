// The map finder: which cities meet the active climate conditions, metric thresholds and
// conflict exclusion in a month, ranked for the results list. Also turns anomaly feeds
// (seed conflicts and hazards, live news alerts) into map markers. Pure: no React, no fetch.

import { isFilterActive, matchesFilter, monthTraits, type ClimateFilter, type ClimateMonth, type MonthTraits } from "../../lib/climate";
import { METRIC_BY_ID, passesThresholds, type MetricId, type MetricIndex } from "../../lib/cityMetrics";
import { countryKey } from "../../lib/countryNames";
import { newsPlace } from "../../lib/newsRegions";
import type { City, MapAnomaly, MapEventPoint, TickerItem } from "../../types";
import type { AnomalyDatum, EventDatum } from "./overlays";
import { MONTH_NAMES } from "./basemap";

export interface FinderInput {
  cities: City[];
  /** 1-12 */
  month: number;
  /** null when the seasons layer is off. */
  climate: ClimateFilter | null;
  /** Every covered city's months; null while loading. */
  climateData: Record<string, ClimateMonth[]> | null;
  thresholds: [MetricId, number][];
  metricIndex: MetricIndex;
  /** countryKey()s whose cities count as misses. */
  excluded: Set<string> | null;
}

export interface FinderHit {
  city: City;
  traits: MonthTraits | null;
}

export interface FinderResult {
  /** Any filter running. */
  filtering: boolean;
  /** Waiting on data a filter needs. */
  pending: boolean;
  matches: Set<string>;
  /** Matches, most comfortable first, then by population. */
  ranked: FinderHit[];
}

export function runFinder(input: FinderInput): FinderResult {
  const { cities, month, climate, climateData, thresholds, metricIndex, excluded } = input;
  const climateOn = !!climate && isFilterActive(climate);
  const excluding = !!excluded && excluded.size > 0;
  const filtering = climateOn || thresholds.length > 0 || excluding;
  const pending =
    (climateOn && !climateData) || thresholds.some(([id]) => !metricIndex[id]);
  const matches = new Set<string>();
  const ranked: FinderHit[] = [];
  if (!filtering || pending) return { filtering, pending, matches, ranked };

  for (const city of cities) {
    if (excluding && excluded!.has(countryKey(city.country))) continue;
    if (thresholds.length && !passesThresholds(city.id, thresholds, metricIndex)) continue;
    const months = climateData?.[city.id];
    const traits = months ? monthTraits(months, month) : null;
    if (climateOn && (!traits || !matchesFilter(traits, climate!))) continue;
    matches.add(city.id);
    ranked.push({ city, traits });
  }
  ranked.sort((a, b) => (b.traits?.comfort ?? -1) - (a.traits?.comfort ?? -1) || b.city.population - a.city.population);
  return { filtering, pending, matches, ranked };
}

/** cityId -> 0-100 "goodness" for colouring (crowds inverted so green is always good). */
export function metricColours(index: MetricIndex, id: MetricId | "none"): Map<string, number> | null {
  if (id === "none") return null;
  const values = index[id];
  if (!values) return null;
  if (METRIC_BY_ID.get(id)?.direction !== "max") return values;
  const out = new Map<string, number>();
  for (const [k, v] of values) out.set(k, 100 - v);
  return out;
}

export function eventData(points: MapEventPoint[]): EventDatum[] {
  return points.map((p) => ({
    kind: "event",
    coord: [p.lng, p.lat],
    eventId: p.eventId,
    title: p.title,
    eventKind: p.kind,
    date: p.date,
    recurring: p.recurring,
    cityId: p.cityId,
    cityName: p.cityName,
  }));
}

function monthSpan(months: number[] | undefined): string {
  if (!months?.length) return "";
  const names = months.map((m) => MONTH_NAMES[m - 1]?.slice(0, 3)).filter(Boolean);
  return names.length > 2 ? `${names[0]}–${names[names.length - 1]}` : names.join(", ");
}

export function seedAnomalyData(items: MapAnomaly[], month: number): AnomalyDatum[] {
  return items.map((a) => {
    const peak = a.kind === "hazard" && !!a.peak?.includes(month);
    const sub =
      a.kind === "conflict"
        ? `Conflict advisory${a.country ? ` · ${a.country}` : ""}`
        : a.kind === "advisory"
          ? `Advisory${a.country ? ` · ${a.country}` : ""}${a.since ? ` · since ${a.since}` : ""}`
          : `Seasonal hazard · ${monthSpan(a.months)}${peak ? " · peak now" : ""}`;
    return {
      kind: "anomaly",
      coord: [a.lng, a.lat],
      id: a.id,
      source: a.kind,
      label: a.label,
      sub,
      severity: Math.max(1, Math.min(3, Math.round(a.severity || 1))),
      peak,
    };
  });
}

/**
 * Live alert and hazard headlines placed on their country's capital. Headlines with no
 * single-country label ("WORLD", "MIDEAST") are skipped. One marker per country.
 */
export function newsAnomalyData(items: TickerItem[], cities: City[]): AnomalyDatum[] {
  const capital = new Map<string, City>();
  for (const c of cities) if (c.capital) capital.set(countryKey(c.country), c);
  const byCountry = new Map<string, { city: City; items: TickerItem[] }>();
  for (const it of items) {
    if (it.glyph !== "alert" && it.glyph !== "hazard") continue;
    const place = newsPlace(it.location);
    if (!place.country) continue;
    const key = countryKey(place.country);
    const city = capital.get(key);
    if (!city) continue;
    const entry = byCountry.get(key) ?? { city, items: [] };
    entry.items.push(it);
    byCountry.set(key, entry);
  }
  return [...byCountry.entries()].map(([key, { city, items: list }]) => ({
    kind: "anomaly" as const,
    coord: [city.lng, city.lat] as [number, number],
    id: `news:${key}`,
    source: "news" as const,
    label: list[0]!.text,
    sub: `News alert · ${city.country}${list.length > 1 ? ` · ${list.length} headlines` : ""}`,
    severity: list.some((i) => i.glyph === "alert") ? 2 : 1,
    cityId: city.id,
  }));
}

/** countryKey()s with a standing conflict advisory. */
export function conflictCountries(items: MapAnomaly[]): Set<string> {
  const out = new Set<string>();
  for (const a of items) if (a.kind === "conflict" && a.country) out.add(countryKey(a.country));
  return out;
}
