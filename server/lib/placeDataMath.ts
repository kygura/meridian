// Pure maths shared by scripts/build-place-data.ts (which builds data/country-data.json and
// data/city-data.json) and server/lib/placeData.ts (which scores from them). No I/O.
// Every scale here is written down in docs/adr/0013-real-place-data.md.

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

/** Position of `x` between `lo` and `hi` on a log scale, as 0-100 (clamped). */
export function logScale(x: number, lo: number, hi: number): number {
  if (!(x > 0)) return 0;
  return Math.round(clamp(((Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100));
}

/** Monthly cost for one person, EUR -> affordability 0-100. EUR 600 or less is 100, EUR 4,500 or more is 0. */
export const COST_FLOOR_EUR = 600;
export const COST_CEIL_EUR = 4500;
export function affordabilityScore(monthlyEur: number): number {
  return 100 - logScale(monthlyEur, COST_FLOOR_EUR, COST_CEIL_EUR);
}

/** Download speed in Mbps -> 0-100. 5 Mbps or less is 0, 300 Mbps or more is 100. */
export const SPEED_FLOOR_MBPS = 5;
export const SPEED_CEIL_MBPS = 300;
export function speedScore(downMbps: number): number {
  return logScale(downMbps, SPEED_FLOOR_MBPS, SPEED_CEIL_MBPS);
}

/** World Bank political stability estimate (about -2.5 to +2.5) -> 0-100, linear. */
export function stabilityScore(estimate: number): number {
  return Math.round(clamp(((estimate + 2.5) / 5) * 100));
}

/** International arrivals per resident per year -> 0-100. 0.01 or less is 0, 5 or more is 100. */
export const ARRIVALS_FLOOR = 0.01;
export const ARRIVALS_CEIL = 5;
export function tourismScore(arrivalsPerResident: number): number {
  return logScale(arrivalsPerResident, ARRIVALS_FLOOR, ARRIVALS_CEIL);
}

const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Twelve monthly totals for several years -> one seasonal index per month, where 100 is that
 * place's average month. Each year is first turned into per-day rates relative to its own mean
 * (so growth between years doesn't matter), then the median across years is taken per month
 * (so one freak month doesn't either) and the result is rescaled to average 100.
 * Years with a missing or zero month are skipped. Returns null with fewer than `minYears` usable years.
 */
export function seasonalIndex(years: (number | null | undefined)[][], minYears = 2): number[] | null {
  const rel: number[][] = [];
  for (const y of years) {
    if (y.length !== 12 || y.some((v) => v === null || v === undefined || !(v > 0))) continue;
    const perDay = (y as number[]).map((v, i) => v / DAYS[i]!);
    const mean = perDay.reduce((a, b) => a + b, 0) / 12;
    rel.push(perDay.map((v) => v / mean));
  }
  if (rel.length < minYears) return null;
  const med = Array.from({ length: 12 }, (_, m) => {
    const col = rel.map((r) => r[m]!).sort((a, b) => a - b);
    const h = col.length >> 1;
    return col.length % 2 ? col[h]! : (col[h - 1]! + col[h]!) / 2;
  });
  const mean = med.reduce((a, b) => a + b, 0) / 12;
  return med.map((v) => Math.round((v / mean) * 100));
}

/**
 * How busy a month is next to the place's own year, 0-100: its quietest month maps to 0 and
 * its busiest to 100. Places whose busiest month is under 1.5x their quietest are scaled as
 * if it were 1.5x, so a flat year stays near 50 instead of swinging end to end.
 */
export function monthBusyness(index: number[], month: number): number {
  const lo = Math.min(...index);
  const hi = Math.max(...index);
  const mid = (hi + lo) / 2;
  const span = Math.max(hi - lo, lo * 0.5);
  if (!(span > 0)) return 50;
  return Math.round(clamp(50 + ((index[month - 1]! - mid) / span) * 100));
}

/** Pearson correlation of two equal-length series; null when either is flat. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

export type Ring = [number, number][];

/** Even-odd test: is (lng, lat) inside the ring? */
export function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point inside a GeoJSON Polygon / MultiPolygon coordinate array (outer ring minus holes)? */
export function inPolygons(lng: number, lat: number, polygons: Ring[][]): boolean {
  for (const poly of polygons) {
    if (!poly[0] || !inRing(lng, lat, poly[0])) continue;
    if (!poly.slice(1).some((hole) => inRing(lng, lat, hole))) return true;
  }
  return false;
}

/** Centre of a Bing/Ookla quadkey tile as [lng, lat]. */
export function quadkeyCentre(quadkey: string): [number, number] {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = 0; i < z; i++) {
    const d = quadkey.charCodeAt(i) - 48;
    x = (x << 1) | (d & 1);
    y = (y << 1) | (d >> 1);
  }
  const n = 2 ** z;
  const lng = ((x + 0.5) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI;
  return [lng, lat];
}

/** Radius around a city centre whose speed-test tiles count as that city, by population. */
export function cityRadiusKm(population: number): number {
  if (population >= 1_000_000) return 20;
  if (population >= 100_000) return 10;
  return 5;
}

/** Running test-weighted mean of tile averages. */
export interface SpeedAcc {
  tests: number;
  tiles: number;
  down: number;
  up: number;
  latency: number;
}
export const emptySpeedAcc = (): SpeedAcc => ({ tests: 0, tiles: 0, down: 0, up: 0, latency: 0 });
export function addTile(acc: SpeedAcc, tile: { tests: number; downKbps: number; upKbps: number; latencyMs: number }): void {
  if (!(tile.tests > 0)) return;
  acc.tests += tile.tests;
  acc.tiles += 1;
  acc.down += tile.downKbps * tile.tests;
  acc.up += tile.upKbps * tile.tests;
  acc.latency += tile.latencyMs * tile.tests;
}
/** Minimum speed tests for a city figure; fewer is treated as no data. */
export const MIN_SPEED_TESTS = 30;
export function finishSpeed(acc: SpeedAcc): { down: number; up: number; latency: number; tests: number; tiles: number } | null {
  if (acc.tests < MIN_SPEED_TESTS) return null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    down: r1(acc.down / acc.tests / 1000),
    up: r1(acc.up / acc.tests / 1000),
    latency: Math.round(acc.latency / acc.tests),
    tests: acc.tests,
    tiles: acc.tiles,
  };
}
