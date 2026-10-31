import { countryKey } from "../../lib/countryNames";

// Natural Earth 1:110m country polygons: the basemap's land layer, the seasons tint,
// and the continent lookup the city panel uses to find regional news. Loaded once.

export const COUNTRIES_URL =
  "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_110m_admin_0_countries.geojson";

export type CountryCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;

export interface CountryInfo {
  continent?: string;
  subregion?: string;
}

let cached: CountryCollection | null = null;
let pending: Promise<CountryCollection> | null = null;
const index = new Map<string, CountryInfo>();

const NAME_FIELDS = ["name", "name_long", "admin", "geounit", "sovereignt", "formal_en"] as const;

/** Every join key a feature answers to (see lib/countryNames). */
export function featureKeys(props: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const f of NAME_FIELDS) {
    const v = props[f];
    if (typeof v === "string" && v) keys.add(countryKey(v));
  }
  return [...keys];
}

export function loadCountries(): Promise<CountryCollection> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = fetch(COUNTRIES_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`countries ${r.status}`);
        return r.json() as Promise<CountryCollection>;
      })
      .then((fc) => {
        cached = fc;
        for (const f of fc.features) {
          const p = f.properties ?? {};
          const info: CountryInfo = {
            continent: typeof p.continent === "string" ? p.continent : undefined,
            subregion: typeof p.subregion === "string" ? p.subregion : undefined,
          };
          for (const k of featureKeys(p)) if (!index.has(k)) index.set(k, info);
        }
        return fc;
      })
      .catch((e) => {
        pending = null;
        throw e;
      });
  }
  return pending;
}

/** Continent and subregion for a city-record country name, once the polygons have loaded. */
export function countryInfo(country: string): CountryInfo | undefined {
  return index.get(countryKey(country));
}
