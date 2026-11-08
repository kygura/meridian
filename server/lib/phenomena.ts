import { readFileSync } from "fs";
import { join } from "path";
import { getDataPath } from "./paths.js";
import { getCityById } from "./cities.js";
import { loadAllEvents, loadEvents } from "./replayService.js";
import type { MapAnomaly, MapEventPoint, MeridianEvent } from "../../src/types.js";

// Map overlay data that is not a metric surface: dated events (data/events.json) placed
// on their cities, and anomalies (data/phenomena.json): standing conflict advisories and
// recurring seasonal hazards by month. Both files are committed seed data.

interface PhenomenaFile {
  version: number;
  asOf: string;
  note?: string;
  items: MapAnomaly[];
}

let cache: PhenomenaFile | null = null;

/** Test-only: re-read data/phenomena.json on the next call. */
export function resetPhenomenaCache(): void {
  cache = null;
}

function validAnomaly(x: unknown): x is MapAnomaly {
  const a = x as Partial<MapAnomaly> | null;
  return (
    !!a &&
    typeof a.id === "string" &&
    (a.kind === "conflict" || a.kind === "advisory" || a.kind === "hazard") &&
    typeof a.label === "string" &&
    Number.isFinite(a.lat) &&
    Number.isFinite(a.lng) &&
    (a.months === undefined || (Array.isArray(a.months) && a.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)))
  );
}

/** data/phenomena.json: a DATA_DIR copy overrides the committed seed. Missing/corrupt -> empty. */
export function loadPhenomena(): PhenomenaFile {
  if (cache) return cache;
  for (const p of new Set([getDataPath("phenomena.json"), join(process.cwd(), "data", "phenomena.json")])) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<PhenomenaFile>;
      const items = Array.isArray(raw.items) ? raw.items.filter(validAnomaly) : [];
      cache = { version: raw.version ?? 1, asOf: typeof raw.asOf === "string" ? raw.asOf : "", note: raw.note, items };
      return cache;
    } catch {
      // next candidate
    }
  }
  cache = { version: 1, asOf: "", items: [] };
  return cache;
}

/** Standing conflicts and advisories for one country (worldcities.csv spelling). */
export function advisoriesForCountry(country: string): MapAnomaly[] {
  const key = country.toLowerCase();
  return loadPhenomena().items.filter((a) => a.kind !== "hazard" && a.country?.toLowerCase() === key);
}

/** Anomalies active in a month (1-12): standing conflicts and advisories always, hazards in their season. */
export function anomaliesFor(month?: number): { asOf: string; note?: string; items: MapAnomaly[] } {
  const data = loadPhenomena();
  const items = month ? data.items.filter((a) => !a.months || a.months.includes(month)) : data.items;
  return { asOf: data.asOf, note: data.note, items };
}

/**
 * Every event touching any of these cities, in any month: recurring ones, and dated
 * ones that haven't passed (a trip planned for a later year needs that year's dates).
 */
export async function eventsForCities(cityIds: string[], now: Date = new Date()): Promise<MeridianEvent[]> {
  const wanted = new Set(cityIds);
  const today = now.toISOString().slice(0, 10);
  return (await loadAllEvents())
    .filter((e) => e.recurring || !e.date || e.date >= today)
    .map((e) => ({ ...e, cityIds: e.cityIds.filter((id) => wanted.has(id)) }))
    .filter((e) => e.cityIds.length > 0);
}

/** Events in a month (1-12), one point per city they touch. Unknown city ids are dropped. */
export async function eventPointsFor(month: number, now: Date = new Date()): Promise<MapEventPoint[]> {
  const events: MeridianEvent[] = await loadEvents(now);
  const out: MapEventPoint[] = [];
  for (const e of events) {
    if (e.month !== month) continue;
    for (const cityId of e.cityIds) {
      const c = getCityById(cityId);
      if (!c) continue;
      out.push({
        eventId: e.id,
        title: e.title,
        kind: e.kind,
        date: e.date,
        recurring: e.recurring,
        cityId,
        cityName: c.name,
        country: c.country,
        lat: c.lat,
        lng: c.lng,
      });
    }
  }
  return out;
}
