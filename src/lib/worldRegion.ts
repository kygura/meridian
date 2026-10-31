// Broad world regions for filters (When to go). Pure: no React, no fetch.
//
// City records carry a country name and coordinates but no continent. A country's region
// comes from a short override list for the ambiguous ones (North Africa, the Middle East,
// Turkey, Russia, island states), otherwise from the coordinates of one of its cities.

export type WorldRegion = "europe" | "asia" | "middle-east" | "africa" | "americas" | "oceania";

export const WORLD_REGIONS: { value: WorldRegion; label: string }[] = [
  { value: "europe", label: "Europe" },
  { value: "asia", label: "Asia" },
  { value: "middle-east", label: "Middle East" },
  { value: "africa", label: "Africa" },
  { value: "americas", label: "Americas" },
  { value: "oceania", label: "Oceania" },
];

export function worldRegionLabel(r: WorldRegion): string {
  return WORLD_REGIONS.find((x) => x.value === r)?.label ?? r;
}

const OVERRIDES: Record<string, WorldRegion> = {
  morocco: "africa",
  algeria: "africa",
  tunisia: "africa",
  libya: "africa",
  egypt: "africa",
  sudan: "africa",
  mauritius: "africa",
  seychelles: "africa",
  "cabo verde": "africa",
  "cape verde": "africa",
  turkey: "europe",
  turkiye: "europe",
  cyprus: "europe",
  russia: "europe",
  iceland: "europe",
  portugal: "europe",
  spain: "europe",
  georgia: "europe",
  armenia: "europe",
  azerbaijan: "europe",
  kazakhstan: "asia",
  israel: "middle-east",
  "west bank": "middle-east",
  "gaza strip": "middle-east",
  lebanon: "middle-east",
  syria: "middle-east",
  jordan: "middle-east",
  iraq: "middle-east",
  iran: "middle-east",
  "saudi arabia": "middle-east",
  yemen: "middle-east",
  oman: "middle-east",
  "united arab emirates": "middle-east",
  qatar: "middle-east",
  bahrain: "middle-east",
  kuwait: "middle-east",
  "papua new guinea": "oceania",
  indonesia: "asia",
  "timor-leste": "asia",
  greenland: "americas",
  "united states": "americas",
  "french polynesia": "oceania",
  "new caledonia": "oceania",
};

/** Region for a point, by coarse boxes. Use regionForCountry when the country is known. */
export function regionAt(lat: number, lng: number): WorldRegion {
  if (lng < -25) return lng < -130 && lat < 15 ? "oceania" : "americas";
  if ((lat < -10 && lng >= 110) || (lat < 0 && lng >= 140) || lng >= 165) return "oceania";
  if (lat >= 36 && lng < 45) return "europe";
  if (lat >= 12 && lat < 42 && lng >= 34 && lng < 63) return "middle-east";
  if ((lat < 36 && lng < 34) || (lat < 12 && lng < 60)) return "africa";
  return "asia";
}

/** Region for a country (city-record spelling), with coordinates as the fallback. */
export function regionForCountry(country: string, lat: number, lng: number): WorldRegion {
  return OVERRIDES[country.trim().toLowerCase()] ?? regionAt(lat, lng);
}

interface CityLike {
  country: string;
  lat: number;
  lng: number;
  population?: number;
  capital?: boolean;
}

/**
 * Country -> region for every country in the list, placed by its capital (or largest city)
 * so a country never splits across regions.
 */
export function countryRegions(cities: CityLike[]): Map<string, WorldRegion> {
  const anchor = new Map<string, CityLike>();
  for (const c of cities) {
    const cur = anchor.get(c.country);
    if (
      !cur ||
      (c.capital && !cur.capital) ||
      (!!c.capital === !!cur.capital && (c.population ?? 0) > (cur.population ?? 0))
    ) {
      anchor.set(c.country, c);
    }
  }
  const out = new Map<string, WorldRegion>();
  for (const [country, c] of anchor) out.set(country, regionForCountry(country, c.lat, c.lng));
  return out;
}
