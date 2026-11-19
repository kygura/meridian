// Climate seasons (ADR 0021), computed from each city's monthly normals (server/lib/seasonality.ts)
// at read time, with no network and nothing stored. A rule, not a list: every city with
// normals is tested the same way.
//
//   Rainy season  months with at least 1.8 times the city's monthly mean precipitation and at least 120 mm
//   Dry season    only where a rainy season exists: months at or under 0.3 times the monthly mean
//   Snow season   months with a mean temperature at or under 0 C and at least 20 mm precipitation
//
// Each is the longest run of consecutive months (wrapping the year; the wetter run on a tie).

import type { City } from "../../../src/types.js";
import { orderMonths } from "../../../src/lib/eventKinds.js";
import type { StoredEvent } from "./common.js";

export const RAINY_FACTOR = 1.8;
export const RAINY_MIN_MM = 120;
export const DRY_FACTOR = 0.3;
export const SNOW_MAX_TEMP_C = 0;
export const SNOW_MIN_MM = 20;

export interface MonthNormal {
  tempC: number;
  precipMm: number;
}

export interface ClimateSeasonInputs {
  cities: City[];
  /** The 12 monthly normals, January first, when the city has them. */
  normals(cityId: string): MonthNormal[] | undefined;
}

export interface ClimateSeasonResult {
  events: StoredEvent[];
  citiesWithNormals: number;
  rainy: number;
  dry: number;
  snow: number;
}

/** The longest run of true months (wrapping the year), the one with the larger `weight` sum on a tie. Undefined when none or all months are true. */
export function longestRun(flags: boolean[], weight: number[]): number[] | undefined {
  if (flags.length !== 12 || flags.every((f) => !f) || flags.every((f) => f)) return undefined;
  let best: { months: number[]; w: number } | undefined;
  for (let start = 0; start < 12; start++) {
    if (!flags[start] || flags[(start + 11) % 12]) continue;
    const months: number[] = [];
    for (let i = start; flags[i % 12] && months.length < 12; i++) months.push((i % 12) + 1);
    const w = months.reduce((a, m) => a + weight[m - 1]!, 0);
    if (!best || months.length > best.months.length || (months.length === best.months.length && w > best.w)) best = { months, w };
  }
  return best ? orderMonths(best.months) : undefined;
}

const event = (kind: "rainy" | "dry" | "snow", title: string, city: City, months: number[], note: string): StoredEvent => ({
  id: `climate-${kind}-${city.id}`,
  title,
  kind: "season",
  cityIds: [city.id],
  month: months[0]!,
  ...(months.length > 1 ? { months } : {}),
  recurring: true,
  tags: [`${kind}-season`, "climate"],
  note,
  source: "meridian",
  feed: "climate-seasons",
});

const mm = (v: number) => `${Math.round(v)} mm`;

/** Rainy, dry and snow seasons for every city whose twelve monthly normals are known. */
export function climateSeasonEvents(inp: ClimateSeasonInputs): ClimateSeasonResult {
  const events: StoredEvent[] = [];
  let withNormals = 0;
  let rainyCount = 0;
  let dryCount = 0;
  let snowCount = 0;
  for (const c of inp.cities) {
    const n = inp.normals(c.id);
    if (!n || n.length !== 12 || n.some((m) => !Number.isFinite(m.tempC) || !Number.isFinite(m.precipMm))) continue;
    withNormals++;
    const precip = n.map((m) => m.precipMm);
    const mean = precip.reduce((a, b) => a + b, 0) / 12;
    const rainy = longestRun(precip.map((p) => p >= RAINY_FACTOR * mean && p >= RAINY_MIN_MM), precip);
    if (rainy) {
      rainyCount++;
      events.push(event("rainy", "Rainy season", c, rainy, `Months with at least ${RAINY_FACTOR} times the monthly mean rainfall (${mm(mean)}) and ${RAINY_MIN_MM} mm or more, from climate normals.`));
      // The dry run must not contain a rainy month; with a mean-relative cut it cannot.
      const dry = longestRun(precip.map((p) => p <= DRY_FACTOR * mean), precip.map((p) => -p));
      if (dry) {
        dryCount++;
        events.push(event("dry", "Dry season", c, dry, `Months with ${DRY_FACTOR} times the monthly mean rainfall (${mm(mean)}) or less, in a climate with a rainy season, from climate normals.`));
      }
    }
    const snow = longestRun(n.map((m) => m.tempC <= SNOW_MAX_TEMP_C && m.precipMm >= SNOW_MIN_MM), precip);
    if (snow) {
      snowCount++;
      events.push(event("snow", "Snow season", c, snow, `Months with a mean temperature of ${SNOW_MAX_TEMP_C} C or lower and ${SNOW_MIN_MM} mm or more of precipitation, from climate normals.`));
    }
  }
  return { events, citiesWithNormals: withNormals, rainy: rainyCount, dry: dryCount, snow: snowCount };
}
