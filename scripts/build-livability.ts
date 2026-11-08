// Builds data/livability.json: how good each city is to live in, and how beautiful it is.
//
//   npx tsx scripts/build-livability.ts            (downloads are cached in data/cache/livability)
//
// Quality of life (0-100), a country baseline plus what's measured locally:
//   hdi        UNDP Human Development Index (life expectancy, schooling, income)   country
//   happiness  World Happiness Report life evaluation, via Our World in Data        country
//   safety     intentional homicides per 100k, World Bank                           country
//   air        fine particles (PM2.5): Open-Meteo/CAMS at the city for major cities,
//              else the World Bank country mean                                     city or country
// Beauty (0-100): the stronger of two axes counts 65%, the weaker 35%:
//   setting    terrain relief within 15 km (AWS Terrain Tiles) and water: sea within 15 km
//              (the same tiles' bathymetry) or a lake within 10 km (Natural Earth), combined
//              as either/or (mountains alone or sea alone make a setting; both more so)
//   character  UNESCO World Heritage sites nearby (Wikidata), density of geotagged photos at
//              the centre (Wikimedia Commons) and notable places within 5 km (English Wikipedia)
//
// Every part is kept, so the app can show why a city scores what it does. Missing parts are
// left out and the rest reweighted; `local` says how much of the quality score is measured at
// the city rather than inherited from its country.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";
import { loadCities, getCities } from "../server/lib/cities.ts";
import type { City } from "../src/types.ts";

const UA = "meridian-livability/1.0 (https://github.com/kygura/meridian)";
const ROOT = process.cwd();
const CACHE = join(ROOT, "data/cache/livability");
mkdirSync(CACHE, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round = (x: number) => Math.round(x);

async function get(url: string, kind: "json" | "text" | "buffer" = "json", tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (res.ok) return kind === "json" ? res.json() : kind === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * 2 ** i);
        continue;
      }
      throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Cached JSON step: run `fn` once, keep its result in data/cache/livability/<name>.json. */
async function cached<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const p = join(CACHE, `${name}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as T;
  const v = await fn();
  writeFileSync(p, JSON.stringify(v));
  return v;
}

/** Run `fn` over items with limited concurrency, persisting results as it goes. */
async function pooled<T, R>(name: string, items: T[], key: (t: T) => string, fn: (t: T) => Promise<R>, conc = 4) {
  const p = join(CACHE, `${name}.json`);
  const done: Record<string, R> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const todo = items.filter((t) => !(key(t) in done));
  let i = 0;
  let n = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
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

// ── Countries → ISO3 ─────────────────────────────────────────────────

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

async function iso3Map(): Promise<(country: string) => string | undefined> {
  const list = await cached("countries", () => get("https://cdn.jsdelivr.net/gh/mledoze/countries@master/countries.json"));
  const m = new Map<string, string>();
  for (const c of list as Array<{ cca3: string; name: { common: string; official: string }; altSpellings?: string[] }>) {
    for (const n of [c.name.common, c.name.official, ...(c.altSpellings ?? [])]) m.set(n.toLowerCase(), c.cca3);
  }
  return (country) => COUNTRY_ALIASES[country.toLowerCase()] ?? m.get(country.toLowerCase());
}

// ── Country indicators ───────────────────────────────────────────────

async function worldBank(indicator: string): Promise<Record<string, number>> {
  return cached(`wb-${indicator}`, async () => {
    const rows = (await get(`https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&mrnev=1`))[1] as Array<{
      countryiso3code: string;
      value: number | null;
    }>;
    return Object.fromEntries(rows.filter((r) => r.value !== null && r.countryiso3code).map((r) => [r.countryiso3code, r.value!]));
  });
}

async function hdi(): Promise<Record<string, number>> {
  return cached("hdi", async () => {
    const csv = (await get("https://hdr.undp.org/sites/default/files/2023-24_HDR/HDR23-24_Composite_indices_complete_time_series.csv", "text")) as string;
    const [head, ...rows] = csv.trim().split(/\r?\n/);
    const cols = head.split(",");
    const iso = cols.indexOf("iso3");
    const years = cols.map((c, i) => [c, i] as const).filter(([c]) => /^hdi_\d{4}$/.test(c)).sort().reverse();
    const out: Record<string, number> = {};
    for (const line of rows) {
      const f = line.split(",");
      for (const [, i] of years) {
        const v = parseFloat(f[i]);
        if (Number.isFinite(v)) {
          out[f[iso]] = v;
          break;
        }
      }
    }
    return out;
  });
}

async function happiness(): Promise<Record<string, number>> {
  return cached("happiness", async () => {
    const csv = (await get("https://ourworldindata.org/grapher/happiness-cantril-ladder.csv?v=1&csvType=full&useColumnShortNames=true", "text")) as string;
    const [head, ...rows] = csv.trim().split(/\r?\n/);
    const cols = head.split(",");
    const code = cols.indexOf("code");
    const year = cols.indexOf("year");
    const val = cols.length - 1;
    const best: Record<string, [number, number]> = {};
    for (const line of rows) {
      const f = line.split(",");
      const c = f[code];
      if (!c || c.length !== 3) continue;
      const y = +f[year];
      const v = parseFloat(f[val]);
      if (Number.isFinite(v) && (!best[c] || y > best[c][0])) best[c] = [y, v];
    }
    return Object.fromEntries(Object.entries(best).map(([c, [, v]]) => [c, v]));
  });
}

// ── City air (Open-Meteo / CAMS) ─────────────────────────────────────

/** Mean PM2.5 over two sample windows (mid-January and mid-July 2024), µg/m³. */
async function cityAir(cities: City[]): Promise<Record<string, number>> {
  const BATCH = 50;
  const batches: City[][] = [];
  for (let i = 0; i < cities.length; i += BATCH) batches.push(cities.slice(i, i + BATCH));
  const result: Record<string, number> = {};
  const done = await pooled(
    "air",
    batches,
    (b) => b[0].id,
    async (b) => {
      const sums = new Map<string, number[]>();
      for (const [s, e] of [["2024-01-14", "2024-01-16"], ["2024-07-14", "2024-07-16"]]) {
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${b.map((c) => c.lat.toFixed(3)).join(",")}&longitude=${b
          .map((c) => c.lng.toFixed(3))
          .join(",")}&hourly=pm2_5&start_date=${s}&end_date=${e}`;
        const res = await get(url);
        const arr = Array.isArray(res) ? res : [res];
        arr.forEach((r: { hourly?: { pm2_5?: (number | null)[] } }, k: number) => {
          const v = (r.hourly?.pm2_5 ?? []).filter((x): x is number => typeof x === "number");
          if (v.length) (sums.get(b[k].id) ?? sums.set(b[k].id, []).get(b[k].id)!).push(v.reduce((a, x) => a + x, 0) / v.length);
        });
      }
      return Object.fromEntries([...sums].map(([id, v]) => [id, v.reduce((a, x) => a + x, 0) / v.length]));
    },
    2
  );
  for (const part of Object.values(done)) Object.assign(result, part);
  return result;
}

// ── Terrain (AWS Terrain Tiles, terrarium encoding) ──────────────────

const Z = 9;
const tileCache = new Map<string, Float32Array | null>();

async function tile(x: number, y: number): Promise<Float32Array | null> {
  const k = `${x}/${y}`;
  if (tileCache.has(k)) return tileCache.get(k)!;
  const dir = join(CACHE, "tiles");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${Z}-${x}-${y}.png`);
  let buf: Buffer | null = existsSync(p) ? readFileSync(p) : null;
  if (!buf) {
    buf = await get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, "buffer");
    if (buf) writeFileSync(p, buf);
  }
  if (!buf) {
    tileCache.set(k, null);
    return null;
  }
  const png = PNG.sync.read(buf);
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
  }
  if (tileCache.size > 400) tileCache.clear();
  tileCache.set(k, out);
  return out;
}

async function elevationAt(lat: number, lng: number): Promise<number | null> {
  const n = 2 ** Z;
  const xf = ((lng + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const t = await tile(Math.floor(xf), Math.floor(yf));
  if (!t) return null;
  const px = Math.min(255, Math.floor((xf % 1) * 256));
  const py = Math.min(255, Math.floor((yf % 1) * 256));
  return t[py * 256 + px];
}

/** Relief (p95 - p5 elevation) and sea share within 15 km, from a polar sample. */
async function terrain(c: City): Promise<{ relief: number; sea: number }> {
  const samples: number[] = [];
  for (const r of [0, 3, 6, 9, 12, 15])
    for (let a = 0; a < 360; a += r === 0 ? 360 : 20) {
      const dLat = (r / 111.2) * Math.cos((a * Math.PI) / 180);
      const dLng = (r / (111.2 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin((a * Math.PI) / 180);
      const e = await elevationAt(c.lat + dLat, c.lng + dLng);
      if (e !== null) samples.push(e);
    }
  // Relief is measured on dry land only: shallow sea (0 to -20 m) would read as "low ground" and
  // inflate the relief of every flat coastal city. Sea is anything 20 m or more below sea level.
  const land = samples.filter((e) => e > 0).sort((a, b) => a - b);
  const q = (p: number) => land[Math.min(land.length - 1, Math.floor(p * land.length))] ?? 0;
  return { relief: land.length ? Math.max(0, q(0.95) - q(0.05)) : 0, sea: samples.filter((e) => e <= -20).length / Math.max(1, samples.length) };
}

// ── Lakes (Natural Earth) ────────────────────────────────────────────

type Ring = [number, number][];
async function lakeIndex(): Promise<{ bbox: [number, number, number, number]; rings: Ring[] }[]> {
  const gj = await cached("lakes", () =>
    get("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson")
  );
  return (gj as { features: { geometry: { type: string; coordinates: any } }[] }).features.flatMap((f) => {
    const polys: Ring[][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.map((rings) => {
      const xs = rings[0].map((p) => p[0]);
      const ys = rings[0].map((p) => p[1]);
      return { bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number], rings };
    });
  });
}

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Nearest lake distance band: 0 = within 3 km, 1 = within 10 km, null = none. */
function nearLake(c: City, lakes: Awaited<ReturnType<typeof lakeIndex>>): number | null {
  let best: number | null = null;
  for (const [r, band] of [[0, 0], [3, 0], [6, 1], [10, 1]] as const)
    for (let a = 0; a < 360; a += r === 0 ? 360 : 30) {
      const y = c.lat + (r / 111.2) * Math.cos((a * Math.PI) / 180);
      const x = c.lng + (r / (111.2 * Math.cos((c.lat * Math.PI) / 180))) * Math.sin((a * Math.PI) / 180);
      for (const l of lakes) {
        if (x < l.bbox[0] || x > l.bbox[2] || y < l.bbox[1] || y > l.bbox[3]) continue;
        if (inRing(x, y, l.rings[0]) && !l.rings.slice(1).some((h) => inRing(x, y, h))) {
          best = best === null ? band : Math.min(best, band);
          if (best === 0) return 0;
        }
      }
    }
  return best;
}

// ── Heritage, photos, notable places ─────────────────────────────────

async function heritageSites(): Promise<[number, number][]> {
  return cached("unesco", async () => {
    const q = `SELECT ?coord WHERE { ?s wdt:P1435 wd:Q9259 ; wdt:P625 ?coord . }`;
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "user-agent": UA, accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: q }),
    });
    const rows = ((await res.json()) as { results: { bindings: { coord: { value: string } }[] } }).results.bindings;
    return rows
      .map((r) => /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(r.coord.value))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [+m[2], +m[1]] as [number, number]);
  });
}

/**
 * Geotagged Commons files near the centre, as a density that doesn't cap out: the API returns at
 * most 500, so a city that fills 2 km is counted again within 500 m and scaled up by area (×16).
 */
async function photoDensity(c: City): Promise<number> {
  const wide = await geoCount("commons.wikimedia.org", c, 2000, 6);
  if (wide < 500) return wide;
  return (await geoCount("commons.wikimedia.org", c, 500, 6)) * 16;
}

async function geoCount(host: string, c: City, radius: number, ns: number): Promise<number> {
  const url = `https://${host}/w/api.php?action=query&list=geosearch&gscoord=${c.lat}%7C${c.lng}&gsradius=${radius}&gslimit=500&gsnamespace=${ns}&format=json`;
  const r = await get(url);
  return (r?.query?.geosearch ?? []).length;
}

// ── Scores ───────────────────────────────────────────────────────────

/** Weighted mean of the parts present; null when none are. */
function blend(parts: Record<string, number | null | undefined>, weights: Record<string, number>): number | null {
  let s = 0;
  let w = 0;
  for (const [k, v] of Object.entries(parts)) if (typeof v === "number") (s += v * weights[k]), (w += weights[k]);
  return w ? round(s / w) : null;
}

const scoreHdi = (v?: number) => (v === undefined ? null : round(clamp((v - 0.4) / 0.55) * 100));
const scoreHappiness = (v?: number) => (v === undefined ? null : round(clamp((v - 3) / 4.7) * 100));
/** 0.5 homicides/100k or fewer → 100, 50 or more → 0, on a log scale. */
const scoreSafety = (v?: number) => (v === undefined ? null : round((1 - clamp(Math.log10(Math.max(v, 0.5) / 0.5) / 2)) * 100));
/** WHO guideline 5 µg/m³ → 100, 100 µg/m³ → 0, on a log scale. */
const scoreAir = (v?: number) => (v === undefined ? null : round((1 - clamp(Math.log(Math.max(v, 5) / 5) / Math.log(20))) * 100));
/** 20 m of relief → 0, 2,500 m → 100, on a log scale. */
const scoreRelief = (m: number) => round(clamp(Math.log10(Math.max(m, 20) / 20) / Math.log10(125)) * 100);
/**
 * Water: sea within 15 km (40-70 by how much of the view it is), or a lake (55 within 3 km,
 * 40 within 10 km). Capped below mountains: a flat coastline is pleasant, not spectacular.
 */
const scoreWater = (sea: number, lake: number | null) =>
  Math.max(sea > 0 ? round(40 + 30 * clamp(sea / 0.3)) : 0, lake === 0 ? 55 : lake === 1 ? 40 : 0);
/** World Heritage site within 5 km → 100, fading to 0 at 50 km. */
const scoreHeritage = (d: number | null) => (d === null ? 0 : round(clamp(1 - (d - 5) / 45) * 100));
/** Counts on a log scale: 0 → 0, `top` or more → 100. */
const scoreCount = (n: number | undefined, top: number) => (n === undefined ? null : round(clamp(Math.log(n + 1) / Math.log(top + 1)) * 100));

async function main() {
  loadCities();
  // LIVABILITY_ONLY=id,id,... builds just those cities (a quick check; writes data/cache/livability/sample.json).
  const only = process.env.LIVABILITY_ONLY?.split(",").filter(Boolean);
  const cities = getCities().filter(
    (c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && (!only || only.includes(c.id))
  );
  const iso = await iso3Map();
  const [hdiBy, happyBy, homBy, pmBy] = await Promise.all([hdi(), happiness(), worldBank("VC.IHR.PSRC.P5"), worldBank("EN.ATM.PM25.MC.M3")]);
  const unmapped = [...new Set(cities.filter((c) => !iso(c.country)).map((c) => c.country))];
  if (unmapped.length) console.log("countries without an ISO code:", unmapped.join(", "));

  // City-level air for the major cities (rank 0: capitals, large hubs, 5M+); the rest use their country mean.
  const major = cities.filter((c) => c.capital || c.hub === "large" || c.population >= 5_000_000);
  const air = await cityAir(major).catch((e) => {
    console.warn("city air unavailable, using country means:", (e as Error).message);
    return {} as Record<string, number>;
  });

  const lakes = await lakeIndex();
  const sites = await heritageSites();
  console.log(`World Heritage sites with coordinates: ${sites.length}`);
  const terr = await pooled("terrain", cities, (c) => c.id, terrain, 4);
  const photos = await pooled("photo-density", cities, (c) => c.id, photoDensity, 4);
  const notable = await pooled("notable", cities, (c) => c.id, (c) => geoCount("en.wikipedia.org", c, 5000, 0), 4);

  const out: Record<string, unknown> = {};
  for (const c of cities) {
    const code = iso(c.country);
    const cityPm = air[c.id];
    const pm = cityPm ?? (code ? pmBy[code] : undefined);
    const quality = {
      hdi: scoreHdi(code ? hdiBy[code] : undefined),
      happiness: scoreHappiness(code ? happyBy[code] : undefined),
      safety: scoreSafety(code ? homBy[code] : undefined),
      air: scoreAir(pm),
    };
    const qWeights = { hdi: 0.3, happiness: 0.25, safety: 0.2, air: 0.25 };
    const t = terr[c.id];
    const lake = nearLake(c, lakes);
    let nearest: number | null = null;
    for (const [la, ln] of sites) {
      if (Math.abs(la - c.lat) > 0.6) continue;
      const d = km(c.lat, c.lng, la, ln);
      if (d <= 50 && (nearest === null || d < nearest)) nearest = d;
    }
    const setting = t ? { relief: scoreRelief(t.relief), water: scoreWater(t.sea, lake) } : null;
    const character = {
      heritage: scoreHeritage(nearest),
      photos: scoreCount(photos[c.id], 8000),
      notable: scoreCount(notable[c.id], 500),
    };
    // Mountains or water each make a setting; both make a better one ("either/or", not an average).
    const settingScore = setting ? round(100 * (1 - (1 - setting.relief / 100) * (1 - setting.water / 100))) : null;
    const characterScore = blend(character, { heritage: 0.4, photos: 0.35, notable: 0.25 });
    // A quality score needs a development or happiness figure and at least two parts in all:
    // small territories with only a homicide rate and air would otherwise score 0 or 100.
    const present = Object.values(quality).filter((v) => v !== null).length;
    const enough = (quality.hdi !== null || quality.happiness !== null) && present >= 2;
    out[c.id] = {
      quality: enough ? blend(quality, qWeights) : null,
      qualityParts: quality,
      // Share of the quality weight measured at the city itself (only air, for major cities).
      local: cityPm !== undefined && quality.air !== null ? qWeights.air : 0,
      setting: settingScore,
      settingParts: setting,
      character: characterScore,
      characterParts: character,
      // Either axis can make a place beautiful (Queenstown on setting, Venice on character), so
      // the stronger one counts 65% and the weaker 35%.
      beauty:
        settingScore !== null && characterScore !== null
          ? round(0.65 * Math.max(settingScore, characterScore) + 0.35 * Math.min(settingScore, characterScore))
          : settingScore ?? characterScore,
      raw: {
        hdi: code ? hdiBy[code] : undefined,
        happiness: code ? happyBy[code] : undefined,
        homicides: code ? homBy[code] : undefined,
        pm25: pm === undefined ? undefined : Math.round(pm * 10) / 10,
        pm25Local: cityPm !== undefined,
        reliefM: t ? Math.round(t.relief) : undefined,
        seaShare: t ? Math.round(t.sea * 100) / 100 : undefined,
        lake: lake === 0 ? "3km" : lake === 1 ? "10km" : undefined,
        heritageKm: nearest === null ? undefined : Math.round(nearest),
        photos: photos[c.id],
        notable: notable[c.id],
      },
    };
  }
  writeFileSync(
    only ? join(CACHE, "sample.json") : join(ROOT, "data/livability.json"),
    JSON.stringify({
      version: 1,
      builtAt: new Date().toISOString().slice(0, 10),
      sources: {
        hdi: "UNDP Human Development Report 2023/24",
        happiness: "World Happiness Report via Our World in Data",
        safety: "World Bank VC.IHR.PSRC.P5 (UNODC)",
        air: "Open-Meteo Air Quality (CAMS), Jan + Jul 2024 sample; else World Bank EN.ATM.PM25.MC.M3",
        terrain: "AWS Terrain Tiles (Mapzen terrarium), zoom 9",
        lakes: "Natural Earth 10m lakes",
        heritage: "Wikidata: UNESCO World Heritage sites (P1435 = Q9259)",
        photos: "Wikimedia Commons geotagged files: within 2 km, or within 500 m ×16 where 2 km fills the 500-result limit",
        notable: "English Wikipedia articles within 5 km",
      },
      cities: out,
    })
  );
  console.log(`wrote data/livability.json for ${Object.keys(out).length} cities`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
