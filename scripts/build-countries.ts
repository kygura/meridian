// Builds public/geo/countries.json: the country polygons behind the map's land layer,
// the seasons tint and the continent lookup (src/screens/map/countries.ts).
//
//   npx tsx scripts/build-countries.ts [ne_50m_admin_0_countries.geojson] [ne_10m_admin_0_countries.geojson]
//
// Source: Natural Earth 1:50m admin-0 countries v3.3.0 (public domain), the same schema the
// app used at 1:110m, which dropped small islands: the Canaries, the Balearics, Madeira, the
// Azores, Malta, Mauritius, Réunion, Bahrain, the Maldives and others had cities and no land.
// Islands with a city that 1:50m still lacks are taken from 1:10m (v5.1.2) and added to
// their country's feature. Only the properties the app reads are kept, and coordinates are
// rounded to 0.001° (about 100 m), well below what the map shows at its zoom range.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getCities, loadCities } from "../server/lib/cities.ts";

const URL_50M = "https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_countries.geojson";
const URL_10M = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson";
const OUT = join(import.meta.dirname, "..", "public", "geo", "countries.json");
/** Properties the app reads: join names (featureKeys) and continent/subregion (countryInfo). */
const KEEP = ["name", "name_long", "admin", "geounit", "sovereignt", "formal_en", "continent", "subregion", "iso_a3"];

type Ring = [number, number][];
type Poly = Ring[];
interface Feature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Polygon"; coordinates: Poly } | { type: "MultiPolygon"; coordinates: Poly[] };
}
interface Collection {
  type: "FeatureCollection";
  features: Feature[];
}

async function load(arg: string | undefined, url: string): Promise<Collection> {
  if (arg && existsSync(arg)) return JSON.parse(readFileSync(arg, "utf8"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as Collection;
}

const polys = (f: Feature): Poly[] => (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]);

function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x: number, y: number, p: Poly) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h));

/** The polygon a point is on, trying the point and a small neighbourhood (city points sit on coasts). */
function findPoly(fc: Collection, x: number, y: number, slack = 0.05): { feature: Feature; poly: Poly } | null {
  const offsets = slack ? [[0, 0], [slack, 0], [-slack, 0], [0, slack], [0, -slack]] : [[0, 0]];
  for (const [dx, dy] of offsets) {
    for (const feature of fc.features) for (const poly of polys(feature)) if (inPoly(x + dx, y + dy, poly)) return { feature, poly };
  }
  return null;
}

/** Whether any of a polygon's outline points (sampled) lies on 1:50m land. */
function overlaps(poly: Poly, fc: Collection): boolean {
  const ring = poly[0];
  const step = Math.max(1, Math.floor(ring.length / 64));
  for (let i = 0; i < ring.length; i += step) if (findPoly(fc, ring[i][0], ring[i][1], 0)) return true;
  return false;
}

function roundRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const [x, y] of ring) {
    const p: [number, number] = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

async function main() {
  const [base, fine] = await Promise.all([load(process.argv[2], URL_50M), load(process.argv[3], URL_10M)]);
  await loadCities();
  const cities = getCities();

  const added: string[] = [];
  const missing: string[] = [];
  for (const c of cities) {
    if (findPoly(base, c.lng, c.lat)) continue;
    const hit = findPoly(fine, c.lng, c.lat);
    const a3 = hit?.feature.properties.ADM0_A3;
    const owner = hit && base.features.find((f) => f.properties.adm0_a3 === a3);
    // Only an island 1:50m lacks: a coastal city just off a 1:50m shore would otherwise
    // pull in its whole 1:10m mainland on top of the 1:50m one.
    if (!hit || !owner || overlaps(hit.poly, base)) {
      missing.push(`${c.name}, ${c.country}`);
      continue;
    }
    owner.geometry = { type: "MultiPolygon", coordinates: [...polys(owner), hit.poly] };
    added.push(`${c.name}, ${c.country}`);
  }

  const features: Feature[] = base.features.map((f) => ({
    type: "Feature",
    properties: Object.fromEntries(KEEP.filter((k) => f.properties[k] != null).map((k) => [k, f.properties[k]])),
    geometry: {
      type: "MultiPolygon",
      coordinates: polys(f)
        .map((p) => p.map(roundRing).filter((r) => r.length >= 4))
        .filter((p) => p.length > 0),
    },
  }));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`${features.length} countries -> ${OUT}`);
  console.log(`islands added from 1:10m: ${added.length ? added.join("; ") : "none"}`);
  console.log(`cities still off land: ${missing.length ? missing.join("; ") : "none"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
