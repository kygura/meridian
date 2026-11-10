// Builds data/city-geo.json: for every city, its time zone and the landmass it sits on.
//
//   npx tsx scripts/build-city-geo.ts [path/to/ne_10m_land.geojson]
//
// Time zone: the IANA zone at the city's coordinates, from @photostructure/tz-lookup
// (CC0; built from timezone-boundary-builder / OpenStreetMap). The calendar export uses
// it to turn "departs 10:30 local" into a real instant.
//
// Landmass: which piece of land the city is on, so a trip leg can default to ground
// transport when both ends share one, and to a ferry or a flight when the sea is between
// them (ADR 0010). From Natural Earth 1:10m land polygons (public domain), pinned to
// v5.1.2 and downloaded if no path is given.
//   1. Point-in-polygon for each city; a coastal city that falls just offshore takes the
//      nearest polygon within 25 km.
//   2. Polygons whose coasts come within 5 km of each other are joined: crossings that
//      short are bridged or have a ferry that buses and trains use (Singapore–Johor,
//      Penang, Sicily, Bali–Java, Honshu–Kyushu).
//   3. Fixed links longer than that are listed by hand in FIXED_LINKS below.
// The number written per city is the id of its joined group; equal ids mean "you can
// get there over land". It has no meaning beyond that comparison.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import tzlookup from "@photostructure/tz-lookup";
import { loadCities, getCities } from "../server/lib/cities.ts";

const NE_VERSION = "v5.1.2";
const NE_URL = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_VERSION}/geojson/ne_10m_land.geojson`;
const SNAP_KM = 25;
const JOIN_KM = 5;

/** Bridges and tunnels over more than 5 km of water, as a point ([lat, lng]) on either side. */
const FIXED_LINKS: { name: string; a: [number, number]; b: [number, number] }[] = [
  { name: "Channel Tunnel", a: [51.5, -0.12], b: [48.85, 2.35] },
  { name: "Seikan Tunnel", a: [43.06, 141.35], b: [35.68, 139.75] },
  { name: "Great Belt and Øresund bridges", a: [55.68, 12.56], b: [53.55, 10.0] },
  { name: "King Fahd Causeway", a: [26.22, 50.58], b: [26.43, 50.1] },
  { name: "Confederation Bridge", a: [46.35, -63.4], b: [46.2, -64.9] },
];

type Ring = [number, number][];
interface Poly {
  rings: Ring[];
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
}

async function loadLand(): Promise<Poly[]> {
  const given = process.argv[2];
  let text: string;
  if (given && existsSync(given)) text = readFileSync(given, "utf8");
  else {
    const res = await fetch(NE_URL);
    if (!res.ok) throw new Error(`Natural Earth download failed: ${res.status}`);
    text = await res.text();
  }
  const gj = JSON.parse(text) as { features: { geometry: { type: string; coordinates: unknown } }[] };
  const polys: Poly[] = [];
  const add = (rings: Ring[]) => {
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const [x, y] of rings[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    polys.push({ rings, bbox: [minX, minY, maxX, maxY] });
  };
  for (const f of gj.features) {
    if (f.geometry.type === "Polygon") add(f.geometry.coordinates as Ring[]);
    else if (f.geometry.type === "MultiPolygon") for (const p of f.geometry.coordinates as Ring[][]) add(p);
  }
  return polys;
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

function inPoly(x: number, y: number, p: Poly): boolean {
  const [a, b, c, d] = p.bbox;
  if (x < a || x > c || y < b || y > d) return false;
  if (!inRing(x, y, p.rings[0])) return false;
  for (let i = 1; i < p.rings.length; i++) if (inRing(x, y, p.rings[i])) return false;
  return true;
}

const KM_PER_DEG = 111.32;

/** Distance in km from a point to a segment, in a local flat projection (fine under ~100 km). */
function segKm(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const k = Math.cos((y * Math.PI) / 180);
  const ax = (x1 - x) * k, ay = y1 - y, bx = (x2 - x) * k, by = y2 - y;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
  return Math.hypot(ax + t * dx, ay + t * dy) * KM_PER_DEG;
}

/** Coast segments bucketed on a 0.25° grid: cell → [polygon, x1, y1, x2, y2]. */
function coastGrid(polys: Poly[]): Map<string, number[][]> {
  const CELL = 0.25;
  const grid = new Map<string, number[][]>();
  polys.forEach((p, pi) => {
    const ring = p.rings[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      const cx0 = Math.floor(Math.min(x1, x2) / CELL), cx1 = Math.floor(Math.max(x1, x2) / CELL);
      const cy0 = Math.floor(Math.min(y1, y2) / CELL), cy1 = Math.floor(Math.max(y1, y2) / CELL);
      if (cx1 - cx0 > 40) continue; // antimeridian-spanning edge of a clipped polygon
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cy = cy0; cy <= cy1; cy++) {
          const k = `${cx}:${cy}`;
          let arr = grid.get(k);
          if (!arr) grid.set(k, (arr = []));
          arr.push([pi, x1, y1, x2, y2]);
        }
    }
  });
  return grid;
}

/** Coast segments within `km` of a point: calls back with (polygon, distance). */
function near(grid: Map<string, number[][]>, x: number, y: number, km: number, cb: (pi: number, d: number) => void): void {
  const CELL = 0.25;
  const dy = Math.ceil(km / KM_PER_DEG / CELL);
  const dx = Math.ceil(km / (KM_PER_DEG * Math.max(0.05, Math.cos((y * Math.PI) / 180))) / CELL);
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let i = cx - dx; i <= cx + dx; i++)
    for (let j = cy - dy; j <= cy + dy; j++) {
      const arr = grid.get(`${i}:${j}`);
      if (!arr) continue;
      for (const s of arr) {
        const d = segKm(x, y, s[1], s[2], s[3], s[4]);
        if (d <= km) cb(s[0], d);
      }
    }
}

async function main() {
  loadCities();
  const cities = getCities();
  const polys = await loadLand();
  console.log(`[city-geo] ${polys.length} land polygons, ${cities.length} cities`);
  const grid = coastGrid(polys);

  // Union-find over polygons.
  const parent = polys.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 2. Join polygons whose coasts nearly touch.
  let joins = 0;
  polys.forEach((p, pi) => {
    for (const [x, y] of p.rings[0])
      near(grid, x, y, JOIN_KM, (other) => {
        if (other !== pi && find(other) !== find(pi)) {
          union(pi, other);
          joins++;
        }
      });
  });

  // 1. Each city's polygon.
  const polyOf = new Map<string, number>();
  let snapped = 0, lost = 0;
  for (const c of cities) {
    let hit = polys.findIndex((p) => inPoly(c.lng, c.lat, p));
    if (hit === -1) {
      let best = Infinity;
      near(grid, c.lng, c.lat, SNAP_KM, (pi, d) => {
        if (d < best) {
          best = d;
          hit = pi;
        }
      });
      if (hit === -1) lost++;
      else snapped++;
    }
    if (hit !== -1) polyOf.set(c.id, hit);
  }

  // 3. Fixed links.
  for (const l of FIXED_LINKS) {
    const a = polys.findIndex((p) => inPoly(l.a[1], l.a[0], p));
    const b = polys.findIndex((p) => inPoly(l.b[1], l.b[0], p));
    if (a === -1 || b === -1) throw new Error(`Fixed link ${l.name}: an end is not on land`);
    union(a, b);
  }

  const zones: string[] = [];
  const zoneIdx = new Map<string, number>();
  const out: Record<string, [number, number]> = {};
  for (const c of cities) {
    const tz = tzlookup(c.lat, c.lng);
    let zi = zoneIdx.get(tz);
    if (zi === undefined) {
      zi = zones.length;
      zones.push(tz);
      zoneIdx.set(tz, zi);
    }
    const p = polyOf.get(c.id);
    out[c.id] = [p === undefined ? -1 : find(p), zi];
  }

  const file = {
    builtAt: new Date().toISOString().slice(0, 10),
    sources: {
      landmass: `Natural Earth 1:10m land ${NE_VERSION} (public domain)`,
      timezone: "@photostructure/tz-lookup (CC0, from timezone-boundary-builder)",
    },
    method: { snapKm: SNAP_KM, joinKm: JOIN_KM, fixedLinks: FIXED_LINKS.map((l) => l.name) },
    zones,
    /** cityId → [landmass group (-1 = unknown), index into zones]. */
    cities: out,
  };
  writeFileSync(join(process.cwd(), "data/city-geo.json"), JSON.stringify(file));
  const groups = new Set(Object.values(out).map((v) => v[0]));
  console.log(`[city-geo] ${joins} coast joins, ${snapped} cities snapped to a coast, ${lost} without land`);
  console.log(`[city-geo] ${groups.size} landmass groups in use, ${zones.length} time zones`);
  const show = (id: string) => `${id}=${out[id]?.[0]}/${zones[out[id]?.[1] ?? 0]}`;
  console.log(
    ["las-palmas-spain", "lisbon-portugal", "london-united-kingdom", "paris-france", "singapore-singapore", "kuala-lumpur-malaysia", "tokyo-japan", "sapporo-japan", "denpasar-indonesia", "jakarta-indonesia", "dublin-ireland", "new-york-united-states", "k-benhavn-denmark", "palermo-italy", "colombo-sri-lanka", "manama-bahrain", "santa-cruz-de-tenerife-spain", "hong-kong-hong-kong", "george-town-malaysia", "phuket-thailand", "da-nang-vietnam", "podgorica-montenegro"]
      .map(show)
      .join("\n")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
