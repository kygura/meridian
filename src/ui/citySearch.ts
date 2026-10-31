import type { City } from "../types";

/**
 * Local city search, airport first (ported from the old trips page). Matches name,
 * exact IATA code, airport name, or country prefix; cities with an airport rank first,
 * then by population. Needs two characters.
 */
export function searchCities(cities: City[], q: string, limit = 8, excludeIds?: ReadonlySet<string>): City[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return cities
    .filter(
      (c) =>
        !excludeIds?.has(c.id) &&
        (c.name.toLowerCase().includes(s) ||
          c.iata?.toLowerCase() === s ||
          c.airportName?.toLowerCase().includes(s) ||
          c.country.toLowerCase().startsWith(s))
    )
    .sort((a, b) => (b.iata ? 1 : 0) - (a.iata ? 1 : 0) || b.population - a.population)
    .slice(0, limit);
}
