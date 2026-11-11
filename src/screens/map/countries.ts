import { countryKey } from "../../lib/countryNames";

// Natural Earth 1:50m country polygons, with islands it lacks taken from 1:10m: the basemap's
// land layer, the seasons tint, and the continent lookup the city panel uses to find regional
// news. Built by scripts/build-countries.ts and served with the app. Loaded once.

export const COUNTRIES_URL = "/geo/countries.json";

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
