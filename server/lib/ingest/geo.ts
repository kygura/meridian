// Nearest-city lookup for coordinate-based ingestion (timeline, photos).

import { createHash } from "crypto";
import type { City } from "../../../src/types.js";
import { haversineKm } from "../../../src/lib/geo.js";
import { getCities, getCityById } from "../cities.js";

export const NEAREST_CITY_KM = 50;
/** A place this close to the home city's centre is home, even when another listed city is nearer (a suburb). */
export const HOME_KM = 30;

export function nearHome(homeCityId: string | undefined, lat: number, lng: number): boolean {
  const h = homeCityId ? getCityById(homeCityId) : undefined;
  return !!h && haversineKm([lng, lat], [h.lng, h.lat]) <= HOME_KM;
}

/** Key with the largest count (home inference: most nights, most photo days). */
export const topKey = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * Calendar day of a UTC instant at longitude `lng`: a coarse local offset of whole hours per 15°,
 * rounded toward UTC (time zones and DST sit mostly ahead of solar time in the west). No zone database.
 */
export const localDayAt = (ms: number, lng: number) => new Date(ms + Math.trunc(lng / 15) * 3_600_000).toISOString().slice(0, 10);

let cache: { src: City[]; hits: Map<string, string | null> } | undefined;

/** Nearest city within NEAREST_CITY_KM, or undefined. Memoized per ~1 km cell (visits repeat a lot). */
export function nearestCityId(lat: number, lng: number): string | undefined {
  const all = getCities();
  if (cache?.src !== all) cache = { src: all, hits: new Map() };
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.hits.get(key);
  if (hit !== undefined) return hit ?? undefined;
  // ~0.5 degrees of latitude is 55 km: cheap prefilter before haversine.
  let best: { id: string; d: number } | undefined;
  for (const c of all) {
    if (Math.abs(c.lat - lat) > 0.5) continue;
    const d = haversineKm([lng, lat], [c.lng, c.lat]);
    if (d <= NEAREST_CITY_KM && (!best || d < best.d)) best = { id: c.id, d };
  }
  cache.hits.set(key, best?.id ?? null);
  return best?.id;
}

/** Calendar days between two YYYY-MM-DD strings. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export const shortHash = (parts: (string | number)[], len = 20) =>
  createHash("sha1").update(parts.join("|")).digest("hex").slice(0, len);

// schema.org addressCountry is free text: ISO codes and native spellings are common in e-mails.
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "United States", uk: "United Kingdom", gbr: "United Kingdom", deu: "Germany", deutschland: "Germany",
  fra: "France", esp: "Spain", españa: "Spain", prt: "Portugal", ita: "Italy", italia: "Italy",
  nld: "Netherlands", nederland: "Netherlands", bel: "Belgium", che: "Switzerland", schweiz: "Switzerland", suisse: "Switzerland",
  aut: "Austria", österreich: "Austria", irl: "Ireland", grc: "Greece", tur: "Turkey", türkiye: "Turkey",
  jpn: "Japan", can: "Canada", aus: "Australia", mex: "Mexico", méxico: "Mexico", bra: "Brazil", brasil: "Brazil",
};

/** English country name for a common ISO alpha-3 code or native spelling; other codes (≤3 letters) → "" (no country hint); anything else unchanged. */
export function countryName(raw: string): string {
  const t = raw.trim();
  return COUNTRY_ALIASES[t.toLowerCase()] ?? (t.length > 3 ? t : "");
}
