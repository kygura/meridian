// One-shot data pipeline. Run: bun run build:data
// Writes data/airports.json (IATA airports, large+medium, scheduled service)
// and data/capitals.json (capital per country). Outputs are committed.
// runwayM is the longest open runway in metres. server/lib/cities.ts uses it to
// tell a city's main airport from a smaller one in the same size class
// (CMB, 3350 m, over RML, 1833 m, for Colombo).
import { writeFileSync } from "fs";
import { parse } from "csv-parse/sync";

const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const RUNWAYS_CSV = "https://davidmegginson.github.io/ourairports-data/runways.csv";
const COUNTRIES_CSV = "https://davidmegginson.github.io/ourairports-data/countries.csv";
// restcountries.com v3.1 is deprecated; mledoze/countries is its upstream source.
const COUNTRIES_JSON =
  "https://cdn.jsdelivr.net/gh/mledoze/countries@master/countries.json";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

const [airportsRaw, runwaysRaw, countriesRaw, restRaw] = await Promise.all([
  fetchText(AIRPORTS_CSV),
  fetchText(RUNWAYS_CSV),
  fetchText(COUNTRIES_CSV),
  fetchText(COUNTRIES_JSON),
]);

const countryRows = parse(countriesRaw, { columns: true, skip_empty_lines: true });
const isoToName = new Map(countryRows.map((r) => [r.code, r.name]));

// Longest open runway per airport ident, in metres.
const runwayM = new Map();
for (const r of parse(runwaysRaw, { columns: true, skip_empty_lines: true })) {
  const ft = parseFloat(r.length_ft);
  if (r.closed === "1" || !Number.isFinite(ft)) continue;
  const m = Math.round(ft * 0.3048);
  if (m > (runwayM.get(r.airport_ident) ?? 0)) runwayM.set(r.airport_ident, m);
}

const airportRows = parse(airportsRaw, { columns: true, skip_empty_lines: true });
const airports = airportRows
  .filter(
    (r) =>
      (r.type === "large_airport" || r.type === "medium_airport") &&
      r.scheduled_service === "yes" &&
      r.iata_code &&
      r.iata_code.length === 3
  )
  .map((r) => ({
    iata: r.iata_code,
    name: r.name,
    city: r.municipality || "",
    country: isoToName.get(r.iso_country) ?? r.iso_country,
    lat: parseFloat(r.latitude_deg),
    lng: parseFloat(r.longitude_deg),
    size: r.type === "large_airport" ? "large" : "medium",
    ...(runwayM.has(r.ident) ? { runwayM: runwayM.get(r.ident) } : {}),
  }))
  .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lng));

writeFileSync("data/airports.json", JSON.stringify(airports, null, 1));
console.log(`[build:data] wrote ${airports.length} airports`);

const rest = JSON.parse(restRaw);
const capitals = rest
  .filter((c) => Array.isArray(c.capital) && c.capital.length > 0)
  .map((c) => ({ country: c.name.common, capital: c.capital[0] }));
writeFileSync("data/capitals.json", JSON.stringify(capitals, null, 1));
console.log(`[build:data] wrote ${capitals.length} capitals`);
