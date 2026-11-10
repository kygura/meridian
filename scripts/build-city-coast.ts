// Builds data/city-coast.json: each city's distance to the sea coast, for the solver's
// "by the sea" preference (ADR 0015).
//
//   npx tsx scripts/build-city-coast.ts [path/to/ne_10m_coastline.geojson]
//
// Source: Natural Earth 1:10m coastline v5.1.2 (public domain), downloaded if no path is
// given. Natural Earth's coastline is the land polygons' outline, so it includes the
// shores of the Caspian Sea but not of lakes. Distance is from the city's coordinates to
// the nearest coastline segment, on a local flat projection (accurate to well under a
// kilometre at these distances). Cities more than MAX_KM from the coast are not listed;
// the file says so, and the app reads a missing city as "more than MAX_KM".

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getCities, loadCities } from "../server/lib/cities.ts";

const NE_VERSION = "v5.1.2";
const NE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_VERSION}/geojson/ne_10m_coastline.geojson`;
const MAX_KM = 100;
const CELL = 1; // degrees

type Seg = [number, number, number, number]; // lng1, lat1, lng2, lat2

async function loadSegments(): Promise<Seg[]> {
  const given = process.argv[2];
  const text = given && existsSync(given) ? readFileSync(given, "utf8") : await (await fetch(NE_URL)).text();
  const gj = JSON.parse(text) as { features: { geometry: { type: string; coordinates: unknown } }[] };
  const segs: Seg[] = [];
  const addLine = (line: [number, number][]) => {
    for (let i = 0; i + 1 < line.length; i++) segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  };
  for (const f of gj.features) {
    if (f.geometry.type === "LineString") addLine(f.geometry.coordinates as [number, number][]);
    else if (f.geometry.type === "MultiLineString") for (const l of f.geometry.coordinates as [number, number][][]) addLine(l);
  }
  return segs;
}

function index(segs: Seg[]): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s[0], s[2]) / CELL);
    const x1 = Math.floor(Math.max(s[0], s[2]) / CELL);
    const y0 = Math.floor(Math.min(s[1], s[3]) / CELL);
    const y1 = Math.floor(Math.max(s[1], s[3]) / CELL);
    if (x1 - x0 > 10) return; // antimeridian wrap segments: skip (none near cities)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const a = grid.get(k) ?? [];
        a.push(i);
        grid.set(k, a);
      }
  });
  return grid;
}

/** km from (lng, lat) to segment s, on an equirectangular projection centred on the point. */
function distKm(lng: number, lat: number, s: Seg): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const ax = (s[0] - lng) * kx;
  const ay = (s[1] - lat) * ky;
  const bx = (s[2] - lng) * kx;
  const by = (s[3] - lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.sqrt(px * px + py * py);
}

async function main() {
  loadCities();
  const segs = await loadSegments();
  const grid = index(segs);
  const out: Record<string, number> = {};
  for (const c of getCities()) {
    const reachX = Math.ceil(MAX_KM / (111.32 * Math.max(0.1, Math.cos((c.lat * Math.PI) / 180))) / CELL);
    const reachY = Math.ceil(MAX_KM / 110.57 / CELL);
    const cx = Math.floor(c.lng / CELL);
    const cy = Math.floor(c.lat / CELL);
    let best = Infinity;
    for (let x = cx - reachX; x <= cx + reachX; x++)
      for (let y = cy - reachY; y <= cy + reachY; y++) for (const i of grid.get(`${x},${y}`) ?? []) best = Math.min(best, distKm(c.lng, c.lat, segs[i]));
    if (best <= MAX_KM) out[c.id] = Math.round(best * 10) / 10;
  }
  const file = {
    builtAt: new Date().toISOString().slice(0, 10),
    source: `Natural Earth 1:10m coastline ${NE_VERSION} (public domain)`,
    method: `Distance from the city's coordinates to the nearest coastline segment. Cities more than ${MAX_KM} km from the coast are not listed. Includes the Caspian Sea, not lakes.`,
    maxKm: MAX_KM,
    cities: out,
  };
  writeFileSync(join(process.cwd(), "data/city-coast.json"), JSON.stringify(file));
  console.log(`${Object.keys(out).length} of ${getCities().length} cities within ${MAX_KM} km of the coast`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
