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
  /** Longest open runway in metres (scripts/build-airports.mjs). */
  runwayM?: number;
}

let cities: City[] = [];
/** IATA code → id of the city the airport serves (see cityForIata). */
let homeByIata = new Map<string, string>();

/** An airport is "in" a city only when the city is this close. Farther cities may still fly from it. */
export const AIRPORT_HOME_KM = 60;

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

/** Name for comparison: no case, accents or invisible marks ("Granada\u200e" in worldcities.csv). */
const nameKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .trim()
    .toLowerCase();
const sameName = (a: Airport, city: { name: string }) => a.city !== "" && nameKey(a.city) === nameKey(city.name);

/** Runway length that long-haul wide-body jets need, in metres. */
const WIDEBODY_RUNWAY_M = 2500;
const takesWidebody = (a: Airport) => (a.runwayM ?? 0) >= WIDEBODY_RUNWAY_M;

/** The airport a city flies from. Exported for tests. */
export function pickAirport(
  city: { name: string; lat: number; lng: number },
  pool: Airport[],
  maxKm: number
): Airport | undefined {
  let best: { a: Airport; d: number; score: number } | undefined;
  for (const a of pool) {
    const d = haversineKm([city.lng, city.lat], [a.lng, a.lat]);
    if (d > maxKm) continue;
    // Plain case-insensitive match, as before the home rule existed: a looser
    // match here would move cities off their airports and drop synthesized ids.
    const named = a.city.toLowerCase() === city.name.toLowerCase();
    const score = (named ? 2 : 0) + (a.size === "large" ? 1 : 0);
    if (!best || score > best.score) {
      best = { a, d, score };
      continue;
    }
    if (score < best.score) continue;
    // Same score. Between two airports named after the city, one that takes
    // wide-body jets beats one that does not (JFK over LGA, CMB over RML).
    // Otherwise the nearer.
    const jetGap = named ? Number(takesWidebody(a)) - Number(takesWidebody(best.a)) : 0;
    if (jetGap > 0 || (jetGap === 0 && d < best.d)) best = { a, d, score };
  }
  return best?.a;
}

/**
 * The city each airport is in. Candidates are cities within AIRPORT_HOME_KM of
 * the airport that either fly from it or share its municipality name (VKO is in
 * Moscow although Moscow flies from SVO). Ranked: named after, then flies from
 * it, then most populous, then nearest. Cities whose id is not unique are
 * skipped, since an id would not lead back to them (two "Portland, United
 * States" rows). Airports with no candidate are left out. Exported for tests.
 */
export function assignAirportHomes(
  cityList: Array<{ id: string; name: string; lat: number; lng: number; population: number; iata?: string }>,
  airports: Airport[]
): Map<string, string> {
  type C = (typeof cityList)[number];
  const idCount = new Map<string, number>();
  for (const c of cityList) idCount.set(c.id, (idCount.get(c.id) ?? 0) + 1);
  const unique = cityList.filter((c) => idCount.get(c.id) === 1);
  const group = (key: (c: C) => string | undefined) => {
    const m = new Map<string, C[]>();
    for (const c of unique) {
      const k = key(c);
      if (!k) continue;
      const arr = m.get(k) ?? [];
      arr.push(c);
      m.set(k, arr);
    }
    return m;
  };
  const byIata = group((c) => c.iata);
  const byName = group((c) => nameKey(c.name));

  const homes = new Map<string, string>();
  for (const a of airports) {
    const pool = new Set([...(byIata.get(a.iata) ?? []), ...(a.city ? (byName.get(nameKey(a.city)) ?? []) : [])]);
    const near = [...pool]
      .map((c) => ({ c, d: haversineKm([c.lng, c.lat], [a.lng, a.lat]) }))
      .filter((x) => x.d <= AIRPORT_HOME_KM)
      .sort(
        (x, y) =>
          Number(sameName(a, y.c)) - Number(sameName(a, x.c)) ||
          Number(y.c.iata === a.iata) - Number(x.c.iata === a.iata) ||
          y.c.population - x.c.population ||
          x.d - y.d
      );
    if (near[0]) homes.set(a.iata, near[0].c.id);
  }
  return homes;
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

  // Country-aware airport assignment, in two directions.
  //
  // city → airport (city.iata, used for fares): same (canonical) country within
  // 100 km, else any airport within 40 km (covers country-name mismatches).
  // Preference: an airport named after the city (LAX not BUR for Los Angeles),
  // then large over medium, then one with a wide-body runway among airports
  // named after the city (CMB, 3350 m, over RML, 1833 m, for Colombo), then
  // the nearest. A city with
  // no airport of its own (Kandy) gets the nearest suitable one (CMB, 87 km).
  //
  // airport → city (cityForIata, used to resolve a code to a place): the city
  // the airport is in. See assignAirportHomes below.
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
    const match = pickAirport(city, sameCountry, 100) ?? pickAirport(city, airports, 40);
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

  homeByIata = assignAirportHomes(base, airports);

  // Synthesize cities at airports, so every scheduled airport is selectable,
  // searchable and resolvable to a place near it. Two passes, so ids made by
  // the first never change:
  // 1. Airports no city flies from (Penang), under the plain name id.
  // 2. Airports still without a home (every city that flies from them is
  //    farther than AIRPORT_HOME_KM). When the plain id is taken by a
  //    same-named city elsewhere (Portland, Oregon for PWM in Maine), the id
  //    takes the airport code: portland-pwm-united-states.
  const existingIds = new Set(base.map((c) => c.id));
  const synthesize = (a: Airport, id: string, name: string) => {
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
    if (!homeByIata.has(a.iata)) homeByIata.set(a.iata, id);
  };
  const synthName = (a: Airport) => a.city || a.name.replace(/ (International )?Airport$/i, "");
  for (const a of airports) {
    if (usedIatas.has(a.iata)) continue;
    const id = slugify(synthName(a), a.country);
    if (!existingIds.has(id)) synthesize(a, id, synthName(a));
  }
  for (const a of airports) {
    if (homeByIata.has(a.iata)) continue;
    const name = synthName(a);
    let id = slugify(name, a.country);
    if (existingIds.has(id)) id = slugify(`${name} ${a.iata}`, a.country);
    if (!existingIds.has(id)) synthesize(a, id, name);
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
 * The city an airport code stands for: the city the airport is in, not every
 * city that flies from it (CMB → Colombo, not Kandy). Falls back to the largest
 * city that carries the code when the airport has no city within AIRPORT_HOME_KM
 * and no synthesized one.
 */
export function cityForIata(code: string): City | undefined {
  const wanted = code.toUpperCase();
  const home = homeByIata.get(wanted);
  if (home) {
    const city = getCityById(home);
    if (city) return city;
  }
  const hubRank = (c: City) => (c.hub === "large" ? 2 : c.hub === "medium" ? 1 : 0);
  return cities
    .filter((c) => c.iata?.toUpperCase() === wanted)
    .sort((a, b) => hubRank(b) - hubRank(a) || b.population - a.population)[0];
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
