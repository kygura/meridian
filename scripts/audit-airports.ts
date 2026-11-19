// Audit how airport codes resolve to cities. For every airport in
// data/airports.json, finds the city an IATA code resolves to and how far that
// city is from the airport. Reports airports that resolve to a city farther
// than maxKm (default 60), and cities that fly from an airport that far away.
//
// Run: npx tsx scripts/audit-airports.ts [maxKm]
import { readFileSync } from "fs";
import { join } from "path";
import { cityForIata, getCities, loadCities } from "../server/lib/cities.js";
import { haversineKm } from "../src/lib/geo.js";
import type { City } from "../src/types.js";

const maxKm = Number(process.argv[2] ?? 60);
const airports = JSON.parse(readFileSync(join(process.cwd(), "data/airports.json"), "utf-8")) as Array<{
  iata: string;
  name: string;
  lat: number;
  lng: number;
  size: string;
}>;
loadCities();

const km = (c: City, a: { lat: number; lng: number }) => haversineKm([c.lng, c.lat], [a.lng, a.lat]);
const rows = airports.map((a) => {
  const city = cityForIata(a.iata);
  return { a, city, km: city ? km(city, a) : NaN };
});
const unresolved = rows.filter((r) => !r.city);
const far = rows.filter((r) => r.km > maxKm).sort((x, y) => y.km - x.km);

console.log(`airports: ${airports.length}`);
console.log(`unresolved codes: ${unresolved.length}`);
console.log(`codes resolving to a city more than ${maxKm} km from the airport: ${far.length}`);
for (const r of far) console.log(`  ${r.a.iata}\t${r.a.size}\t${Math.round(r.km)} km\t${r.city!.id}\t(${r.a.name})`);

const byIata = new Map(airports.map((a) => [a.iata, a]));
const flyFar = getCities().filter((c) => {
  const a = c.iata ? byIata.get(c.iata) : undefined;
  return a && km(c, a) > maxKm;
});
console.log(`cities whose own airport is more than ${maxKm} km away: ${flyFar.length}`);
