import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";
import type { City } from "../../src/types.js";

let cities: City[] = [];
let iataMap: Record<string, string> = {};

function slugify(city: string, country: string): string {
  return `${city}-${country}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function loadCities(): void {
  const csvPath = join(process.cwd(), "data/worldcities.csv");
  const raw = readFileSync(csvPath, "utf-8");
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<{
    city: string;
    lat: string;
    lng: string;
    country: string;
    population: string;
  }>;

  // Load IATA code mapping
  const mapPath = join(process.cwd(), "data/iata_map.json");
  try {
    iataMap = JSON.parse(readFileSync(mapPath, "utf-8"));
  } catch {
    console.warn("[cities] iata_map.json not found, will use city names as fallback");
    iataMap = {};
}

  cities = records.map((r) => ({
    id: slugify(r.city, r.country),
    name: r.city,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lng),
    country: r.country,
    population: parseInt(r.population, 10) || 0,
    iata: iataMap[r.city] || undefined,
  }));

  console.log(`[cities] Loaded ${cities.length} cities`);
}

export function getCities(): City[] {
  return cities;
}

export function getCityById(id: string): City | undefined {
  return cities.find((c) => c.id === id);
}

export function searchCities(query: string): City[] {
  const q = query.toLowerCase();
  return cities.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.country.toLowerCase().includes(q)
  );
}
