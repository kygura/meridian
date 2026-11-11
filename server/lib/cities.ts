import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";
import type { City } from "../../src/types.js";
import { haversineKm } from "../../src/lib/geo.js";

interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  size: "large" | "medium";
}

let cities: City[] = [];

// worldcities.csv country spellings → OurAirports/mledoze spellings.
// Distance matching below is the primary mechanism; these help exact joins.
const COUNTRY_ALIASES: Record<string, string> = {
  "Korea, South": "South Korea",
  "Korea, North": "North Korea",
  Burma: "Myanmar",
  "Congo (Kinshasa)": "Democratic Republic of the Congo",
  "Congo (Brazzaville)": "Republic of the Congo",
  "Côte D’Ivoire": "Ivory Coast",
  Czechia: "Czech Republic",
  Macedonia: "North Macedonia",
  Swaziland: "Eswatini",
};

function canonCountry(name: string): string {
  return (COUNTRY_ALIASES[name] ?? name).toLowerCase();
}

function slugify(city: string, country: string): string {
  return `${city}-${country}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function loadCities(): void {
  const csvPath = join(process.cwd(), "data/worldcities.csv");
  const records = parse(readFileSync(csvPath, "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<{ city: string; lat: string; lng: string; country: string; population: string }>;

  let airports: Airport[] = [];
  try {
    airports = JSON.parse(
      readFileSync(join(process.cwd(), "data/airports.json"), "utf-8")
    );
  } catch {
    console.warn("[cities] data/airports.json missing — run `bun run build:data`");
  }

  let capitals: Array<{ country: string; capital: string }> = [];
  try {
    capitals = JSON.parse(
      readFileSync(join(process.cwd(), "data/capitals.json"), "utf-8")
    );
  } catch {
    console.warn("[cities] data/capitals.json missing — run `bun run build:data`");
  }
  const capitalSet = new Set(
    capitals.map((c) => `${c.capital.toLowerCase()}|${c.country.toLowerCase()}`)
  );

  const base: City[] = records.map((r) => ({
    id: slugify(r.city, r.country),
    name: r.city,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lng),
    country: r.country,
    population: parseInt(r.population, 10) || 0,
  }));

  // Country-aware nearest-airport assignment.
  // Primary: same (canonical) country within 100 km, preferring large airports.
  // Fallback: any airport within 40 km (covers country-name mismatches).
  const byCountry = new Map<string, Airport[]>();
  for (const a of airports) {
    const key = canonCountry(a.country);
    const arr = byCountry.get(key) ?? [];
    arr.push(a);
    byCountry.set(key, arr);
  }

  const usedIatas = new Set<string>();
  for (const city of base) {
    const sameCountry = byCountry.get(canonCountry(city.country)) ?? [];
    // Preference order: airport named after the city (LAX not BUR for Los
    // Angeles), then large over medium, then nearest.
    const pick = (pool: Airport[], maxKm: number): Airport | undefined => {
      let best: { a: Airport; d: number; score: number } | undefined;
      for (const a of pool) {
        const d = haversineKm([city.lng, city.lat], [a.lng, a.lat]);
        if (d > maxKm) continue;
        const score =
          (a.city.toLowerCase() === city.name.toLowerCase() ? 2 : 0) +
          (a.size === "large" ? 1 : 0);
        if (!best || score > best.score || (score === best.score && d < best.d)) {
          best = { a, d, score };
        }
      }
      return best?.a;
    };
    const match = pick(sameCountry, 100) ?? pick(airports, 40);
    if (match) {
      city.iata = match.iata;
      city.hub = match.size;
      city.airportName = match.name;
      usedIatas.add(match.iata);
    }
    if (capitalSet.has(`${city.name.toLowerCase()}|${canonCountry(city.country)}`)) {
      city.capital = true;
    }
  }

  // Synthesize cities for airports that no existing city claimed (e.g. Penang),
  // so every scheduled airport is selectable and searchable.
  const existingIds = new Set(base.map((c) => c.id));
  for (const a of airports) {
    if (usedIatas.has(a.iata)) continue;
    const name = a.city || a.name.replace(/ (International )?Airport$/i, "");
    const id = slugify(name, a.country);
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    base.push({
      id,
      name,
      lat: a.lat,
      lng: a.lng,
      country: a.country,
      population: 0,
      iata: a.iata,
      hub: a.size,
      airportName: a.name,
    });
  }

  // Native names (scripts/build-native-names.ts), for the map's label option.
  try {
    const native = JSON.parse(readFileSync(join(process.cwd(), "data/native-names.json"), "utf-8")) as {
      names: Record<string, string>;
    };
    for (const city of base) {
      const n = native.names[city.id];
      if (n) city.nativeName = n;
    }
  } catch {
    console.warn("[cities] data/native-names.json missing — run scripts/build-native-names.ts");
  }

  // Time zone and landmass (scripts/build-city-geo.ts), for the calendar export and
  // for choosing ground transport, a ferry or a flight on a trip leg.
  try {
    const geo = JSON.parse(readFileSync(join(process.cwd(), "data/city-geo.json"), "utf-8")) as {
      zones: string[];
      cities: Record<string, [number, number]>;
    };
    for (const city of base) {
      const g = geo.cities[city.id];
      if (!g) continue;
      if (g[0] >= 0) city.landmass = g[0];
      if (geo.zones[g[1]]) city.timezone = geo.zones[g[1]];
    }
  } catch {
    console.warn("[cities] data/city-geo.json missing — run scripts/build-city-geo.ts");
  }

  cities = base;
  console.log(
    `[cities] Loaded ${cities.length} cities (${cities.filter((c) => c.iata).length} with airports)`
  );
}

export function getCities(): City[] {
  return cities;
}

export function getCityById(id: string): City | undefined {
  return cities.find((c) => c.id === id);
}

/**
 * Ranked search. If the query names a country, return that country's
 * airport cities first (capital, then hub size, then population).
 * Otherwise match city name / IATA / airport name / country substring.
 */
export function searchCities(query: string): City[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const isCountryQuery =
    q.length >= 4 &&
    cities.some(
      (c) => canonCountry(c.country).startsWith(q) || c.country.toLowerCase().startsWith(q)
    );

  const rank = (c: City): number => {
    let s = 0;
    if (c.capital) s += 400;
    if (c.hub === "large") s += 300;
    else if (c.hub === "medium") s += 100;
    if (c.iata) s += 200;
    s += Math.min(99, Math.floor(c.population / 200_000));
    return s;
  };

  if (isCountryQuery) {
    const inCountry = cities.filter(
      (c) =>
        canonCountry(c.country).startsWith(q) || c.country.toLowerCase().startsWith(q)
    );
    // Country view = its airports: airport cities first, ranked.
    return inCountry
      .sort((a, b) => rank(b) - rank(a))
      .filter((c, i) => c.iata || i < 5)
      .slice(0, 40);
  }

  const scored = cities
    .map((c) => {
      const name = c.name.toLowerCase();
      let s = -1;
      if (name === q || c.iata?.toLowerCase() === q) s = 3000;
      else if (name.startsWith(q)) s = 2000;
      else if (name.includes(q)) s = 1000;
      else if (c.airportName?.toLowerCase().includes(q)) s = 800;
      else if (c.country.toLowerCase().includes(q)) s = 500;
      if (s < 0) return null;
      return { c, s: s + rank(c) };
    })
    .filter((x): x is { c: City; s: number } => x !== null)
    .sort((a, b) => b.s - a.s);

  return scored.slice(0, 40).map((x) => x.c);
}
