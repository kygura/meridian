// Builds data/country-data.json and data/city-data.json: the measured figures behind cost of
// living, rent, internet, healthcare, stability and crowds (ADR 0013). Replaces the numbers that
// used to be hashed from city and country names.
//
//   npx tsx scripts/build-place-data.ts        (downloads are cached in data/cache/realdata)
//
// What is fetched, and how local it is:
//   cost index   Eurostat correction coefficients for duty stations, Brussels = 100
//                (prc_colc_tot inside the EU, prc_colc_ext outside)                    city (about 190)
//                World Bank price level of household consumption (PPP / exchange rate) country
//   rent         Eurostat average monthly rent for a 1-bedroom flat (prc_colc_rents)   city (44)
//                ICP 2021 housing price level, kept for reference only                 country
//   anchor       Eurostat household consumption per person in Belgium (nama_10_pc)     one number
//   internet     Ookla Open Data, fixed and mobile speed-test tiles within 5-20 km
//                of the centre, test-weighted                                          city
//   healthcare   UHC service coverage index, physicians and hospital beds per 1,000
//                (WHO via World Bank)                                                  country
//   stability    Worldwide Governance Indicators: political stability estimate         country
//   visitors     UN Tourism international arrivals (via Our World in Data) over
//                World Bank population                                                 country
//   months       Eurostat nights in tourist accommodation by month (tour_occ_nin2m)    NUTS 2 region, country
//                English Wikipedia page views by month, as a sign of interest          city
//
// Nothing is estimated here: a value that a source doesn't have is left out, and the app shows
// the gap. Scores are computed from these files at read time (server/lib/placeData.ts).
//
// Ookla's tiles are Parquet, read with hyparquet (a dev dependency; nothing at runtime).

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead } from "hyparquet";
import { loadCities, getCities } from "../server/lib/cities.ts";
import {
  addTile,
  cityRadiusKm,
  correlation,
  emptySpeedAcc,
  finishSpeed,
  inPolygons,
  quadkeyCentre,
  seasonalIndex,
  type Ring,
  type SpeedAcc,
} from "../server/lib/placeDataMath.ts";
import type { City } from "../src/types.ts";

// A generic client name: no project or owner details go to the data providers.
const UA = process.env.DATA_UA ?? "city-data-builder/1.0 (open-data build script)";
const ROOT = process.cwd();
const CACHE = join(ROOT, "data/cache/realdata");
mkdirSync(CACHE, { recursive: true });

/** Latest Ookla quarter to read; override with OOKLA_QUARTER=2026-2. */
const OOKLA = (process.env.OOKLA_QUARTER ?? "2026-3").split("-").map(Number) as [number, number];
/** Whole years of Eurostat monthly nights to average (2020-21 are left out: pandemic). */
const NIGHT_YEARS = [2022, 2023, 2024, 2025];
/** Years of Wikipedia page views to use (2020-21 left out for the same reason). */
const VIEW_YEARS = [2017, 2018, 2019, 2022, 2023, 2024, 2025];
/** Articles read less than this often a month are too noisy for a seasonal pattern. */
const MIN_MONTHLY_VIEWS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function get(url: string, kind: "json" | "text" = "json", tries = 8): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: kind === "json" ? "application/json" : "*/*" } });
      if (res.ok) return kind === "json" ? res.json() : res.text();
      if (res.status === 404) return null;
      if (res.status === 429) {
        // Rate limited: wait as long as the server asks (Wikimedia answers "retry-after: 1"), a little longer each time.
        await sleep((Number(res.headers.get("retry-after")) || 1) * 1000 * (i + 1));
        continue;
      }
      if (res.status >= 500) {
        await sleep(2000 * 2 ** i);
        continue;
      }
      throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`gave up on ${url}`);
}

async function cached<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const p = join(CACHE, `${name}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T;
  const v = await fn();
  writeFileSync(p, JSON.stringify(v));
  return v;
}

async function pooled<T, R>(name: string, items: T[], key: (t: T) => string, fn: (t: T) => Promise<R>, conc = 4) {
  const p = join(CACHE, `${name}.json`);
  const done: Record<string, R> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const todo = items.filter((t) => !(key(t) in done));
  let i = 0;
  let n = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++]!;
      try {
        done[key(t)] = await fn(t);
      } catch (e) {
        console.warn(`\n${name}: ${key(t)}: ${(e as Error).message}`);
      }
      if (++n % 100 === 0) {
        writeFileSync(p, JSON.stringify(done));
        process.stdout.write(`\r${name} ${Object.keys(done).length}/${items.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  writeFileSync(p, JSON.stringify(done));
  process.stdout.write(`\r${name} ${Object.keys(done).length}/${items.length}\n`);
  return done;
}

function km(a: number, b: number, c: number, d: number): number {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

// ── Countries ────────────────────────────────────────────────────────

const COUNTRY_ALIASES: Record<string, string> = {
  "korea, south": "KOR",
  "korea, north": "PRK",
  burma: "MMR",
  "congo (kinshasa)": "COD",
  "congo (brazzaville)": "COG",
  "côte d’ivoire": "CIV",
  "côte d'ivoire": "CIV",
  czechia: "CZE",
  macedonia: "MKD",
  swaziland: "SWZ",
  "gaza strip": "PSE",
  "west bank": "PSE",
  "bahamas, the": "BHS",
  "gambia, the": "GMB",
  "micronesia, federated states of": "FSM",
  "virgin islands, british": "VGB",
  "u.s. virgin islands": "VIR",
  turkey: "TUR",
  "cabo verde": "CPV",
  "são tomé and principe": "STP",
  "western sahara (disputed territory)": "ESH",
};

interface CountryRow {
  cca2: string;
  cca3: string;
  name: { common: string; official: string };
  altSpellings?: string[];
  capital?: string[];
}

async function countryList(): Promise<CountryRow[]> {
  const list = (await cached("countries", () => get("https://cdn.jsdelivr.net/gh/mledoze/countries@master/countries.json"))) as CountryRow[];
  return list.map((c) => ({ cca2: c.cca2, cca3: c.cca3, name: c.name, altSpellings: c.altSpellings, capital: c.capital }));
}

/** A value with the year it describes. */
type YV = { v: number; y: number };

async function worldBank(indicator: string): Promise<Record<string, YV>> {
  return cached(`wb-${indicator}`, async () => {
    const rows = (await get(`https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`))[1] as Array<{
      countryiso3code: string;
      value: number | null;
      date: string;
    }>;
    return Object.fromEntries(rows.filter((r) => r.value !== null && r.countryiso3code).map((r) => [r.countryiso3code, { v: r.value!, y: +r.date }]));
  });
}

/** ICP 2021 price level index (world = 100) for one expenditure heading, by ISO3. */
async function icpPriceLevel(series: string): Promise<Record<string, YV>> {
  return cached(`icp2021-${series}`, async () => {
    const out: Record<string, YV> = {};
    for (let page = 1, pages = 1; page <= pages; page++) {
      const body = (await get(
        `https://api.worldbank.org/v2/sources/90/country/all/series/${series}/classification/PX.WL/time/YR2021?format=json&per_page=1000&page=${page}`
      )) as { pages: number; source: { data: Array<{ variable: Array<{ concept: string; id: string }>; value: number | null }> } };
      pages = body.pages;
      for (const d of body.source.data) {
        const iso = d.variable.find((v) => v.concept === "Country")?.id;
        if (iso && iso.length === 3 && d.value !== null) out[iso] = { v: d.value, y: 2021 };
      }
    }
    return out;
  });
}

/** UN Tourism arrivals via Our World in Data: the latest year on record that isn't 2020 or 2021. */
async function arrivals(): Promise<Record<string, YV>> {
  return cached("owid-arrivals", async () => {
    const csv = (await get("https://ourworldindata.org/grapher/international-tourist-trips.csv?csvType=full", "text")) as string;
    const out: Record<string, YV> = {};
    for (const line of csv.trim().split("\n").slice(1)) {
      // Entity,Code,Year,Arrivals,(region); entity names can hold quoted commas, so read from the right.
      const m = /,([A-Z]{3}),(\d{4}),([\d.]+)(?:,[^,]*)?$/.exec(line);
      if (!m) continue;
      const [, iso, year, value] = m;
      const y = +year!;
      if (y === 2020 || y === 2021 || y < 2015) continue;
      if (!out[iso!] || y > out[iso!]!.y) out[iso!] = { v: +value!, y };
    }
    return out;
  });
}

// ── Eurostat (JSON-stat) ─────────────────────────────────────────────

interface JsonStat {
  id: string[];
  size: number[];
  value: Record<string, number>;
  dimension: Record<string, { category: { index: Record<string, number>; label?: Record<string, string> } }>;
}

async function eurostat(code: string, query: string): Promise<JsonStat> {
  return cached(`es-${code}`, () => get(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${code}?format=JSON&lang=EN${query}`));
}

/** Reader for one dataset: at(geo, {dim: key}) with the other dimensions fixed. */
function reader(d: JsonStat) {
  const strides: number[] = [];
  let s = 1;
  for (let i = d.id.length - 1; i >= 0; i--) {
    strides[i] = s;
    s *= d.size[i]!;
  }
  const idx = (dim: string, key: string) => d.dimension[dim]!.category.index[key];
  return {
    keys: (dim: string) => Object.keys(d.dimension[dim]!.category.index),
    label: (dim: string, key: string) => d.dimension[dim]!.category.label?.[key] ?? key,
    at(sel: Record<string, string>): number | undefined {
      let n = 0;
      for (let i = 0; i < d.id.length; i++) {
        const dim = d.id[i]!;
        const k = d.size[i] === 1 ? 0 : idx(dim, sel[dim] ?? "");
        if (k === undefined) return undefined;
        n += k * strides[i]!;
      }
      return d.value[String(n)];
    },
  };
}

/** Latest non-empty period for a geo, newest first. */
function latest(r: ReturnType<typeof reader>, sel: Record<string, string>): { v: number; period: string } | undefined {
  for (const period of r.keys("time").sort().reverse()) {
    const v = r.at({ ...sel, time: period });
    if (v !== undefined && v !== null) return { v, period };
  }
  return undefined;
}

// ── Duty stations → cities ───────────────────────────────────────────

/** Eurostat's two-letter codes that differ from ISO. */
const ES_ISO2: Record<string, string> = { EL: "GR", UK: "GB" };
/** Station names as Eurostat spells them → the app's English city name. */
const STATION_ALIASES: Record<string, string> = {
  "bruxelles brussel": "Brussels",
  munchen: "Munich",
  "den haag": "The Hague",
  geneve: "Geneva",
  bern: "Bern",
  kobenhavn: "Copenhagen",
  praha: "Prague",
  athina: "Athens",
  lisboa: "Lisbon",
  wien: "Vienna",
  warszawa: "Warsaw",
  bucuresti: "Bucharest",
  roma: "Rome",
  lefkosia: "Nicosia",
  beograd: "Belgrade",
  tirane: "Tirana",
  prishtine: "Pristina",
  pristina: "Pristina",
  kyiv: "Kiev",
  chisinau: "Chisinau",
  "washington d c": "Washington",
  yangon: "Rangoon",
  "tel aviv": "Tel Aviv-Yafo",
  "kuwait city": "Kuwait",
  "ciudad de guatemala": "Guatemala",
  "n djamena": "Ndjamena",
};

interface Station {
  code: string;
  label: string;
  iso3: string;
  cityId?: string;
  capital: boolean;
}

function matchStations(codes: Map<string, string>, countries: CountryRow[], cities: City[], iso3Of: (c: City) => string | undefined): Station[] {
  const by2 = new Map(countries.map((c) => [c.cca2, c]));
  by2.set("XK", { cca2: "XK", cca3: "UNK", name: { common: "Kosovo", official: "Kosovo" }, capital: ["Pristina"] });
  const out: Station[] = [];
  for (const [code, label] of codes) {
    const cc = code.slice(0, 2);
    const country = by2.get(ES_ISO2[cc] ?? cc);
    if (!country) {
      console.warn(`station ${code} (${label}): unknown country`);
      continue;
    }
    const capital = code.endsWith("_CAP");
    const inCountry = cities.filter((c) => iso3Of(c) === country.cca3);
    const wanted = new Set<string>();
    const f = fold(label);
    wanted.add(f);
    if (STATION_ALIASES[f]) wanted.add(fold(STATION_ALIASES[f]!));
    // "Bruxelles/Brussel", "Bern (Berne)": each part is a candidate too.
    for (const part of label.replace(/\(.*?\)/g, "").split("/")) {
      const p = fold(part);
      wanted.add(p);
      if (STATION_ALIASES[p]) wanted.add(fold(STATION_ALIASES[p]!));
    }
    let city = inCountry.filter((c) => wanted.has(fold(c.name))).sort((a, b) => b.population - a.population)[0];
    if (!city && capital) {
      const caps = new Set((country.capital ?? []).map(fold));
      city = inCountry.filter((c) => c.capital || caps.has(fold(c.name))).sort((a, b) => b.population - a.population)[0];
    }
    if (!city) console.warn(`station ${code} (${label}): no matching city`);
    out.push({ code, label, iso3: country.cca3, cityId: city?.id, capital });
  }
  return out;
}

// ── NUTS 2 regions ───────────────────────────────────────────────────

interface NutsRegion {
  id: string;
  name: string;
  cc: string;
  bbox: [number, number, number, number];
  polygons: Ring[][];
}

async function nutsRegions(): Promise<NutsRegion[]> {
  const gj = await cached("nuts2-2024", () => get("https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_10M_2024_4326_LEVL_2.geojson"));
  return (gj.features as any[]).map((f) => {
    const polygons: Ring[][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    for (const p of polygons)
      for (const [x, y] of p[0]!) {
        w = Math.min(w, x);
        e = Math.max(e, x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
    return { id: f.properties.NUTS_ID, name: f.properties.NAME_LATN, cc: f.properties.CNTR_CODE, bbox: [w, s, e, n], polygons };
  });
}

/** The NUTS 2 region a city sits in. Coastal cities just off the simplified outline are nudged up to ~11 km. */
function regionOf(c: City, iso2: string | undefined, regions: NutsRegion[]): NutsRegion | undefined {
  if (!iso2) return undefined;
  const cc = Object.entries(ES_ISO2).find(([, v]) => v === iso2)?.[0] ?? iso2;
  const own = regions.filter((r) => r.cc === cc);
  if (!own.length) return undefined;
  const hit = (lng: number, lat: number) =>
    own.find((r) => lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3] && inPolygons(lng, lat, r.polygons));
  const direct = hit(c.lng, c.lat);
  if (direct) return direct;
  for (const step of [0.03, 0.06, 0.1])
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const r = hit(c.lng + dx * step, c.lat + dy * step);
      if (r) return r;
    }
  return undefined;
}

// ── Internet: Ookla Open Data tiles ──────────────────────────────────

async function download(url: string, path: string): Promise<void> {
  if (existsSync(path)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(`${path}.part`));
  execFileSync("mv", [`${path}.part`, path]);
}

type Speed = NonNullable<ReturnType<typeof finishSpeed>>;

async function ooklaSpeeds(type: "fixed" | "mobile", cities: City[]): Promise<Record<string, Speed>> {
  const [year, quarter] = OOKLA;
  const tag = `${year}q${quarter}-${type}`;
  return cached(`ookla-${tag}-cities`, async () => {
    const month = String(quarter * 3 - 2).padStart(2, "0");
    const path = join(CACHE, `ookla-${tag}.parquet`);
    await download(
      `https://ookla-open-data.s3.amazonaws.com/parquet/performance/type=${type}/year=${year}/quarter=${quarter}/${year}-${month}-01_performance_${type}_tiles.parquet`,
      path
    );
    // Cities bucketed in half-degree cells, so each tile only meets the cities near it.
    const CELL = 0.5;
    const grid = new Map<string, number[]>();
    const cell = (lat: number, lng: number) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;
    cities.forEach((c, i) => {
      const k = cell(c.lat, c.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(i);
    });
    const radius = cities.map((c) => cityRadiusKm(c.population));
    const acc: SpeedAcc[] = cities.map(emptySpeedAcc);

    const file = await asyncBufferFromFile(path);
    const meta = await parquetMetadataAsync(file);
    let start = 0;
    for (const [g, group] of meta.row_groups.entries()) {
      const end = start + Number(group.num_rows);
      await parquetRead({
        file,
        metadata: meta,
        columns: ["quadkey", "avg_d_kbps", "avg_u_kbps", "avg_lat_ms", "tests"],
        rowStart: start,
        rowEnd: end,
        rowFormat: "object",
        onComplete: (rows: any[]) => {
          for (const row of rows) {
            const [lng, lat] = quadkeyCentre(String(row.quadkey));
            const cy = Math.floor(lat / CELL);
            const cx = Math.floor(lng / CELL);
            const reach = Math.abs(lat) > 60 ? 2 : 1;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -reach; dx <= reach; dx++) {
                const near = grid.get(`${cy + dy}:${cx + dx}`);
                if (!near) continue;
                for (const i of near) {
                  const c = cities[i]!;
                  if (km(c.lat, c.lng, lat, lng) <= radius[i]!)
                    addTile(acc[i]!, {
                      tests: Number(row.tests),
                      downKbps: Number(row.avg_d_kbps),
                      upKbps: Number(row.avg_u_kbps),
                      latencyMs: Number(row.avg_lat_ms),
                    });
                }
              }
          }
        },
      });
      start = end;
      process.stdout.write(`\rookla ${type} ${g + 1}/${meta.row_groups.length} row groups`);
    }
    process.stdout.write("\n");
    const out: Record<string, Speed> = {};
    cities.forEach((c, i) => {
      const s = finishSpeed(acc[i]!);
      if (s) out[c.id] = s;
    });
    return out;
  });
}

// ── Wikipedia page views by month ────────────────────────────────────

interface Geo {
  id: string;
  names: Set<string>;
  lat: number;
  lng: number;
  pop: number;
}

/** City id → GeoNames id (same rule as scripts/build-native-names.ts: same name within 30 km, else the largest place within 8 km). */
async function matchGeonames(cities: City[]): Promise<Record<string, string>> {
  return cached("geonames-match", async () => {
    const zip = join(CACHE, "cities15000.zip");
    if (!existsSync(zip)) {
      const res = await fetch("https://download.geonames.org/export/dump/cities15000.zip", { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`GeoNames download failed: ${res.status}`);
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
    execFileSync("unzip", ["-o", "-q", zip, "-d", CACHE]);
    const grid = new Map<string, Geo[]>();
    const key = (lat: number, lng: number) => `${Math.floor(lat)}:${Math.floor(lng)}`;
    for (const line of readFileSync(join(CACHE, "cities15000.txt"), "utf8").trim().split("\n")) {
      const f = line.split("\t");
      const g: Geo = { id: f[0]!, names: new Set([f[1]!, f[2]!, ...f[3]!.split(",")].filter(Boolean).map(fold)), lat: +f[4]!, lng: +f[5]!, pop: +f[14]! };
      const k = key(g.lat, g.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(g);
    }
    const out: Record<string, string> = {};
    for (const c of cities) {
      const near: [Geo, number][] = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (const g of grid.get(key(c.lat + dy, c.lng + dx)) ?? []) {
            const d = km(c.lat, c.lng, g.lat, g.lng);
            if (d < 30) near.push([g, d]);
          }
      const name = fold(c.name);
      const byName = near.filter(([g]) => g.names.has(name)).sort((a, b) => b[0].pop - a[0].pop || a[1] - b[1])[0];
      const close = near.filter(([, d]) => d < 8).sort((a, b) => b[0].pop - a[0].pop)[0];
      const hit = byName ?? close;
      if (hit) out[c.id] = hit[0].id;
    }
    return out;
  });
}

async function sparql(query: string): Promise<Array<Record<string, { value: string }>>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "user-agent": UA, accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return ((await res.json()) as { results: { bindings: [] } }).results.bindings;
    await sleep(3000 * 2 ** attempt);
  }
  throw new Error("Wikidata query kept failing");
}

/** GeoNames id → English Wikipedia article title, through Wikidata (P1566). */
async function wikipediaTitles(geonameIds: string[]): Promise<Record<string, string>> {
  return cached("enwiki-titles", async () => {
    const out: Record<string, string> = {};
    const BATCH = 250;
    for (let i = 0; i < geonameIds.length; i += BATCH) {
      const values = geonameIds.slice(i, i + BATCH).map((id) => `"${id}"`).join(" ");
      const rows = await sparql(`
        SELECT ?gn ?title WHERE {
          VALUES ?gn { ${values} }
          ?item wdt:P1566 ?gn .
          ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
        }`);
      for (const r of rows) if (!out[r.gn!.value]) out[r.gn!.value] = r.title!.value;
      process.stdout.write(`\rwikidata ${Math.min(i + BATCH, geonameIds.length)}/${geonameIds.length}`);
      await sleep(500);
    }
    process.stdout.write("\n");
    return out;
  });
}

/** Monthly human page views of one article, as {"2019": [12 numbers]}; null if the article has none. */
async function pageViews(title: string): Promise<Record<string, (number | null)[]> | null> {
  const first = Math.min(...VIEW_YEARS);
  const last = Math.max(...VIEW_YEARS);
  const body = await get(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/${first}010100/${last}123100`
  );
  if (!body?.items) return null;
  const out: Record<string, (number | null)[]> = {};
  for (const it of body.items as Array<{ timestamp: string; views: number }>) {
    const y = it.timestamp.slice(0, 4);
    const m = +it.timestamp.slice(4, 6);
    if (!VIEW_YEARS.includes(+y)) continue;
    (out[y] ??= Array(12).fill(null))[m - 1] = it.views;
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length ? (s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2) : NaN;
};

async function main() {
  loadCities();
  const cities = getCities();
  const countries = await countryList();
  const nameToIso3 = new Map<string, string>();
  for (const c of countries) for (const n of [c.name.common, c.name.official, ...(c.altSpellings ?? [])]) nameToIso3.set(n.toLowerCase(), c.cca3);
  const iso3Of = (c: City) => COUNTRY_ALIASES[c.country.toLowerCase()] ?? nameToIso3.get(c.country.toLowerCase());
  const iso2Of = new Map(countries.map((c) => [c.cca3, c.cca2]));
  const iso3From2 = new Map(countries.map((c) => [c.cca2, c.cca3]));
  iso3From2.set("XK", "UNK");
  const unmatchedCountries = [...new Set(cities.filter((c) => !iso3Of(c)).map((c) => c.country))];
  if (unmatchedCountries.length) console.warn("no ISO code for:", unmatchedCountries.join(", "));

  // ── Country indicators ──
  const [ppp, fx, uhc, physicians, beds, stability, population, housing, arr] = await Promise.all([
    worldBank("PA.NUS.PRVT.PP"),
    worldBank("PA.NUS.FCRF"),
    worldBank("SH_UHC_SCI"),
    worldBank("SH.MED.PHYS.ZS"),
    worldBank("SH.MED.BEDS.ZS"),
    worldBank("GOV_WGI_PV_EST"),
    worldBank("SP.POP.TOTL"),
    icpPriceLevel("9060000"),
    arrivals(),
  ]);
  // Price level of household consumption: PPP conversion factor over the market exchange rate
  // (same year for both), then expressed against Belgium = 100 to line up with Eurostat's Brussels = 100.
  const level = (iso: string): YV | undefined => {
    const p = ppp[iso];
    const x = fx[iso];
    if (!p || !x || p.y !== x.y || !(x.v > 0)) return undefined;
    return { v: p.v / x.v, y: p.y };
  };
  const be = level("BEL");
  if (!be) throw new Error("no price level for Belgium: cannot anchor");

  // ── Eurostat ──
  const ext = reader(await eurostat("prc_colc_ext", ""));
  const tot = reader(await eurostat("prc_colc_tot", "&coicop=TOTAL"));
  const rents = reader(await eurostat("prc_colc_rents", "&building=FLAT1&currency=EUR"));
  const anchorSet = reader(await eurostat("nama_10_pc", "&geo=BE&na_item=P31_S14&unit=CP_EUR_HAB"));
  const nights = reader(await eurostat("tour_occ_nin2m", `&c_resid=TOTAL&nace_r2=I551-I553&unit=NR&sinceTimePeriod=${Math.min(...NIGHT_YEARS)}`));
  const regionPop = reader(await eurostat("demo_r_d2jan", "&sex=T&age=TOTAL&unit=NR&sinceTimePeriod=2022"));

  const anchor = latest(anchorSet, { geo: "BE" });
  if (!anchor) throw new Error("no Belgian consumption figure: cannot anchor");

  const stationCodes = new Map<string, string>();
  for (const r of [ext, tot, rents]) for (const k of r.keys("geo")) stationCodes.set(k, r.label("geo", k));
  const stations = matchStations(stationCodes, countries, cities, iso3Of);
  const stationOfCity = new Map(stations.filter((s) => s.cityId).map((s) => [s.cityId!, s]));

  // ── Regions ──
  const regions = await nutsRegions();
  const monthKeys = Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
  const nightsOf = (geo: string) => {
    if (!nights.keys("geo").includes(geo)) return undefined;
    const years = NIGHT_YEARS.map((y) => monthKeys.map((m) => nights.at({ geo, month: m, time: String(y) }) ?? null));
    const index = seasonalIndex(years);
    if (!index) return undefined;
    const used = NIGHT_YEARS.filter((_, i) => years[i]!.every((v) => v !== null && v > 0));
    const total = [...NIGHT_YEARS].reverse().map((y) => ({ y, v: nights.at({ geo, month: "TOTAL", time: String(y) }) })).find((t) => t.v);
    return { index, years: used, total: total ? { v: total.v!, y: total.y } : undefined };
  };

  // ── Internet ──
  const fixed = await ooklaSpeeds("fixed", cities);
  const mobile = await ooklaSpeeds("mobile", cities);

  // ── Wikipedia page views ──
  const gn = await matchGeonames(cities);
  const titles = await wikipediaTitles([...new Set(Object.values(gn))]);
  // Wikimedia rate-limits to a few requests a second, so a full run takes hours. PAGEVIEW_MAX caps it to the
  // most populous N cities (cached articles are always kept; the rest are read on a later run).
  const pvMax = Number(process.env.PAGEVIEW_MAX ?? Infinity);
  const withTitle = cities
    .filter((c) => gn[c.id] && titles[gn[c.id]!])
    .sort((a, b) => b.population - a.population)
    .slice(0, pvMax);
  const views = await pooled("pageviews", withTitle, (c) => c.id, (c) => pageViews(titles[gn[c.id]!]!), 3);

  // ── Assemble ──
  const countryOut: Record<string, any> = {};
  const usedIso = new Set(cities.map(iso3Of).filter(Boolean) as string[]);
  for (const iso of [...usedIso].sort()) {
    const row: Record<string, any> = {};
    const lv = level(iso);
    if (lv) row.priceLevel = { v: r1((lv.v / be.v) * 100), y: lv.y };
    if (housing[iso] && housing.BEL) row.housingLevel = { v: r1((housing[iso]!.v / housing.BEL.v) * 100), y: 2021 };
    if (uhc[iso]) row.uhc = { v: Math.round(uhc[iso]!.v), y: uhc[iso]!.y };
    if (physicians[iso]) row.physicians = { v: r2(physicians[iso]!.v), y: physicians[iso]!.y };
    if (beds[iso]) row.beds = { v: r2(beds[iso]!.v), y: beds[iso]!.y };
    if (stability[iso]) row.stability = { v: r2(stability[iso]!.v), y: stability[iso]!.y };
    if (population[iso]) row.population = { v: Math.round(population[iso]!.v), y: population[iso]!.y };
    if (arr[iso]) row.arrivals = { v: Math.round(arr[iso]!.v), y: arr[iso]!.y };
    const cc2 = iso2Of.get(iso);
    const esCode = cc2 ? (Object.entries(ES_ISO2).find(([, v]) => v === cc2)?.[0] ?? cc2) : undefined;
    const n = esCode ? nightsOf(esCode) : undefined;
    if (n) row.nights = n;
    // The capital's (or main duty station's) measured rent, shown for other cities as a reference only.
    const ref = stations
      .filter((s) => s.iso3 === iso && s.cityId)
      .map((s) => ({ s, rent: latest(rents, { geo: s.code }) }))
      .filter((x) => x.rent)
      .sort((a, b) => Number(b.s.capital) - Number(a.s.capital))[0];
    if (ref) row.rentRef = { cityId: ref.s.cityId, v: ref.rent!.v, y: +ref.rent!.period };
    countryOut[iso] = row;
  }

  const regionOut: Record<string, any> = {};
  const cityOut: Record<string, any> = {};
  const viewChecks: number[] = [];
  for (const c of cities) {
    const iso = iso3Of(c);
    const row: Record<string, any> = {};
    if (iso) row.c = iso;
    const region = iso ? regionOf(c, iso2Of.get(iso), regions) : undefined;
    if (region) {
      if (!(region.id in regionOut)) {
        const n = nightsOf(region.id);
        const pop = latest(regionPop, { geo: region.id });
        regionOut[region.id] = n ? { name: region.name, c: iso, nights: n, ...(pop ? { population: { v: pop.v, y: +pop.period } } : {}) } : null;
      }
      if (regionOut[region.id]) row.r = region.id;
    }
    const st = stationOfCity.get(c.id);
    if (st) {
      const cc = latest(tot, { geo: st.code }) ?? latest(ext, { geo: st.code });
      if (cc) row.cost = { v: r1(cc.v), y: +cc.period.slice(0, 4), st: st.label };
      const rent = latest(rents, { geo: st.code });
      if (rent) row.rent = { v: rent.v, y: +rent.period };
    }
    const net: Record<string, number[]> = {};
    for (const [k, src] of [["f", fixed], ["m", mobile]] as const) {
      const s = src[c.id];
      if (s) net[k] = [s.down, s.up, s.latency, s.tests, s.tiles];
    }
    if (Object.keys(net).length) row.net = net;
    const v = views[c.id];
    if (v) {
      const years = VIEW_YEARS.map((y) => v[String(y)] ?? []);
      const index = seasonalIndex(years, 3);
      const all = years.flat().filter((x): x is number => typeof x === "number");
      const monthly = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : 0;
      if (index && monthly >= MIN_MONTHLY_VIEWS) {
        row.views = { i: index, n: monthly };
        // Check against measured nights where a city has both.
        const measured = row.r ? regionOut[row.r]?.nights?.index : undefined;
        if (measured) {
          const r = correlation(index, measured);
          if (r !== null) viewChecks.push(r);
        }
      }
    }
    cityOut[c.id] = row;
  }
  for (const k of Object.keys(regionOut)) if (!regionOut[k]) delete regionOut[k];

  // How well would the ICP housing price level predict the rents Eurostat measured? Reported, not used.
  const rentErrors: number[] = [];
  const brussels = latest(rents, { geo: "BE_CAP" });
  for (const s of stations) {
    const rent = latest(rents, { geo: s.code });
    const h = countryOut[s.iso3]?.housingLevel?.v;
    if (!rent || !h || !brussels || s.code === "BE_CAP") continue;
    rentErrors.push(Math.abs((brussels.v * h) / 100 / rent.v - 1));
  }

  const builtAt = new Date().toISOString().slice(0, 10);
  const count = (pick: (r: any) => unknown) => Object.values(cityOut).filter((r) => pick(r) !== undefined && pick(r) !== null).length;
  const cOf = (r: any) => (r.c ? countryOut[r.c] : undefined);
  const coverage = {
    cities: cities.length,
    country: count((r) => r.c),
    costCity: count((r) => r.cost),
    costCountry: count((r) => cOf(r)?.priceLevel),
    rentCity: count((r) => r.rent),
    rentCapitalReference: count((r) => (r.rent ? undefined : cOf(r)?.rentRef)),
    internetFixed: count((r) => r.net?.f),
    internetMobile: count((r) => r.net?.m),
    internetAny: count((r) => r.net),
    healthUhc: count((r) => cOf(r)?.uhc),
    physicians: count((r) => cOf(r)?.physicians),
    beds: count((r) => cOf(r)?.beds),
    stability: count((r) => cOf(r)?.stability),
    arrivals: count((r) => (cOf(r)?.arrivals && cOf(r)?.population ? 1 : undefined)),
    monthsRegion: count((r) => r.r),
    monthsCountry: count((r) => cOf(r)?.nights),
    monthsPageViews: count((r) => r.views),
  };
  const checks = {
    pageViewsVsNights: {
      what: "Correlation across the 12 months between a city's Wikipedia page-view pattern and its NUTS 2 region's measured nights",
      cities: viewChecks.length,
      median: viewChecks.length ? r2(median(viewChecks)) : null,
      shareAbove05: viewChecks.length ? r2(viewChecks.filter((r) => r >= 0.5).length / viewChecks.length) : null,
      shareBelow0: viewChecks.length ? r2(viewChecks.filter((r) => r < 0).length / viewChecks.length) : null,
    },
    rentFromHousingLevel: {
      what: "Median error of Brussels rent x ICP housing price level against the rent Eurostat measured in the same country's station",
      stations: rentErrors.length,
      medianAbsError: rentErrors.length ? r2(median(rentErrors)) : null,
    },
  };

  const [oy, oq] = OOKLA;
  const sources = {
    costCity: {
      name: "Eurostat correction coefficients for duty stations (prc_colc_tot, prc_colc_ext), Brussels = 100",
      url: "https://ec.europa.eu/eurostat/databrowser/view/prc_colc_ext",
      licence: "Eurostat reuse policy (CC BY 4.0)",
    },
    costCountry: {
      name: "World Bank: PPP conversion factor for household consumption (PA.NUS.PRVT.PP) over the official exchange rate (PA.NUS.FCRF), Belgium = 100",
      url: "https://data.worldbank.org/indicator/PA.NUS.PRVT.PP",
      licence: "CC BY 4.0",
    },
    costAnchor: {
      name: "Eurostat national accounts: household final consumption per person, Belgium (nama_10_pc, P31_S14)",
      url: "https://ec.europa.eu/eurostat/databrowser/view/nama_10_pc",
      licence: "Eurostat reuse policy (CC BY 4.0)",
    },
    rent: {
      name: "Eurostat: average rent per month in cities, 1-bedroom flat (prc_colc_rents)",
      url: "https://ec.europa.eu/eurostat/databrowser/view/prc_colc_rents",
      licence: "Eurostat reuse policy (CC BY 4.0)",
    },
    housingLevel: {
      name: "World Bank ICP 2021: price level of actual housing, water, electricity, gas and other fuels, Belgium = 100",
      url: "https://www.worldbank.org/en/programs/icp",
      licence: "CC BY 4.0",
    },
    internet: {
      name: `Speedtest by Ookla Global Fixed and Mobile Network Performance Maps, ${oy} Q${oq}`,
      url: "https://registry.opendata.aws/speedtest-global-performance/",
      licence: "CC BY-NC-SA 4.0 (non-commercial)",
    },
    uhc: { name: "WHO UHC service coverage index, via World Bank (SH_UHC_SCI)", url: "https://data.worldbank.org/indicator/SH.UHC.SRVS.CV.XD", licence: "CC BY 4.0" },
    physicians: { name: "Physicians per 1,000 people, WHO via World Bank (SH.MED.PHYS.ZS)", url: "https://data.worldbank.org/indicator/SH.MED.PHYS.ZS", licence: "CC BY 4.0" },
    beds: { name: "Hospital beds per 1,000 people, WHO via World Bank (SH.MED.BEDS.ZS)", url: "https://data.worldbank.org/indicator/SH.MED.BEDS.ZS", licence: "CC BY 4.0" },
    stability: {
      name: "Worldwide Governance Indicators: political stability and absence of violence, estimate (GOV_WGI_PV_EST)",
      url: "https://www.worldbank.org/en/publication/worldwide-governance-indicators",
      licence: "CC BY 4.0",
    },
    arrivals: {
      name: "UN Tourism international tourist arrivals, processed by Our World in Data; population from World Bank (SP.POP.TOTL)",
      url: "https://ourworldindata.org/grapher/international-tourist-trips",
      licence: "CC BY 4.0",
    },
    nights: {
      name: `Eurostat: nights spent at tourist accommodation by month and NUTS 2 region (tour_occ_nin2m), ${NIGHT_YEARS[0]}-${NIGHT_YEARS.at(-1)}`,
      url: "https://ec.europa.eu/eurostat/databrowser/view/tour_occ_nin2m",
      licence: "Eurostat reuse policy (CC BY 4.0); region outlines © EuroGeographics (GISCO NUTS 2024)",
    },
    pageViews: {
      name: `English Wikipedia page views by month (Wikimedia REST API), ${VIEW_YEARS.join(", ")}; articles found through GeoNames and Wikidata`,
      url: "https://wikimedia.org/api/rest_v1/",
      licence: "CC0 (page views, Wikidata); GeoNames CC BY 4.0",
    },
  };

  writeFileSync(
    join(ROOT, "data/country-data.json"),
    JSON.stringify({
      version: 1,
      builtAt,
      sources,
      anchor: { monthlyEur: Math.round(anchor.v / 12), yearlyEur: anchor.v, y: +anchor.period, place: "Belgium" },
      checks,
      countries: countryOut,
      regions: regionOut,
    }) + "\n"
  );
  writeFileSync(join(ROOT, "data/city-data.json"), JSON.stringify({ version: 1, builtAt, coverage, cities: cityOut }) + "\n");
  console.log("coverage", coverage);
  console.log("checks", JSON.stringify(checks, null, 1));
  console.log(`stations matched ${stations.filter((s) => s.cityId).length}/${stations.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
