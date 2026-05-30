import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "csv-parse/sync";
import type { City } from "../../src/types.js";

let cities: City[] = [];

function slugify(city: string, country: string): string {
  return `${city}-${country}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function fakeIata(name: string): string {
  return name
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 3)
    .toUpperCase()
    .padEnd(3, "X");
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

  cities = records.map((r) => ({
    id: slugify(r.city, r.country),
    name: r.city,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lng),
    country: r.country,
    population: parseInt(r.population, 10) || 0,
    iata: fakeIata(r.city),
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
