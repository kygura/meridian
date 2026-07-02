# Meridian Agentic Travel Interface Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Meridian from a globe-with-widgets into an agentic travel interface: a real airport/city dataset, correct flight-path geometry, a dedicated Trips page + fixed trip modal, on-globe route drawing, and removal of the bottom bar.

**Architecture:** Keep the Vite + React 19 + zustand + MapLibre client and the Hono server. Add a tiny hash router (no new routing dep), a shared geo module (`src/lib/geo.ts`) used by the Globe for antimeridian-safe, hub-routed flight paths, and a build-time data pipeline (`scripts/build-airports.mjs`) that produces `data/airports.json` + `data/capitals.json` from OurAirports/restcountries, merged country-aware into the city list on the server.

**Tech Stack:** bun, Vite 6, React 19, zustand 5 (+ `persist` middleware), MapLibre GL 5, Hono 4, vitest (new devDep, test runner), csv-parse (already a dep).

## Global Constraints

- Use **bun** for all package/script commands (`bun add`, `bun run`, `bunx`) — user's global instruction.
- **No react-router**: routing is hash-based (`#/`, `#/trips`, `#/trips/:id`) via `src/lib/router.ts`. Works with static serving and the existing `vercel.json` rewrite.
- The MapLibre map instance must **stay mounted** when navigating to the Trips page (the Trips page renders on top; unmounting the map costs seconds of re-init).
- `Trip.color` becomes a **hex string**. Legacy `"a" | "b" | "c"` values must still render (mapped via `resolveTripColor`).
- Trip node operations are **index-based** (duplicate cities in one trip are legal — that's how return legs work).
- **Deferred / non-goals** (explicitly out of scope, per user): higher-granularity landmass/city basemap tiles; booking API integrations (links out only).
- All source data scripts write into `data/` and their outputs are **committed** (server reads local files only at runtime).
- Do not touch `dist/` or `artifact/` — build artifacts.
- Commit after every task; work on a feature branch `feat/meridian-overhaul` (create in Task 1).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/geo.ts` | Create | Pure geo math: haversine, antimeridian-safe great circles, hub-routed `flightPath`, duration/cost estimates |
| `src/lib/geo.test.ts` | Create | Tests for geo math |
| `src/lib/tripColors.ts` | Create | 12-color trip palette, `randomTripColor`, legacy `resolveTripColor` |
| `src/lib/tripColors.test.ts` | Create | Tests for palette |
| `src/lib/router.ts` | Create | Hash router: `useRoute()`, `navigate()` |
| `scripts/build-airports.mjs` | Create | One-shot data pipeline → `data/airports.json`, `data/capitals.json` |
| `data/airports.json` | Create (generated) | ~3–4k IATA airports (large+medium, scheduled service) |
| `data/capitals.json` | Create (generated) | Capital city name per country |
| `server/lib/cities.ts` | Rewrite | Country-aware IATA merge, hub/capital flags, airport-city synthesis, ranked search |
| `server/lib/cities.test.ts` | Create | Tests: LAX collision, LPA, Penang, country search |
| `src/types.ts` | Modify | `City.capital/hub/airportName`, `Trip.color: string` |
| `src/store.ts` | Rewrite | Persisted trips, random colors, index-based node ops, `drawMode`, pruned layers |
| `src/App.tsx` | Rewrite | Two-row grid (no bottom bar), hash-routed Trips page overlay |
| `src/components/BottomBar.tsx` | **Delete** | — |
| `src/components/TopBar.tsx` | Modify | GLOBE / TRIPS nav |
| `src/components/LeftDrawer.tsx` | Modify | "Open trips" → navigates to `#/trips` |
| `src/pages/TripsPage.tsx` | Create | Dedicated full-page trip planner (legs, durations, costs, booking links, replace/return airports) |
| `src/components/TripsOverlay.tsx` | Rewrite | Fixed modal: index ops, return airports, replace-by-rename, 12-color picker, link to full page |
| `src/components/TripCandidates.tsx` | Modify | Hex color bar |
| `src/components/TripCard.tsx` | Modify (if it uses `data-color`) | Hex color bar |
| `src/components/CommandPalette.tsx` | Modify | Pruned layer commands |
| `src/components/Globe.tsx` | Modify | geo.ts paths, label readability, capital/hub styling, draw mode, pruned metric layers |
| `src/lib/phenomena.ts` | Modify | Delegate `greatCircle`/haversine to `geo.ts` |
| `src/index.css` | Modify | Remove `data-color` rules, trip-modal spacing fixes, Trips page + draw-mode styles |
| `package.json` | Modify | `vitest` devDep, `test` + `build:data` scripts |

---

### Task 1: Test infra + shared geo module (antimeridian fix, hub routing)

**Files:**
- Modify: `package.json`
- Create: `src/lib/geo.ts`
- Test: `src/lib/geo.test.ts`
- Modify: `src/lib/phenomena.ts`

**Interfaces:**
- Produces (consumed by Tasks 3, 6, 8):
  - `type LngLat = [number, number]` (lng, lat — GeoJSON order)
  - `haversineKm(a: LngLat, b: LngLat): number`
  - `greatCirclePoints(a: LngLat, b: LngLat, steps?: number): LngLat[]` — longitudes **unwrapped** (consecutive deltas ≤ 180°)
  - `MAX_NONSTOP_KM = 14800`
  - `flightPath(a: LngLat, b: LngLat, hubs?: { coord: LngLat; label: string }[]): { segments: LngLat[][]; distanceKm: number; via?: string }`
  - `estimateFlightHours(km: number): number`
  - `formatHours(h: number): string` (e.g. `"13h 20m"`)
  - `estimateLegCostUSD(km: number): number`

- [ ] **Step 1: Branch + install vitest**

```bash
cd /home/athan/projects/meridian
git checkout -b feat/meridian-overhaul
bun add -d vitest
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/geo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  haversineKm,
  greatCirclePoints,
  flightPath,
  estimateFlightHours,
  formatHours,
  estimateLegCostUSD,
  MAX_NONSTOP_KM,
} from "./geo";

const AKL: [number, number] = [174.763, -36.8481];
const HNL: [number, number] = [-157.846, 21.3294];
const LHR: [number, number] = [-0.4543, 51.47];
const LAX: [number, number] = [-118.4085, 33.9416];
const SIN: [number, number] = [103.9915, 1.3644];
const DXB: [number, number] = [55.3644, 25.2532];

describe("haversineKm", () => {
  it("AKL→HNL ≈ 7060 km", () => {
    const d = haversineKm(AKL, HNL);
    expect(d).toBeGreaterThan(6900);
    expect(d).toBeLessThan(7300);
  });
});

describe("greatCirclePoints (antimeridian)", () => {
  it("never jumps more than 180° in longitude between consecutive points", () => {
    const pts = greatCirclePoints(AKL, HNL);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(180);
    }
  });
  it("starts at a and ends at b (mod 360)", () => {
    const pts = greatCirclePoints(AKL, HNL);
    expect(pts[0][0]).toBeCloseTo(AKL[0], 3);
    const endLngMod = ((pts[pts.length - 1][0] % 360) + 540) % 360 - 180;
    expect(endLngMod).toBeCloseTo(HNL[0], 3);
    expect(pts[pts.length - 1][1]).toBeCloseTo(HNL[1], 3);
  });
});

describe("flightPath", () => {
  const hubs = [
    { coord: LAX, label: "LAX" },
    { coord: SIN, label: "SIN" },
    { coord: DXB, label: "DXB" },
  ];
  it("short leg is a single segment with no via", () => {
    const p = flightPath(AKL, HNL, hubs);
    expect(p.segments).toHaveLength(1);
    expect(p.via).toBeUndefined();
  });
  it("near-antipodal AKL→LHR routes via a hub, both legs flyable", () => {
    const p = flightPath(AKL, LHR, hubs);
    expect(p.segments).toHaveLength(2);
    expect(p.via).toBeDefined();
    // both legs within nonstop range
    for (const seg of p.segments) {
      const d = haversineKm(seg[0], seg[seg.length - 1]);
      expect(d).toBeLessThanOrEqual(MAX_NONSTOP_KM);
    }
  });
  it("falls back to direct when no hub helps", () => {
    const p = flightPath(AKL, LHR, []);
    expect(p.segments).toHaveLength(1);
  });
});

describe("estimates", () => {
  it("cruise math: ~830 km/h + overhead", () => {
    expect(estimateFlightHours(8300)).toBeGreaterThan(10);
    expect(estimateFlightHours(8300)).toBeLessThan(12);
  });
  it("formatHours", () => {
    expect(formatHours(13.33)).toBe("13h 20m");
    expect(formatHours(0.5)).toBe("0h 30m");
  });
  it("leg cost grows with distance", () => {
    expect(estimateLegCostUSD(1000)).toBeGreaterThan(100);
    expect(estimateLegCostUSD(10000)).toBeGreaterThan(estimateLegCostUSD(1000));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `Cannot find module './geo'` (or similar).

- [ ] **Step 4: Implement `src/lib/geo.ts`**

```ts
export type LngLat = [number, number]; // [lng, lat] — GeoJSON order

const R_EARTH_KM = 6371;

export const MAX_NONSTOP_KM = 14800; // beyond this, no commercial nonstop exists

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Great-circle interpolation with longitude unwrapping: consecutive points
 * never differ by more than 180° in longitude, so LineStrings crossing the
 * antimeridian render without wrapping glitches.
 */
export function greatCirclePoints(a: LngLat, b: LngLat, steps = 64): LngLat[] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lon1, lat1] = [toRad(a[0]), toRad(a[1])];
  const [lon2, lat2] = [toRad(b[0]), toRad(b[1])];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
      )
    );
  if (d === 0 || !Number.isFinite(d)) return [a, b];

  const pts: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    pts.push([
      toDeg(Math.atan2(y, x)),
      toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    ]);
  }
  // Unwrap longitudes relative to the previous point.
  for (let i = 1; i < pts.length; i++) {
    let lng = pts[i][0];
    const prev = pts[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    pts[i][0] = lng;
  }
  return pts;
}

export interface FlightHub {
  coord: LngLat;
  label: string;
}

export interface FlightPath {
  segments: LngLat[][];
  distanceKm: number;
  /** Hub label when the leg is too long for a nonstop and is routed via a hub. */
  via?: string;
}

/**
 * Realistic path for one leg. Legs within nonstop range fly the great circle.
 * Longer (near-antipodal) legs are routed through the connecting hub that
 * minimizes total distance — e.g. AKL→LHR via LAX/SIN instead of over the pole.
 */
export function flightPath(a: LngLat, b: LngLat, hubs: FlightHub[] = []): FlightPath {
  const direct = haversineKm(a, b);
  if (direct <= MAX_NONSTOP_KM || hubs.length === 0) {
    return { segments: [greatCirclePoints(a, b)], distanceKm: direct };
  }
  let best: { hub: FlightHub; total: number } | null = null;
  for (const h of hubs) {
    const d1 = haversineKm(a, h.coord);
    const d2 = haversineKm(h.coord, b);
    if (d1 < 500 || d2 < 500) continue; // hub is basically an endpoint
    if (d1 > MAX_NONSTOP_KM || d2 > MAX_NONSTOP_KM) continue;
    const total = d1 + d2;
    if (!best || total < best.total) best = { hub: h, total };
  }
  if (!best) return { segments: [greatCirclePoints(a, b)], distanceKm: direct };
  return {
    segments: [
      greatCirclePoints(a, best.hub.coord),
      greatCirclePoints(best.hub.coord, b),
    ],
    distanceKm: best.total,
    via: best.hub.label,
  };
}

/** Rough block time: taxi/climb overhead + cruise at ~830 km/h. */
export function estimateFlightHours(km: number): number {
  return 0.6 + km / 830;
}

export function formatHours(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${whole}h ${String(mins).padStart(2, "0")}m`;
}

/** Rough one-way economy estimate. */
export function estimateLegCostUSD(km: number): number {
  return Math.round(45 + 0.11 * km);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS (all geo tests green).

- [ ] **Step 6: Make `phenomena.ts` delegate to geo.ts**

In `src/lib/phenomena.ts`:
1. Add at top: `import { greatCirclePoints, haversineKm } from "./geo";`
2. Delete the local `haversine` function (lines defining `function haversine(a: City, b: City)`) and the local `greatCircle` function entirely.
3. Re-export for existing importers: add `export { greatCirclePoints as greatCircle } from "./geo";`
4. In `buildAirRoutes`, replace `haversine(hub, o)` with `haversineKm([hub.lng, hub.lat], [o.lng, o.lat])` and `greatCircle(...)` with `greatCirclePoints(...)`.

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck
git add package.json bun.lock src/lib/geo.ts src/lib/geo.test.ts src/lib/phenomena.ts
git commit -m "feat: shared geo module with antimeridian-safe great circles and hub-routed flight paths"
```

---

### Task 2: Airport + capital data pipeline

**Files:**
- Create: `scripts/build-airports.mjs`
- Create (generated): `data/airports.json`, `data/capitals.json`
- Modify: `package.json` (add `build:data` script)

**Interfaces:**
- Produces `data/airports.json`: `Array<{ iata: string; name: string; city: string; country: string; lat: number; lng: number; size: "large" | "medium" }>`
- Produces `data/capitals.json`: `Array<{ country: string; capital: string }>`
- Consumed by Task 3 (`server/lib/cities.ts`).

- [ ] **Step 1: Write the script**

Create `scripts/build-airports.mjs`:

```js
// One-shot data pipeline. Run: bun run build:data
// Writes data/airports.json (IATA airports, large+medium, scheduled service)
// and data/capitals.json (capital per country). Outputs are committed.
import { writeFileSync } from "fs";
import { parse } from "csv-parse/sync";

const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const COUNTRIES_CSV = "https://davidmegginson.github.io/ourairports-data/countries.csv";
const REST_COUNTRIES = "https://restcountries.com/v3.1/all?fields=name,capital";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

const [airportsRaw, countriesRaw, restRaw] = await Promise.all([
  fetchText(AIRPORTS_CSV),
  fetchText(COUNTRIES_CSV),
  fetchText(REST_COUNTRIES),
]);

const countryRows = parse(countriesRaw, { columns: true, skip_empty_lines: true });
const isoToName = new Map(countryRows.map((r) => [r.code, r.name]));

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
```

Add to `package.json` scripts: `"build:data": "bun scripts/build-airports.mjs"`.

- [ ] **Step 2: Run it and sanity-check the outputs**

```bash
bun run build:data
bun -e '
const a = JSON.parse(require("fs").readFileSync("data/airports.json","utf8"));
const find = (i) => a.find(x => x.iata === i);
console.log("count:", a.length);
console.log("LPA:", JSON.stringify(find("LPA")));
console.log("PEN:", JSON.stringify(find("PEN")));
console.log("LAX:", JSON.stringify(find("LAX")));
console.log("AKL:", JSON.stringify(find("AKL")));
'
```

Expected: count in the 3000–5000 range; `LPA` present (Gran Canaria, Spain); `PEN` present (Penang, Malaysia); `LAX` present (United States); `AKL` present (New Zealand). If any of these are missing, stop and investigate the filter — do not proceed.

If the OurAirports/restcountries URLs are unreachable, STOP and report — do not hand-craft the JSON.

- [ ] **Step 3: Commit**

```bash
git add scripts/build-airports.mjs data/airports.json data/capitals.json package.json
git commit -m "feat: airport + capitals data pipeline from OurAirports/restcountries"
```

---

### Task 3: Server — country-aware IATA merge, hubs, capitals, ranked search

Fixes: LAX-in-Chile, missing LPA, missing Penang, "search a country → its airports".

**Files:**
- Modify: `src/types.ts` (City fields only — Trip changes come in Task 4)
- Rewrite: `server/lib/cities.ts`
- Test: `server/lib/cities.test.ts`

**Interfaces:**
- `City` gains: `capital?: boolean; hub?: "large" | "medium"; airportName?: string`
- `server/lib/cities.ts` keeps its exports: `loadCities(): void`, `getCities(): City[]`, `getCityById(id): City | undefined`, `searchCities(query): City[]` — signatures unchanged, so `server/routes/cities.ts` and `server/index.ts` need no edits.

- [ ] **Step 1: Extend the City type**

In `src/types.ts`, change the `City` interface to:

```ts
export interface City {
  id: string;
  name: string;
  lat: number;
  lng: number;
  country: string;
  population: number;
  iata?: string;
  /** True national capital (from restcountries). */
  capital?: boolean;
  /** Airport class serving this city, when matched. */
  hub?: "large" | "medium";
  /** Full airport name (searchable, e.g. "Penang International Airport"). */
  airportName?: string;
  region?: string;
  timezone?: string;
  currency?: string;
}
```

- [ ] **Step 2: Write the failing server tests**

Create `server/lib/cities.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { loadCities, getCities, getCityById, searchCities } from "./cities";

beforeAll(() => loadCities());

describe("IATA assignment is country-aware", () => {
  it("Los Angeles, United States → LAX", () => {
    expect(getCityById("los-angeles-united-states")?.iata).toBe("LAX");
  });
  it("Los Angeles, Chile does NOT get LAX", () => {
    const cl = getCityById("los-angeles-chile");
    expect(cl).toBeDefined();
    expect(cl?.iata).not.toBe("LAX");
  });
  it("Las Palmas → LPA", () => {
    expect(getCityById("las-palmas-spain")?.iata).toBe("LPA");
  });
});

describe("airport-only cities are synthesized", () => {
  it("Penang is searchable and has PEN", () => {
    const hits = searchCities("penang");
    expect(hits.some((c) => c.iata === "PEN")).toBe(true);
  });
});

describe("hub / capital flags", () => {
  it("London is a large hub and a capital", () => {
    const london = getCities().find(
      (c) => c.name === "London" && c.country === "United Kingdom"
    );
    expect(london?.hub).toBe("large");
    expect(london?.capital).toBe(true);
  });
});

describe("country search returns that country's airports, ranked", () => {
  it("searching 'Spain' puts the capital first and airport cities on top", () => {
    const hits = searchCities("Spain");
    expect(hits.length).toBeGreaterThan(3);
    expect(hits[0].name).toBe("Madrid");
    // every result in the top 10 belongs to Spain and has an airport
    for (const c of hits.slice(0, 10)) {
      expect(c.country).toBe("Spain");
      expect(c.iata).toBeTruthy();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test server/lib/cities.test.ts`
Expected: FAIL (old name-keyed iata map: Chile gets LAX; no LPA; no Penang; no hub/capital fields; unranked search).

- [ ] **Step 4: Rewrite `server/lib/cities.ts`**

```ts
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
}

let cities: City[] = [];

// worldcities.csv country spellings → OurAirports/restcountries spellings.
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

  // Country-aware nearest-airport assignment.
  // Primary: same (canonical) country within 100 km, preferring large airports.
  // Fallback: any airport within 40 km (covers country-name mismatches).
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
    const pick = (pool: Airport[], maxKm: number): Airport | undefined => {
      let best: { a: Airport; d: number } | undefined;
      for (const a of pool) {
        const d = haversineKm([city.lng, city.lat], [a.lng, a.lat]);
        if (d > maxKm) continue;
        const better =
          !best ||
          (a.size === "large" && best.a.size !== "large") ||
          (a.size === best.a.size && d < best.d);
        if (better) best = { a, d };
      }
      return best?.a;
    };
    const match = pick(sameCountry, 100) ?? pick(airports, 40);
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

  // Synthesize cities for airports that no existing city claimed (e.g. Penang),
  // so every scheduled airport is selectable and searchable.
  const existingIds = new Set(base.map((c) => c.id));
  for (const a of airports) {
    if (usedIatas.has(a.iata)) continue;
    const name = a.city || a.name.replace(/ (International )?Airport$/i, "");
    const id = slugify(name, a.country);
    if (existingIds.has(id)) continue;
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
 * Ranked search. If the query names a country, return that country's
 * airport cities first (capital, then hub size, then population).
 * Otherwise match city name / IATA / airport name / country substring.
 */
export function searchCities(query: string): City[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const isCountryQuery =
    q.length >= 4 && cities.some((c) => canonCountry(c.country).startsWith(q) || c.country.toLowerCase().startsWith(q));

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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test server/lib/cities.test.ts`
Expected: PASS. If `los-angeles-chile`'s assertion fails because the slug differs (accents), run `bun -e 'const {loadCities,getCities}=await import("./server/lib/cities.ts");loadCities();console.log(getCities().filter(c=>c.name.toLowerCase().includes("los angeles")).map(c=>({id:c.id,iata:c.iata,country:c.country})))'` and adjust the test's id string to the actual slug — the invariant that matters is *Chile ≠ LAX*.

- [ ] **Step 6: Boot the server once to confirm startup**

Run: `bun run server/index.ts` (Ctrl-C after the `[cities] Loaded …` line)
Expected: loads without throwing; city count > 4661 (synthesized airport cities added).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts server/lib/cities.ts server/lib/cities.test.ts
git commit -m "fix: country-aware IATA assignment, airport-city synthesis, capital/hub flags, ranked country search"
```

Also delete the now-unused name-keyed map: `git rm data/iata_map.json` and include it in this commit (verify with `grep -rn "iata_map" server/ src/` that nothing references it — remove any leftover reference).

---

### Task 4: Store + types — hex colors, index-based nodes, persistence, draw mode, pruned layers

**Files:**
- Create: `src/lib/tripColors.ts`
- Test: `src/lib/tripColors.test.ts`
- Modify: `src/types.ts` (Trip.color, LayerKey)
- Rewrite: `src/store.ts`
- Modify: `src/components/TripCandidates.tsx`, `src/components/TripCard.tsx` (color rendering)
- Modify: `src/index.css` (remove `data-color` rules)

**Interfaces:**
- Produces (consumed by Tasks 5–8):
  - `TRIP_COLORS: string[]` (12 hexes), `randomTripColor(used: string[]): string`, `resolveTripColor(color: string): string`
  - Store: `addCityToTrip(tripId, node)` (no dedup), `removeNodeAt(tripId: string, index: number)`, `replaceNodeAt(tripId: string, index: number, node: TripNode)`, `drawMode: boolean`, `setDrawMode(on: boolean)`; `removeNodeFromTrip` is **deleted**.
  - `LayerKey` pruned to `"trips" | "routes" | "cities" | "weather" | "cost" | "conflict" | "disaster"`.
  - Trips + activeTripId persisted to localStorage under key `meridian-trips`.

- [ ] **Step 1: Write the failing palette tests**

Create `src/lib/tripColors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TRIP_COLORS, randomTripColor, resolveTripColor } from "./tripColors";

describe("tripColors", () => {
  it("has at least 12 distinct colors", () => {
    expect(new Set(TRIP_COLORS).size).toBeGreaterThanOrEqual(12);
  });
  it("randomTripColor avoids colors already in use", () => {
    const used = TRIP_COLORS.slice(0, TRIP_COLORS.length - 1);
    for (let i = 0; i < 20; i++) {
      expect(randomTripColor(used)).toBe(TRIP_COLORS[TRIP_COLORS.length - 1]);
    }
  });
  it("randomTripColor still returns a palette color when all are used", () => {
    expect(TRIP_COLORS).toContain(randomTripColor([...TRIP_COLORS]));
  });
  it("resolves legacy a/b/c and passes hexes through", () => {
    expect(resolveTripColor("a")).toBe("#b3261e");
    expect(resolveTripColor("b")).toBe("#0f766e");
    expect(resolveTripColor("c")).toBe("#6d28d9");
    expect(resolveTripColor("#123456")).toBe("#123456");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/lib/tripColors.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/tripColors.ts`**

```ts
/** Trip identity palette — saturated but legible on both parchment and night themes. */
export const TRIP_COLORS: string[] = [
  "#b3261e", // vermilion
  "#0f766e", // teal
  "#6d28d9", // violet
  "#c2680c", // ochre
  "#1d4ed8", // cobalt
  "#be185d", // magenta
  "#4d7c0f", // olive
  "#0e7490", // petrol
  "#7c2d12", // rust
  "#a16207", // brass
  "#166534", // forest
  "#5b21b6", // indigo
];

const LEGACY: Record<string, string> = {
  a: "#b3261e",
  b: "#0f766e",
  c: "#6d28d9",
};

/** Map legacy "a"/"b"/"c" trip colors to hexes; pass real hexes through. */
export function resolveTripColor(color: string): string {
  return LEGACY[color] ?? color;
}

/** Random palette color, avoiding ones already used by other trips when possible. */
export function randomTripColor(used: string[]): string {
  const usedSet = new Set(used.map(resolveTripColor));
  const free = TRIP_COLORS.filter((c) => !usedSet.has(c));
  const pool = free.length > 0 ? free : TRIP_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}
```

- [ ] **Step 4: Run palette tests** — `bun run test src/lib/tripColors.test.ts` — Expected: PASS.

- [ ] **Step 5: Update `src/types.ts`**

- Change `Trip.color` from `"a" | "b" | "c"` to `string` and update its doc:

```ts
export interface Trip {
  id: string;
  name: string;
  /** Hex color from TRIP_COLORS (legacy "a"/"b"/"c" resolved via resolveTripColor). */
  color: string;
  status: "draft" | "scouting" | "confirmed";
  nodes: TripNode[];
  origin?: "agent" | "manual";
  estimate?: TripEstimate;
}
```

- Prune `LayerKey` to:

```ts
export type LayerKey =
  | "trips"
  | "routes"
  | "cities"
  | "weather"
  | "cost"
  | "conflict"
  | "disaster";
```

- [ ] **Step 6: Rewrite `src/store.ts`**

Full replacement (persistence via zustand middleware; index-based node ops; random colors; drawMode; pruned layers):

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { TRIP_COLORS, randomTripColor } from "./lib/tripColors";
import type {
  City,
  Trip,
  TripNode,
  TripOption,
  ShortlistEntry,
  TickerItem,
  CityMetrics,
  MeridianScore,
  MetricSurface,
  LayerKey,
} from "./types";

export interface CandidateFilters {
  maxBudget: number;
  maxStops: number;
  maxDays: number;
}

const DEFAULT_CANDIDATE_FILTERS: CandidateFilters = {
  maxBudget: 800,
  maxStops: 3,
  maxDays: 14,
};

export interface MeridianState {
  // Theme
  theme: "light" | "dark";
  themeWipe: { active: boolean; x: number; y: number; next: "light" | "dark" } | null;
  toggleTheme: (originX?: number, originY?: number) => void;
  clearThemeWipe: () => void;

  // Cities
  cities: City[];
  setCities: (cities: City[]) => void;

  // Selection
  selectedCityId: string | null;
  selectCity: (id: string | null) => void;

  // Drawers
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  toggleLeftDrawer: () => void;
  setRightDrawer: (open: boolean) => void;

  // Command palette overlay
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  toggleCommand: () => void;

  // Trips
  trips: Trip[];
  activeTripId: string | null;
  setActiveTrip: (id: string) => void;
  createTrip: (name?: string) => string;
  updateTripName: (tripId: string, name: string) => void;
  updateTripStatus: (tripId: string, status: Trip["status"]) => void;
  updateTripColor: (tripId: string, color: string) => void;
  addCityToTrip: (tripId: string, node: TripNode) => void;
  addCityToActiveTrip: (node: TripNode) => void;
  removeNodeAt: (tripId: string, index: number) => void;
  replaceNodeAt: (tripId: string, index: number, node: TripNode) => void;
  reorderTripNodes: (tripId: string, fromIndex: number, toIndex: number) => void;
  duplicateTrip: (tripId: string) => string;
  removeTrip: (id: string) => void;

  // On-globe route drawing
  drawMode: boolean;
  setDrawMode: (on: boolean) => void;

  // Agent-generated trip candidates
  candidateFilters: CandidateFilters;
  setCandidateFilters: (patch: Partial<CandidateFilters>) => void;
  setAgentCandidates: (options: TripOption[]) => void;
  confirmCandidate: (tripId: string) => void;
  discardAgentCandidates: () => void;

  // Overlay modals
  tripsOverlayOpen: boolean;
  setTripsOverlayOpen: (open: boolean) => void;
  toggleTripsOverlay: () => void;
  candidatesOverlayOpen: boolean;
  setCandidatesOverlayOpen: (open: boolean) => void;
  toggleCandidatesOverlay: () => void;

  // Layers
  layers: Record<LayerKey, boolean>;
  toggleLayer: (key: LayerKey) => void;

  // Metric surfaces cache
  surfaces: Record<string, MetricSurface>;
  setSurface: (id: string, surface: MetricSurface) => void;

  // Shortlist
  shortlist: ShortlistEntry[];
  setShortlist: (entries: ShortlistEntry[]) => void;
  addToShortlist: (entry: ShortlistEntry) => void;
  removeFromShortlist: (cityId: string) => void;

  // Ticker
  ticker: TickerItem[];
  setTicker: (items: TickerItem[]) => void;

  // City metrics cache
  cityMetrics: Record<string, CityMetrics>;
  setCityMetrics: (cityId: string, metrics: CityMetrics) => void;

  // Scores cache
  cityScores: Record<string, MeridianScore>;
  setCityScore: (cityId: string, score: MeridianScore) => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  trips: true,
  routes: true,
  cities: true,
  weather: false,
  cost: false,
  conflict: false,
  disaster: false,
};

export const useMeridianStore = create<MeridianState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: "light",
      themeWipe: null,
      toggleTheme: (originX, originY) =>
        set((state) => {
          const next = state.theme === "light" ? "dark" : "light";
          const x = originX ?? window.innerWidth / 2;
          const y = originY ?? window.innerHeight / 2;
          return { themeWipe: { active: true, x, y, next } };
        }),
      clearThemeWipe: () => set({ themeWipe: null }),

      // Cities
      cities: [],
      setCities: (cities) => set({ cities }),

      // Selection
      selectedCityId: null,
      selectCity: (id) => set({ selectedCityId: id, rightDrawerOpen: id !== null }),

      // Drawers
      leftDrawerOpen: false,
      rightDrawerOpen: false,
      toggleLeftDrawer: () => set((state) => ({ leftDrawerOpen: !state.leftDrawerOpen })),
      setRightDrawer: (open) => set({ rightDrawerOpen: open }),

      // Command palette overlay
      commandOpen: false,
      setCommandOpen: (open) => set({ commandOpen: open }),
      toggleCommand: () => set((state) => ({ commandOpen: !state.commandOpen })),

      // Trips
      trips: [],
      activeTripId: null,
      setActiveTrip: (id) => set({ activeTripId: id }),
      createTrip: (name) => {
        const id = `trip-${Date.now()}`;
        const state = get();
        const trip: Trip = {
          id,
          name: name ?? `TRIP ${state.trips.length + 1}`,
          color: randomTripColor(state.trips.map((t) => t.color)),
          status: "draft",
          nodes: [],
        };
        set((s) => ({ trips: [...s.trips, trip], activeTripId: id }));
        return id;
      },
      updateTripName: (tripId, name) =>
        set((state) => ({
          trips: state.trips.map((t) => (t.id === tripId ? { ...t, name } : t)),
        })),
      updateTripStatus: (tripId, status) =>
        set((state) => ({
          trips: state.trips.map((t) => (t.id === tripId ? { ...t, status } : t)),
        })),
      updateTripColor: (tripId, color) =>
        set((state) => ({
          trips: state.trips.map((t) => (t.id === tripId ? { ...t, color } : t)),
        })),
      addCityToTrip: (tripId, node) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId ? { ...t, nodes: [...t.nodes, node] } : t
          ),
        })),
      addCityToActiveTrip: (node) =>
        set((state) => {
          if (state.trips.some((t) => t.id === state.activeTripId)) {
            return {
              trips: state.trips.map((t) =>
                t.id === state.activeTripId ? { ...t, nodes: [...t.nodes, node] } : t
              ),
            };
          }
          const id = `trip-${Date.now()}`;
          const trip: Trip = {
            id,
            name: `TRIP ${state.trips.length + 1}`,
            color: randomTripColor(state.trips.map((t) => t.color)),
            status: "draft",
            nodes: [node],
          };
          return { trips: [...state.trips, trip], activeTripId: id };
        }),
      removeNodeAt: (tripId, index) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId
              ? { ...t, nodes: t.nodes.filter((_, i) => i !== index) }
              : t
          ),
        })),
      replaceNodeAt: (tripId, index, node) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId
              ? { ...t, nodes: t.nodes.map((n, i) => (i === index ? node : n)) }
              : t
          ),
        })),
      reorderTripNodes: (tripId, fromIndex, toIndex) =>
        set((state) => ({
          trips: state.trips.map((t) => {
            if (t.id !== tripId) return t;
            const nodes = [...t.nodes];
            const [moved] = nodes.splice(fromIndex, 1);
            nodes.splice(toIndex, 0, moved);
            return { ...t, nodes };
          }),
        })),
      duplicateTrip: (tripId) => {
        const id = `trip-${Date.now()}`;
        const state = get();
        const source = state.trips.find((t) => t.id === tripId);
        const dupe: Trip = source
          ? {
              id,
              name: `${source.name} COPY`,
              color: randomTripColor(state.trips.map((t) => t.color)),
              status: "draft",
              nodes: [...source.nodes],
            }
          : {
              id,
              name: "TRIP",
              color: randomTripColor([]),
              status: "draft",
              nodes: [],
            };
        set((s) => ({ trips: [...s.trips, dupe], activeTripId: id }));
        return id;
      },
      removeTrip: (id) =>
        set((state) => ({
          trips: state.trips.filter((t) => t.id !== id),
          activeTripId: state.activeTripId === id ? null : state.activeTripId,
        })),

      // On-globe route drawing
      drawMode: false,
      setDrawMode: (on) => set({ drawMode: on }),

      // Agent-generated trip candidates
      candidateFilters: DEFAULT_CANDIDATE_FILTERS,
      setCandidateFilters: (patch) =>
        set((state) => ({ candidateFilters: { ...state.candidateFilters, ...patch } })),
      setAgentCandidates: (options) =>
        set((state) => {
          const manualTrips = state.trips.filter((t) => t.origin !== "agent");
          const candidates: Trip[] = options.map((opt, i) => ({
            id: opt.id,
            name: opt.label,
            color: TRIP_COLORS[i % TRIP_COLORS.length],
            status: "draft",
            nodes: opt.nodes,
            origin: "agent",
            estimate: opt.estimate,
          }));
          return {
            trips: [...manualTrips, ...candidates],
            activeTripId: candidates[0]?.id ?? state.activeTripId,
          };
        }),
      confirmCandidate: (tripId) =>
        set((state) => ({
          trips: state.trips.map((t) =>
            t.id === tripId ? { ...t, origin: "manual", status: "scouting" } : t
          ),
        })),
      discardAgentCandidates: () =>
        set((state) => {
          const remaining = state.trips.filter((t) => t.origin !== "agent");
          const activeStillValid = remaining.some((t) => t.id === state.activeTripId);
          return {
            trips: remaining,
            activeTripId: activeStillValid ? state.activeTripId : null,
          };
        }),

      // Overlay modals
      tripsOverlayOpen: false,
      setTripsOverlayOpen: (open) => set({ tripsOverlayOpen: open }),
      toggleTripsOverlay: () =>
        set((state) => ({ tripsOverlayOpen: !state.tripsOverlayOpen })),
      candidatesOverlayOpen: false,
      setCandidatesOverlayOpen: (open) => set({ candidatesOverlayOpen: open }),
      toggleCandidatesOverlay: () =>
        set((state) => ({ candidatesOverlayOpen: !state.candidatesOverlayOpen })),

      // Layers
      layers: DEFAULT_LAYERS,
      toggleLayer: (key) =>
        set((state) => ({ layers: { ...state.layers, [key]: !state.layers[key] } })),

      // Metric surfaces cache
      surfaces: {},
      setSurface: (id, surface) =>
        set((state) => ({ surfaces: { ...state.surfaces, [id]: surface } })),

      // Shortlist
      shortlist: [],
      setShortlist: (entries) => set({ shortlist: entries }),
      addToShortlist: (entry) =>
        set((state) => ({ shortlist: [...state.shortlist, entry] })),
      removeFromShortlist: (cityId) =>
        set((state) => ({
          shortlist: state.shortlist.filter((s) => s.cityId !== cityId),
        })),

      // Ticker
      ticker: [],
      setTicker: (items) => set({ ticker: items }),

      // City metrics cache
      cityMetrics: {},
      setCityMetrics: (cityId, metrics) =>
        set((state) => ({
          cityMetrics: { ...state.cityMetrics, [cityId]: metrics },
        })),

      // Scores cache
      cityScores: {},
      setCityScore: (cityId, score) =>
        set((state) => ({
          cityScores: { ...state.cityScores, [cityId]: score },
        })),
    }),
    {
      name: "meridian-trips",
      partialize: (state) => ({
        trips: state.trips.filter((t) => t.origin !== "agent"),
        activeTripId: state.activeTripId,
      }),
    }
  )
);
```

- [ ] **Step 7: Update all `Trip["color"]` / `removeNodeFromTrip` / removed-layer consumers**

Run: `grep -rn "removeNodeFromTrip\|data-color\|Trip\[\"color\"\]\|COLOR_OPTIONS\|stability\|density\|tourism\|quality\|internet" src/ --include="*.tsx" --include="*.ts" | grep -v test`

Fix each hit:
- `src/components/TripCandidates.tsx` line ~228: replace
  `<span className={`candidate-color-bar`} data-color={c.color} />` with
  `<span className="candidate-color-bar" style={{ background: resolveTripColor(c.color) }} />`
  and add `import { resolveTripColor } from "../lib/tripColors";`.
- `src/components/TripCard.tsx`: same pattern for any `data-color` usage (`style={{ background: resolveTripColor(trip.color) }}` on the `.tg-bar` span).
- `src/components/CommandPalette.tsx`: prune `LAYER_COMMANDS` to
  `weather, cost, routes, cities, conflict, disaster` (remove stability/density/tourism).
- `src/components/BottomBar.tsx` still references old keys — it is deleted in Task 5; for now update its `LAYER_DEFS` to the pruned keys so typecheck passes (`routes, cities, weather, cost, conflict, disaster`).
- `src/components/Globe.tsx`: change `METRIC_LAYERS` to `["weather", "cost"] as const` and remove `density`, `tourism`, `stability` entries from `LAYER_COLORS` and `LAYER_LABELS`.
- `src/components/MetricPanels.tsx` / `src/components/RightDrawer.tsx` / `src/components/AgentBrief.tsx`: these reference `CityMetrics` fields (fine — unchanged), but if any reference removed `LayerKey`s, swap or delete those toggles.
- `src/components/TripsOverlay.tsx` still uses `removeNodeFromTrip` and `COLOR_OPTIONS` — it is rewritten in Task 7; as a stopgap, change `removeNodeFromTrip(trip.id, node.cityId)` to `removeNodeAt(trip.id, i)` and `COLOR_OPTIONS` to `TRIP_COLORS`-based rendering, or simply do Task 7 immediately after this task before typechecking. **Recommended order: apply Task 7's rewrite of TripsOverlay.tsx as part of making this task compile**, then Task 7 only handles CSS.

- [ ] **Step 8: Remove `data-color` CSS rules**

In `src/index.css` delete these rule blocks (the elements now get inline `background`):
- `.trip-card[data-color="a"] .tg-bar`, `[data-color="b"]`, `[data-color="c"]`
- `.tm-trip[data-color="a"] .tm-color-bar`, `"b"`, `"c"`
- `.tm-swatch.a`, `.tm-swatch.b`, `.tm-swatch.c`
- Any `.candidate-color-bar[data-color=…]` rules.

Keep `--trip-a/b/c` CSS vars (still used by status badges); do not delete them.

- [ ] **Step 9: Verify + commit**

```bash
bun run test && bun run typecheck
git add -A src/ && git commit -m "feat: hex trip colors with random assignment, index-based node ops, persisted trips, draw-mode state, pruned layers"
```

---

### Task 5: Layout — remove bottom bar, hash routing, nav

**Files:**
- Create: `src/lib/router.ts`
- Rewrite: `src/App.tsx`
- Delete: `src/components/BottomBar.tsx`
- Modify: `src/components/TopBar.tsx`, `src/components/LeftDrawer.tsx`

**Interfaces:**
- Produces (consumed by Task 6):
  - `type Route = { view: "globe" } | { view: "trips"; tripId?: string }`
  - `useRoute(): Route` — re-renders on hash change
  - `navigate(path: string): void` — e.g. `navigate("/trips")`, `navigate("/trips/trip-123")`, `navigate("/")`

- [ ] **Step 1: Implement `src/lib/router.ts`**

```ts
import { useSyncExternalStore } from "react";

export type Route = { view: "globe" } | { view: "trips"; tripId?: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const m = path.match(/^\/trips(?:\/([^/]+))?$/);
  if (m) return { view: "trips", tripId: m[1] };
  return { view: "globe" };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(path: string): void {
  window.location.hash = path === "/" ? "" : path;
}
```

- [ ] **Step 2: Rewrite `src/App.tsx`**

Two grid rows (top + center), no BottomBar; Globe always mounted; TripsPage layered over the center when routed:

```tsx
import { useEffect } from "react";
import { useMeridianStore } from "./store";
import { useRoute } from "./lib/router";
import TopBar from "./components/TopBar";
import LeftDrawer from "./components/LeftDrawer";
import RightDrawer from "./components/RightDrawer";
import Globe from "./components/Globe";
import CommandPalette from "./components/CommandPalette";
import TripCandidates from "./components/TripCandidates";
import TripsOverlay from "./components/TripsOverlay";
import ThemeWipe from "./components/ThemeWipe";
import TripsPage from "./pages/TripsPage";
import { apiUrl } from "./lib/api";

export default function App() {
  const { toggleLeftDrawer, setRightDrawer, toggleCommand, setDrawMode } =
    useMeridianStore();
  const route = useRoute();

  // Fetch initial data on mount
  useEffect(() => {
    fetch(apiUrl("/api/cities?limit=10000"))
      .then((r) => r.json())
      .then((data) => {
        const cities = data?.cities ?? data;
        if (Array.isArray(cities)) useMeridianStore.getState().setCities(cities);
      })
      .catch(() => {});

    fetch(apiUrl("/api/shortlist"))
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) useMeridianStore.getState().setShortlist(data);
      })
      .catch(() => {});
  }, []);

  // Keyboard listeners
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleCommand();
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "[") toggleLeftDrawer();
      if (e.key === "]") setRightDrawer(false);
      if (e.key === "Escape") setDrawMode(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleLeftDrawer, setRightDrawer, toggleCommand, setDrawMode]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gridTemplateRows: "44px minmax(0, 1fr)",
        gridTemplateAreas: `"top" "center"`,
      }}
    >
      <TopBar />
      <div
        style={{
          gridArea: "center",
          position: "relative",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        {/* Globe stays mounted across navigation to preserve the map instance */}
        <Globe />
        {route.view === "trips" && <TripsPage tripId={route.tripId} />}
      </div>
      <LeftDrawer />
      <RightDrawer />
      <CommandPalette />
      <TripCandidates />
      <TripsOverlay />
      <ThemeWipe />
    </div>
  );
}
```

Note: Task 6 creates `TripsPage`; to keep this task independently compilable, create a placeholder `src/pages/TripsPage.tsx` now:

```tsx
export default function TripsPage({ tripId }: { tripId?: string }) {
  void tripId;
  return <div className="trips-page">TRIPS</div>;
}
```

- [ ] **Step 3: Delete the bottom bar**

```bash
git rm src/components/BottomBar.tsx
```

- [ ] **Step 4: TopBar nav**

In `src/components/TopBar.tsx`, after the Brand `</div>` and before `<NewsTicker />`, insert:

```tsx
      {/* Nav */}
      <nav className="topbar-nav">
        <button
          className={`topnav-link ${route.view === "globe" ? "active" : ""}`}
          onClick={() => navigate("/")}
        >
          GLOBE
        </button>
        <button
          className={`topnav-link ${route.view === "trips" ? "active" : ""}`}
          onClick={() => navigate("/trips")}
        >
          TRIPS
        </button>
      </nav>
```

with imports `import { useRoute, navigate } from "../lib/router";` and `const route = useRoute();` inside the component. Add CSS to `src/index.css`:

```css
.topbar-nav {
  display: flex;
  align-items: stretch;
  border-right: 1px solid var(--hairline);
}
.topnav-link {
  border: none;
  background: transparent;
  padding: 0 16px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--ink3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.topnav-link:hover { color: var(--ink); }
.topnav-link.active {
  color: var(--ink);
  border-bottom-color: var(--ink);
  font-weight: 700;
}
```

- [ ] **Step 5: LeftDrawer — route to the trips page**

In `src/components/LeftDrawer.tsx`, import `{ navigate }` from `../lib/router` and change the "Open trips" button's onClick to:

```tsx
            onClick={() => {
              navigate("/trips");
              toggleLeftDrawer();
            }}
```

(keep the candidates button as-is; remove the now-unused `setTripsOverlayOpen` from the destructured store if unused).

- [ ] **Step 6: Verify + commit**

Run: `bun run typecheck` — expect PASS.
Run `bun run dev:all`, open http://localhost:5173: no bottom bar, top nav switches GLOBE/TRIPS placeholder, globe still renders. Then:

```bash
git add -A src/ && git commit -m "feat: remove bottom bar, add hash routing with GLOBE/TRIPS nav"
```

---

### Task 6: Dedicated Trips page (itinerary, legs, costs, booking links)

**Files:**
- Rewrite: `src/pages/TripsPage.tsx` (replace placeholder)
- Modify: `src/index.css` (trips page styles)

**Interfaces:**
- Consumes: store actions from Task 4 (`removeNodeAt`, `replaceNodeAt`, `addCityToTrip`, `reorderTripNodes`, `updateTripColor`, …), geo helpers from Task 1, `TRIP_COLORS`/`resolveTripColor`/`randomTripColor` from Task 4, `navigate` from Task 5.
- City search: local filter over `store.cities` (name / iata / airportName / country), airports-first.

- [ ] **Step 1: Implement the page**

Replace `src/pages/TripsPage.tsx` with:

```tsx
import { useMemo, useState } from "react";
import { useMeridianStore } from "../store";
import { navigate } from "../lib/router";
import {
  haversineKm,
  flightPath,
  estimateFlightHours,
  formatHours,
  estimateLegCostUSD,
} from "../lib/geo";
import { TRIP_COLORS, resolveTripColor, randomTripColor } from "../lib/tripColors";
import type { City, Trip, TripNode } from "../types";

const STATUS_OPTIONS: Trip["status"][] = ["draft", "scouting", "confirmed"];

function cityToNode(city: City): TripNode {
  return { cityId: city.id, name: city.name, iata: city.iata, lat: city.lat, lng: city.lng };
}

function flightsUrl(a: TripNode, b: TripNode): string {
  const q = `flights from ${a.iata ?? a.name} to ${b.iata ?? b.name}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function staysUrl(n: TripNode): string {
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(n.name)}`;
}

/** Airport-first search over the loaded city list. */
function searchLocal(cities: City[], q: string): City[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return cities
    .filter(
      (c) =>
        c.name.toLowerCase().includes(s) ||
        c.iata?.toLowerCase() === s ||
        c.airportName?.toLowerCase().includes(s) ||
        c.country.toLowerCase().startsWith(s)
    )
    .sort((a, b) => (b.iata ? 1 : 0) - (a.iata ? 1 : 0) || b.population - a.population)
    .slice(0, 8);
}

function CitySearchInput({
  cities,
  placeholder,
  onPick,
  autoFocus,
}: {
  cities: City[];
  placeholder: string;
  onPick: (c: City) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => searchLocal(cities, q), [cities, q]);
  return (
    <div className="tp-search">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {results.length > 0 && (
        <div className="tp-search-results">
          {results.map((c) => (
            <button
              key={c.id}
              className="tp-search-row"
              onClick={() => {
                onPick(c);
                setQ("");
              }}
            >
              <span className="tp-sr-iata">{c.iata ?? "—"}</span>
              <span className="tp-sr-name">{c.name}</span>
              <span className="tp-sr-country">{c.country}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TripsPage({ tripId }: { tripId?: string }) {
  const {
    trips,
    cities,
    createTrip,
    updateTripName,
    updateTripStatus,
    updateTripColor,
    addCityToTrip,
    removeNodeAt,
    replaceNodeAt,
    reorderTripNodes,
    duplicateTrip,
    removeTrip,
    setActiveTrip,
  } = useMeridianStore();

  const savedTrips = trips.filter((t) => t.origin !== "agent");
  const trip = savedTrips.find((t) => t.id === tripId) ?? savedTrips[0];
  const [replacingIndex, setReplacingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hubs = useMemo(
    () =>
      cities
        .filter((c) => c.hub === "large" && c.iata)
        .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! })),
    [cities]
  );

  const legs = useMemo(() => {
    if (!trip) return [];
    const out: {
      from: TripNode;
      to: TripNode;
      km: number;
      hours: number;
      cost: number;
      via?: string;
    }[] = [];
    for (let i = 0; i < trip.nodes.length - 1; i++) {
      const from = trip.nodes[i];
      const to = trip.nodes[i + 1];
      const path = flightPath([from.lng, from.lat], [to.lng, to.lat], hubs);
      out.push({
        from,
        to,
        km: Math.round(path.distanceKm),
        hours: estimateFlightHours(path.distanceKm),
        cost: estimateLegCostUSD(path.distanceKm),
        via: path.via,
      });
    }
    return out;
  }, [trip, hubs]);

  const totals = useMemo(
    () => ({
      km: legs.reduce((a, l) => a + l.km, 0),
      hours: legs.reduce((a, l) => a + l.hours, 0),
      cost: legs.reduce((a, l) => a + l.cost, 0),
    }),
    [legs]
  );

  const selectTrip = (id: string) => {
    setActiveTrip(id);
    navigate(`/trips/${id}`);
  };

  const origin = trip?.nodes[0];
  const last = trip?.nodes[trip.nodes.length - 1];
  const canReturn =
    trip && origin && trip.nodes.length >= 2 && last!.cityId !== origin.cityId;

  return (
    <div className="trips-page">
      {/* Left: trip list */}
      <aside className="tp-list">
        <div className="panel-head">
          <div className="h-title">TRIPS</div>
          <div className="h-meta">{savedTrips.length}</div>
        </div>
        <button className="tm-create-btn" onClick={() => selectTrip(createTrip())}>
          <span className="tm-plus">+</span> NEW TRIP
        </button>
        <div className="tp-list-items">
          {savedTrips.map((t) => (
            <button
              key={t.id}
              className={`tp-list-item ${trip?.id === t.id ? "active" : ""}`}
              onClick={() => selectTrip(t.id)}
            >
              <span
                className="tp-color-dot"
                style={{ background: resolveTripColor(t.color) }}
              />
              <span className="tp-li-name">{t.name}</span>
              <span className="tp-li-meta">{t.nodes.length} stops</span>
            </button>
          ))}
          {savedTrips.length === 0 && (
            <div className="tm-empty-state">No trips yet. Create one to start planning.</div>
          )}
        </div>
      </aside>

      {/* Right: itinerary detail */}
      {trip ? (
        <section className="tp-detail">
          <header className="tp-head">
            <input
              className="tp-name-input"
              value={trip.name}
              onChange={(e) => updateTripName(trip.id, e.target.value)}
            />
            <div className="tp-head-actions">
              <button className="tm-action-btn" onClick={() => duplicateTrip(trip.id)}>
                DUPLICATE
              </button>
              {confirmDelete ? (
                <>
                  <button
                    className="tm-action-btn tm-delete-confirm"
                    onClick={() => {
                      removeTrip(trip.id);
                      setConfirmDelete(false);
                      navigate("/trips");
                    }}
                  >
                    CONFIRM DELETE
                  </button>
                  <button className="tm-action-btn" onClick={() => setConfirmDelete(false)}>
                    CANCEL
                  </button>
                </>
              ) : (
                <button
                  className="tm-action-btn tm-delete-btn"
                  onClick={() => setConfirmDelete(true)}
                >
                  DELETE
                </button>
              )}
              <button
                className="tm-action-btn"
                onClick={() => {
                  setActiveTrip(trip.id);
                  navigate("/");
                }}
              >
                VIEW ON GLOBE ↗
              </button>
            </div>
          </header>

          {/* Color + status */}
          <div className="tp-controls">
            <div className="tp-control">
              <span className="tm-key">COLOR</span>
              <div className="tm-color-swatches">
                {TRIP_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`tm-swatch ${resolveTripColor(trip.color) === c ? "selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => updateTripColor(trip.id, c)}
                  />
                ))}
                <button
                  className="tm-swatch tm-swatch-random"
                  title="Random color"
                  onClick={() =>
                    updateTripColor(
                      trip.id,
                      randomTripColor(savedTrips.map((t) => t.color))
                    )
                  }
                >
                  ⚄
                </button>
              </div>
            </div>
            <div className="tp-control">
              <span className="tm-key">STATUS</span>
              <div className="tm-status-options">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    className={`tm-status-opt ${s} ${trip.status === s ? "selected" : ""}`}
                    onClick={() => updateTripStatus(trip.id, s)}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="tp-totals">
              <span>
                <span className="tm-key">DIST</span> {totals.km.toLocaleString()} km
              </span>
              <span>
                <span className="tm-key">AIR TIME</span> {formatHours(totals.hours)}
              </span>
              <span>
                <span className="tm-key">EST FLIGHTS</span> ~${totals.cost.toLocaleString()}
              </span>
              {trip.estimate && (
                <span>
                  <span className="tm-key">AGENT EST</span> ${trip.estimate.priceEstimate}
                </span>
              )}
            </div>
          </div>

          {/* Itinerary */}
          <div className="tp-itinerary">
            {trip.nodes.map((node, i) => (
              <div key={`${node.cityId}-${i}`}>
                <div className="tp-node">
                  <span className="tm-node-index">{i + 1}</span>
                  <span className="tm-node-iata">{node.iata ?? "???"}</span>
                  {replacingIndex === i ? (
                    <CitySearchInput
                      cities={cities}
                      placeholder={`Replace ${node.name}…`}
                      autoFocus
                      onPick={(c) => {
                        replaceNodeAt(trip.id, i, cityToNode(c));
                        setReplacingIndex(null);
                      }}
                    />
                  ) : (
                    <button
                      className="tp-node-name"
                      title="Click to replace this city"
                      onClick={() => setReplacingIndex(i)}
                    >
                      {node.name}
                    </button>
                  )}
                  <a
                    className="tp-link"
                    href={staysUrl(node)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    STAYS ↗
                  </a>
                  <span className="tp-node-actions">
                    <button
                      disabled={i === 0}
                      onClick={() => reorderTripNodes(trip.id, i, i - 1)}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      disabled={i === trip.nodes.length - 1}
                      onClick={() => reorderTripNodes(trip.id, i, i + 1)}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button onClick={() => removeNodeAt(trip.id, i)} title="Remove">
                      ✕
                    </button>
                  </span>
                </div>
                {i < legs.length && (
                  <div className="tp-leg">
                    <span className="tp-leg-line" />
                    <span>{legs[i].km.toLocaleString()} km</span>
                    <span>{formatHours(legs[i].hours)}</span>
                    <span>~${legs[i].cost}</span>
                    {legs[i].via && <span className="tp-leg-via">via {legs[i].via}</span>}
                    <a
                      className="tp-link"
                      href={flightsUrl(legs[i].from, legs[i].to)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      FLIGHTS ↗
                    </a>
                  </div>
                )}
              </div>
            ))}
            {trip.nodes.length === 0 && (
              <div className="tm-empty-nodes">
                Add cities to build the itinerary — legs, durations and costs appear here.
              </div>
            )}
          </div>

          {/* Add city + return leg */}
          <div className="tp-add-row">
            <CitySearchInput
              cities={cities}
              placeholder="Add a city or airport…"
              onPick={(c) => addCityToTrip(trip.id, cityToNode(c))}
            />
            {canReturn && (
              <button
                className="tm-add-btn"
                onClick={() => addCityToTrip(trip.id, origin!)}
              >
                ↩ RETURN TO {origin!.iata ?? origin!.name}
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="tp-detail tp-empty">
          <div className="tm-empty-state">Create a trip to start planning.</div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the page CSS**

Append to `src/index.css`:

```css
/* ── Trips page ─────────────────────────────────────────────── */
.trips-page {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: var(--bg);
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  overflow: hidden;
}
.tp-list {
  border-right: 1px solid var(--hairline2);
  overflow-y: auto;
  padding-bottom: 20px;
}
.tp-list .tm-create-btn { margin: 0 18px 10px; }
.tp-list-items { display: flex; flex-direction: column; gap: 4px; padding: 0 18px; }
.tp-list-item {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--hairline2);
  background: var(--paper);
  cursor: pointer;
  text-align: left;
}
.tp-list-item:hover { background: var(--bg2); }
.tp-list-item.active { border-color: var(--ink); box-shadow: 3px 3px 0 var(--ink); }
.tp-color-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.tp-li-name {
  font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: var(--ink);
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tp-li-meta { font-family: var(--mono); font-size: 10px; color: var(--ink3); }

.tp-detail { overflow-y: auto; padding: 22px 28px 60px; }
.tp-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.tp-name-input {
  font-family: var(--sans); font-size: 20px; font-weight: 700; letter-spacing: 0.06em;
  color: var(--ink); background: transparent;
  border: 1px solid transparent; border-bottom: 1px solid var(--hairline2);
  padding: 4px 2px; outline: none; min-width: 220px; flex: 1;
}
.tp-name-input:focus { border-color: var(--ink); }
.tp-head-actions { display: flex; gap: 6px; }

.tp-controls {
  display: flex; gap: 26px; flex-wrap: wrap; align-items: flex-start;
  padding: 12px 0 16px; border-bottom: 1px solid var(--hairline2); margin-bottom: 16px;
}
.tp-control { display: flex; flex-direction: column; gap: 6px; }
.tp-totals {
  display: flex; gap: 16px; flex-wrap: wrap; margin-left: auto;
  font-family: var(--mono); font-size: 11px; color: var(--ink2); align-self: center;
}
.tm-swatch-random {
  background: transparent; color: var(--ink2); font-size: 12px;
  display: flex; align-items: center; justify-content: center;
}
.tm-color-swatches { flex-wrap: wrap; max-width: 180px; }

.tp-itinerary { display: flex; flex-direction: column; max-width: 640px; }
.tp-node {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: 1px solid var(--hairline2); background: var(--paper);
}
.tp-node-name {
  border: none; background: transparent; text-align: left; cursor: text;
  font-size: 13px; color: var(--ink); flex: 1; padding: 0;
  border-bottom: 1px dashed transparent;
}
.tp-node-name:hover { border-bottom-color: var(--ink3); }
.tp-node-actions { display: flex; gap: 2px; }
.tp-node-actions button {
  width: 22px; height: 22px; border: 1px solid var(--hairline2); background: transparent;
  color: var(--ink3); cursor: pointer; font-size: 11px;
}
.tp-node-actions button:hover:not(:disabled) { color: var(--ink); border-color: var(--ink2); }
.tp-node-actions button:disabled { opacity: 0.3; cursor: default; }

.tp-leg {
  display: flex; align-items: center; gap: 14px;
  padding: 6px 10px 6px 30px;
  font-family: var(--mono); font-size: 10.5px; color: var(--ink2);
}
.tp-leg-line { width: 14px; border-top: 1px dashed var(--ink4); }
.tp-leg-via { color: var(--accent, #c2680c); font-weight: 700; }
.tp-link {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em;
  color: var(--ink2); text-decoration: none; border-bottom: 1px solid var(--hairline2);
}
.tp-link:hover { color: var(--ink); border-color: var(--ink); }

.tp-add-row { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; max-width: 640px; }
.tp-search { position: relative; flex: 1; }
.tp-search input {
  width: 100%; padding: 8px 10px; font-size: 12px; font-family: var(--sans);
  background: var(--paper); border: 1px solid var(--hairline2); color: var(--ink); outline: none;
}
.tp-search input:focus { border-color: var(--ink); }
.tp-search-results {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 5;
  background: var(--paper); border: 1px solid var(--ink);
  max-height: 240px; overflow-y: auto;
}
.tp-search-row {
  display: flex; gap: 10px; align-items: baseline; width: 100%;
  padding: 7px 10px; border: none; background: transparent; cursor: pointer; text-align: left;
}
.tp-search-row:hover { background: var(--bg2); }
.tp-sr-iata { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--ink); min-width: 32px; }
.tp-sr-name { font-size: 12px; color: var(--ink); flex: 1; }
.tp-sr-country { font-size: 10px; color: var(--ink3); }
.tp-empty { display: flex; align-items: center; justify-content: center; }
```

- [ ] **Step 3: Verify in the browser**

Run `bun run dev:all`; navigate to `#/trips`: create a trip, add AKL then LHR — the leg row must show ~18,000+ km total **with a "via …" tag**; add HNL after AKL — distance ~7,060 km, no via. Click a node name → replace works. Add the origin again via "↩ RETURN TO …". Reload the page → trips persist.

- [ ] **Step 4: Typecheck + commit**

```bash
bun run typecheck
git add src/pages/TripsPage.tsx src/index.css
git commit -m "feat: dedicated trips page with legs, durations, cost estimates, booking links, replace/return airports"
```

---### Task 7: Trip modal (TripsOverlay) — return airports, replace-by-rename, color grid, spacing

**Files:**
- Rewrite: `src/components/TripsOverlay.tsx`
- Modify: `src/index.css` (modal spacing fixes)

**Interfaces:**
- Consumes: store from Task 4, `TRIP_COLORS`/`resolveTripColor`/`randomTripColor`, `navigate` from Task 5.

Note: if Task 4 Step 7 already applied this rewrite to make the build compile, this task is only the CSS + verification.

- [ ] **Step 1: Rewrite `src/components/TripsOverlay.tsx`**

Same structure as the current file with these exact changes (keep everything else identical):

1. Imports: add `import { TRIP_COLORS, resolveTripColor, randomTripColor } from "../lib/tripColors";` and `import { navigate } from "../lib/router";`. Delete `const COLOR_OPTIONS: Trip["color"][] = ["a", "b", "c"];`.
2. Destructure `removeNodeAt` and `replaceNodeAt` from the store instead of `removeNodeFromTrip`.
3. State: add `const [replacingIndex, setReplacingIndex] = useState<{ tripId: string; index: number } | null>(null);`
4. **Color bar:** on the `.tm-trip` div remove `data-color={trip.color}` and render the bar as
   `<div className="tm-color-bar" style={{ background: resolveTripColor(trip.color) }} />`.
5. **City picker no longer filters trip members** (return airports): in the picker results, delete the
   `.filter((c) => !trip.nodes.some((n) => n.cityId === c.id))` on both the map and the empty-check, using `filteredCities` directly.
6. **Node removal by index:** `onClick={() => removeNodeAt(trip.id, i)}`.
7. **Replace-by-rename on a node:** make `.tm-node-name` clickable; when clicked set `replacingIndex`; while replacing, render an inline search input (reuse the same `citySearch`/`filteredCities` pattern) whose option click calls
   `replaceNodeAt(trip.id, replacingIndex.index, node)` and clears `replacingIndex`:

```tsx
{replacingIndex?.tripId === trip.id && replacingIndex.index === i ? (
  <span className="tm-replace-wrap">
    <input
      className="tm-city-search"
      placeholder={`Replace ${node.name}…`}
      value={citySearch}
      onChange={(e) => setCitySearch(e.target.value)}
      autoFocus
      onKeyDown={(e) => {
        if (e.key === "Escape") { setReplacingIndex(null); setCitySearch(""); }
      }}
    />
    {citySearch.trim().length >= 2 && (
      <span className="tm-replace-results">
        {filteredCities.map((city) => (
          <button
            key={city.id}
            className="tm-city-option"
            onClick={() => {
              replaceNodeAt(trip.id, i, {
                cityId: city.id, name: city.name, iata: city.iata,
                lat: city.lat, lng: city.lng,
              });
              setReplacingIndex(null);
              setCitySearch("");
            }}
          >
            <span className="tm-co-iata">{city.iata || "—"}</span>
            <span className="tm-co-name">{city.name}</span>
          </button>
        ))}
      </span>
    )}
  </span>
) : (
  <span
    className="tm-node-name tm-node-name-clickable"
    title="Click to replace this city"
    onClick={() => { setReplacingIndex({ tripId: trip.id, index: i }); setCitySearch(""); }}
  >
    {node.name}
  </span>
)}
```

8. **Color picker:** replace the three-swatch block with:

```tsx
<div className="tm-color-swatches">
  {TRIP_COLORS.map((c) => (
    <button
      key={c}
      className={`tm-swatch ${resolveTripColor(trip.color) === c ? "selected" : ""}`}
      style={{ background: c }}
      onClick={() => updateTripColor(trip.id, c)}
      title={c}
    />
  ))}
  <button
    className="tm-swatch tm-swatch-random"
    title="Random color"
    onClick={() =>
      updateTripColor(trip.id, randomTripColor(savedTrips.map((t) => t.color)))
    }
  >
    ⚄
  </button>
</div>
```

9. **Return-to-origin button** next to `+ ADD CITY` (only when applicable):

```tsx
{trip.nodes.length >= 2 &&
  trip.nodes[trip.nodes.length - 1].cityId !== trip.nodes[0].cityId && (
    <button
      className="tm-add-btn"
      onClick={() => addCityToTrip(trip.id, trip.nodes[0])}
    >
      ↩ RETURN TO {trip.nodes[0].iata ?? trip.nodes[0].name}
    </button>
  )}
```

10. **Link to the full page** in the panel head, next to the close button:

```tsx
<button
  className="tm-action-btn"
  onClick={() => { close(); navigate(trip ? `/trips/${trip.id}` : "/trips"); }}
  title="Open full trips page"
>
  FULL PAGE ↗
</button>
```

(place a `FULL PAGE ↗` per-trip action in `.tm-actions` instead if cleaner: `onClick={() => { close(); navigate(`/trips/${trip.id}`); }}`.)

- [ ] **Step 2: Modal spacing/styling fixes in `src/index.css`**

- `.tm-controls-row { display: flex; gap: 16px; margin-bottom: 10px; }` → add `flex-wrap: wrap; row-gap: 10px;`
- `.tm-color-swatches` → add `flex-wrap: wrap; max-width: 200px;` (if not added in Task 6).
- `.trips-overlay-panel` → ensure `max-height: 78vh; display: flex; flex-direction: column;` and `.trips-overlay-list { overflow-y: auto; flex: 1; }` so long trips scroll instead of overflowing.
- `.tm-trip-detail` → change padding to `10px 12px 14px 14px` for breathing room.
- `.tm-add-city { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }`
- Add:

```css
.tm-node-name-clickable { cursor: text; border-bottom: 1px dashed transparent; }
.tm-node-name-clickable:hover { border-bottom-color: var(--ink3); }
.tm-replace-wrap { position: relative; flex: 1; }
.tm-replace-results {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 6;
  background: var(--paper); border: 1px solid var(--ink);
  max-height: 180px; overflow-y: auto; display: block;
}
.tm-replace-results .tm-city-option { display: flex; width: 100%; border: none; background: transparent; }
```

- [ ] **Step 3: Verify in the browser**

Open the modal (LeftDrawer → candidates still works; open trips modal from the trips page or keep a launcher): create a trip AKL → HNL → AKL (origin re-addable), replace HNL by clicking its name and typing "Honolulu"→ pick, recolor with the 12-swatch grid + dice, delete a middle node only (index-based). No overflowing/cramped layout at 10+ nodes.

- [ ] **Step 4: Typecheck + commit**

```bash
bun run typecheck
git add src/components/TripsOverlay.tsx src/index.css
git commit -m "fix: trip modal — return airports, index-based ops, replace-by-rename, 12-color picker, spacing"
```

---

### Task 8: Globe — real flight paths, label readability, capital/hub prominence, draw mode, layer control

**Files:**
- Modify: `src/components/Globe.tsx`
- Modify: `src/index.css` (draw-mode + layers control styles)

**Interfaces:**
- Consumes: `flightPath`, `haversineKm` from Task 1; `resolveTripColor` from Task 4; store `drawMode`/`setDrawMode`/`addCityToActiveTrip` from Task 4.

All edits are to `src/components/Globe.tsx` unless stated.

- [ ] **Step 1: Swap imports + prune metric layers**

- Replace `import { conflictFeatures, disasterFeatures, greatCircle } from "../lib/phenomena";` with:

```ts
import { conflictFeatures, disasterFeatures } from "../lib/phenomena";
import { flightPath, haversineKm } from "../lib/geo";
import { resolveTripColor } from "../lib/tripColors";
```

- `METRIC_LAYERS` → `["weather", "cost"] as const`; prune `LAYER_COLORS` and `LAYER_LABELS` to those two keys (done in Task 4 Step 7 if already applied — verify).

- [ ] **Step 2: Capital/hub feature props + prominent styling**

In `cityFeatures` properties add:

```ts
            capital: !!city.capital,
            hub: city.hub ?? "",
```

Add constants near `LAYER_COLORS`:

```ts
// Capitals and major connectivity hubs render prominently.
const CAPITAL_COLOR = "#b3261e";
const HUB_COLOR = "#1a6f8f";
```

In the `map.on("load")` block, change the `city-circles` layer paint to:

```ts
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["get", "selected"], false], 7,
            ["boolean", ["get", "capital"], false], 5.5,
            ["==", ["get", "hub"], "large"], 5,
            4,
          ],
          "circle-color": [
            "case",
            ["boolean", ["get", "capital"], false], CAPITAL_COLOR,
            ["==", ["get", "hub"], "large"], HUB_COLOR,
            getCSSVar("--ink") || "#1c1814",
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": getCSSVar("--bg") || "#f4ecd8",
          "circle-opacity": 0.9,
        },
```

After the existing `city-labels` layer, add a major-city name layer visible from low zoom:

```ts
      map.addLayer({
        id: "city-labels-major",
        type: "symbol",
        source: "city-points",
        minzoom: 1.5,
        filter: ["any", ["boolean", ["get", "capital"], false], ["==", ["get", "hub"], "large"]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 11,
          "text-offset": [0.9, -0.7],
          "text-anchor": "left",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": [
            "case",
            ["boolean", ["get", "capital"], false], CAPITAL_COLOR,
            HUB_COLOR,
          ],
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 1.6,
        },
      });
```

Update the two effects that touch label/circle theming and visibility to include `city-labels-major` (theme repaint: set its halo to `bg`; city layer toggle: toggle its visibility too). In the `hasMetric` non-metric else-branch, restore the capital/hub `circle-color` **expression** above instead of plain ink (copy the same expression), so toggling metrics off keeps prominence.

- [ ] **Step 3: Route endpoint label readability**

The complaint: colored text + pale halo is unreadable. Make labels ink-on-bg (the colored endpoint dot already encodes the trip), larger halo. In the `route-endpoint-labels` layer, change paint to:

```ts
        paint: {
          "text-color": getCSSVar("--ink") || "#1c1814",
          "text-halo-color": getCSSVar("--bg") || "#f4ecd8",
          "text-halo-width": 2,
        },
```

and layout `"text-size": 12`. In the theme-repaint effect add:

```ts
      if (map.getLayer("route-endpoint-labels")) {
        map.setPaintProperty("route-endpoint-labels", "text-color", ink);
        map.setPaintProperty("route-endpoint-labels", "text-halo-color", bg);
      }
      if (map.getLayer("city-labels-major")) {
        map.setPaintProperty("city-labels-major", "text-halo-color", bg);
      }
```

- [ ] **Step 4: Hub-routed, antimeridian-safe trip arcs**

In the routes effect, first build the hub list (before the `for (const trip of trips)` loop):

```ts
      const hubList = useMeridianStore
        .getState()
        .cities.filter((c) => c.hub === "large" && c.iata)
        .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! }));
```

Replace the trip-color mapping block:

```ts
      const colorMap: Record<string, string> = { … };
      …
        const color = colorMap[trip.color] || colorMap.a;
```

with:

```ts
        const color = resolveTripColor(trip.color);
```

(delete `colorMap` entirely). Replace the per-leg feature push with one feature **per path segment**:

```ts
        for (let i = 0; i < trip.nodes.length - 1; i++) {
          const a = trip.nodes[i];
          const b = trip.nodes[i + 1];
          const path = flightPath([a.lng, a.lat], [b.lng, b.lat], hubList);
          for (const seg of path.segments) {
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: seg },
              properties: { color, active: isActive, suggested: isCandidate },
            });
          }
        }
```

For the shortlist suggested arcs, replace `greatCircle(...)` with `flightPath(...)` similarly (single-segment behavior is automatic for short legs):

```ts
        for (const seg of flightPath([a.lng, a.lat], [b.lng, b.lat], hubList).segments) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: seg },
            properties: { color: accent, active: false, suggested: true },
          });
        }
```

- [ ] **Step 5: Draw mode (click globe → snap to nearest airport city)**

Add to the destructured store in `Globe()`: `drawMode`, plus actions via getState in handlers. After the fly-to effect, add:

```ts
  // ── Draw mode: click the globe to append the nearest airport city ─
  const drawMode = useMeridianStore((s) => s.drawMode);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode ? "crosshair" : "";
    if (!drawMode) {
      const src = map.getSource("draw-preview") as maplibregl.GeoJSONSource | null;
      if (src) src.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    const nearestAirportCity = (lng: number, lat: number) => {
      const cs = useMeridianStore.getState().cities;
      let best: { c: (typeof cs)[number]; d: number } | null = null;
      for (const c of cs) {
        if (!c.iata) continue;
        const d = haversineKm([lng, lat], [c.lng, c.lat]);
        if (!best || d < best.d) best = { c, d };
      }
      return best && best.d <= 500 ? best.c : null;
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const c = nearestAirportCity(e.lngLat.lng, e.lngLat.lat);
      if (!c) return;
      useMeridianStore.getState().addCityToActiveTrip({
        cityId: c.id, name: c.name, iata: c.iata, lat: c.lat, lng: c.lng,
      });
    };

    let raf = 0;
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const state = useMeridianStore.getState();
        const trip = state.trips.find((t) => t.id === state.activeTripId);
        const last = trip?.nodes[trip.nodes.length - 1];
        const src = map.getSource("draw-preview") as maplibregl.GeoJSONSource | null;
        if (!src || !last) return;
        src.setData({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: flightPath(
                  [last.lng, last.lat],
                  [e.lngLat.lng, e.lngLat.lat]
                ).segments[0],
              },
              properties: {},
            },
          ],
        });
      });
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [drawMode]);
```

In `map.on("load")`, register the preview source/layer (after the routes layers):

```ts
      map.addSource("draw-preview", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "draw-preview-line",
        type: "line",
        source: "draw-preview",
        paint: {
          "line-color": getCSSVar("--accent") || "#c2680c",
          "line-width": 1.6,
          "line-dasharray": [2, 2],
          "line-opacity": 0.8,
        },
      });
```

Guard the existing `city-circles` click handler so selecting doesn't fire while drawing:

```ts
    map.on("click", "city-circles", (e) => {
      if (useMeridianStore.getState().drawMode) return;
      const f = e.features?.[0];
      if (f?.properties?.id)
        useMeridianStore.getState().selectCity(f.properties.id as string);
    });
```

- [ ] **Step 6: Draw-mode button + compact layers control (replaces bottom bar toggles)**

In the returned JSX, next to `.zoom-ctrl`, add:

```tsx
      <div className="globe-tools">
        <button
          className={`globe-tool ${drawMode ? "on" : ""}`}
          onClick={() => useMeridianStore.getState().setDrawMode(!drawMode)}
          title="Draw a route: click cities on the globe (esc to exit)"
        >
          ✎ DRAW ROUTE
        </button>
        <LayersControl />
      </div>
      {drawMode && (
        <div className="draw-banner">
          DRAW MODE — click the globe to add the nearest airport · esc to exit
        </div>
      )}
```

Add the `LayersControl` component at the bottom of `Globe.tsx`:

```tsx
const GLOBE_LAYERS: { key: LayerKey; label: string }[] = [
  { key: "routes", label: "ROUTES" },
  { key: "cities", label: "CITIES" },
  { key: "weather", label: "WEATHER" },
  { key: "cost", label: "COST" },
  { key: "conflict", label: "CONFLICT" },
  { key: "disaster", label: "DISASTER" },
];

function LayersControl() {
  const { layers, toggleLayer } = useMeridianStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="layers-ctrl">
      <button className={`globe-tool ${open ? "on" : ""}`} onClick={() => setOpen(!open)}>
        ◍ LAYERS
      </button>
      {open && (
        <div className="layers-pop">
          {GLOBE_LAYERS.map(({ key, label }) => (
            <button
              key={key}
              className={`layers-item ${layers[key] ? "on" : ""}`}
              onClick={() => toggleLayer(key)}
            >
              <span className="layers-dot" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

(add `LayerKey` to the type imports from `../types`.)

Append CSS to `src/index.css`:

```css
/* ── Globe tools (draw mode + layers) ───────────────────────── */
.globe-tools {
  position: absolute; top: 14px; right: 14px; z-index: 5;
  display: flex; gap: 6px; align-items: flex-start;
}
.globe-tool {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  padding: 6px 10px; border: 1px solid var(--hairline2);
  background: var(--bg); color: var(--ink2); cursor: pointer;
}
.globe-tool:hover { color: var(--ink); border-color: var(--ink2); }
.globe-tool.on { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.layers-ctrl { position: relative; }
.layers-pop {
  position: absolute; top: 100%; right: 0; margin-top: 4px;
  background: var(--bg); border: 1px solid var(--ink);
  display: flex; flex-direction: column; min-width: 130px; z-index: 6;
}
.layers-item {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em;
  padding: 7px 10px; border: none; background: transparent;
  color: var(--ink3); cursor: pointer; text-align: left;
}
.layers-item:hover { background: var(--bg2); color: var(--ink); }
.layers-item .layers-dot {
  width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--ink3);
}
.layers-item.on { color: var(--ink); font-weight: 700; }
.layers-item.on .layers-dot { background: var(--good, #2e7d32); border-color: transparent; }
.draw-banner {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 5;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  padding: 6px 12px; background: var(--ink); color: var(--bg);
}
```

If `.globe-tools` collides with the existing `.ga-tr` annotation, move `.ga-tr` down (`top: 60px`) in CSS.

- [ ] **Step 7: Verify in the browser**

`bun run dev:all`, then check each:
1. Trip AKL→HNL: single clean arc across the Pacific, **no full-world horizontal line**.
2. Trip AKL→LHR: two arcs meeting at a hub (LAX/SIN/similar), **not over the North Pole**.
3. Capitals (Madrid, London) render red with names at zoom ≥ 1.5; large hubs render petrol blue.
4. Endpoint IATA labels readable in both themes (toggle DAY/NIGHT).
5. DRAW ROUTE: click near Penang → PEN node appended to active trip; dashed preview follows the cursor; esc exits.
6. LAYERS popover toggles routes/cities/weather/cost/conflict/disaster.

- [ ] **Step 8: Typecheck + commit**

```bash
bun run typecheck
git add src/components/Globe.tsx src/index.css
git commit -m "feat: globe — hub-routed antimeridian-safe arcs, capital/hub prominence, readable labels, draw mode, layers control"
```

---

### Task 9: Final sweep — dead code, full verification

**Files:**
- Modify: whatever the greps below surface
- Verify: whole app

- [ ] **Step 1: Dead-reference sweep**

```bash
grep -rn "BottomBar\|iata_map\|removeNodeFromTrip\|COLOR_OPTIONS\|data-color" src/ server/ --include="*.ts" --include="*.tsx"
grep -rn "\"stability\"\|\"density\"\|\"tourism\"\|\"quality\"\|\"internet\"" src/ --include="*.tsx" --include="*.ts" | grep -v CityMetrics | grep -v Metric
```

Expected: no hits (fix any). `server/routes/metrics.ts` may still serve removed surfaces — leave the server route (harmless) but nothing in `src/` may request the removed layer keys.

- [ ] **Step 2: Full test + typecheck + build**

```bash
bun run test
bun run typecheck
bun run build
```

Expected: all pass. Fix regressions before proceeding.

- [ ] **Step 3: End-to-end verification checklist (dev server)**

Run `bun run dev:all` and confirm against the original bug list:

| # | Requirement | Check |
|---|---|---|
| 1 | Bottom bar removed | No bottom strip; globe fills below top bar |
| 2 | Dedicated trips route | `#/trips` full page; deep link `#/trips/<id>` works on reload |
| 3 | Penang supported | ⌘K "penang" → PEN result, addable to trip |
| 4 | Color picker | New trips get random colors; 12 swatches + dice in modal & page |
| 5 | Draw routes on globe | DRAW ROUTE snaps clicks to nearest airport city |
| 6 | Las Palmas IATA | ⌘K "las palmas" → LPA |
| 7 | Country search → airports | ⌘K "spain" → Madrid first, Spanish airport cities listed |
| 8 | Capitals/hubs prominent | Distinct colors + early labels on globe |
| 9 | Trips off bottom bar | Trip inspector gone; modal + page instead |
| 10 | Replace city by renaming | Click node name in modal/page → search → swap in place |
| 11 | Label readability | Endpoint labels ink-on-bg in both themes |
| 12 | Modal styling | No cramped/overflowing modal at 10+ nodes |
| 13 | Antimeridian glitch | AKL→HNL arc clean |
| 14 | LAX geocoding | Search "Los Angeles" → US entry has LAX; Chile entry doesn't |
| 15 | Return airports | Last node can repeat the origin ("RETURN TO AKL") |
| 16 | Realistic paths | AKL→LHR shows "via <hub>", no polar route |

- [ ] **Step 4: Commit any fixes and finish the branch**

```bash
git add -A && git commit -m "chore: final sweep for meridian overhaul"
```

Then use superpowers:finishing-a-development-branch to merge/PR `feat/meridian-overhaul`.

## Self-Review Notes

- **Spec coverage:** all 16 user items map to tasks (see Task 9 table); the only deferred item is basemap granularity, recorded under Global Constraints as agreed.
- **Type consistency:** `LngLat`/`FlightHub`/`flightPath` signatures match between Task 1 (definition) and Tasks 6/8 (consumers); store action names (`removeNodeAt`, `replaceNodeAt`, `addCityToTrip`) match between Task 4 and Tasks 6/7; `resolveTripColor` usage is uniform.
- **Known risk:** Task 2 requires network access to OurAirports/restcountries; the task says to STOP and report if unreachable rather than fabricate data. Task 3's Chile-slug assertion includes a diagnostic fallback step.
