// Measured facts about a city: cost of living, rent, internet, healthcare, stability and
// visitors (ADR 0013). Read from data/country-data.json and data/city-data.json, both built
// by scripts/build-place-data.ts. Every fact carries its source, year and how local it is
// (city, region or country). A fact the sources don't have is null: nothing is filled in.

import { readFileSync } from "fs";
import { join } from "path";
import type { City } from "../../src/types.js";
import { livabilityFor } from "./livability.js";
import { affordabilityScore, monthBusyness, speedScore, stabilityScore, tourismScore } from "./placeDataMath.js";

import type { Fact, FactGranularity, PlaceFacts, PlaceScores, SourceInfo, SpeedFact, VisitorMonths } from "../../src/lib/placeFacts.js";

export type { Fact, FactGranularity, PlaceFacts, PlaceScores, SourceInfo, SpeedFact, VisitorMonths };

interface YV {
  v: number;
  y: number;
}
interface Nights {
  index: number[];
  years: number[];
  total?: YV;
}
interface CountryRow {
  priceLevel?: YV;
  housingLevel?: YV;
  uhc?: YV;
  physicians?: YV;
  beds?: YV;
  stability?: YV;
  population?: YV;
  arrivals?: YV;
  nights?: Nights;
  rentRef?: YV & { cityId: string };
}
interface RegionRow {
  name: string;
  c: string;
  nights: Nights;
  population?: YV;
}
interface CityRow {
  c?: string;
  r?: string;
  cost?: YV & { st: string };
  rent?: YV;
  net?: { f?: number[]; m?: number[] };
  views?: { i: number[]; n: number };
}
interface CountryFile {
  version: number;
  builtAt: string;
  sources: Record<string, SourceInfo>;
  anchor: { monthlyEur: number; yearlyEur: number; y: number; place: string };
  checks?: Record<string, unknown>;
  countries: Record<string, CountryRow>;
  regions: Record<string, RegionRow>;
}
interface CityFile {
  version: number;
  builtAt: string;
  coverage: Record<string, number>;
  cities: Record<string, CityRow>;
}

interface Loaded {
  country: CountryFile;
  city: CityFile;
}

let loaded: Loaded | null | undefined;
let dataDir: string | undefined;

function load(): Loaded | null {
  if (loaded !== undefined) return loaded;
  try {
    const dir = dataDir ?? join(process.cwd(), "data");
    loaded = {
      country: JSON.parse(readFileSync(join(dir, "country-data.json"), "utf-8")) as CountryFile,
      city: JSON.parse(readFileSync(join(dir, "city-data.json"), "utf-8")) as CityFile,
    };
  } catch {
    console.warn("[placeData] data/country-data.json or data/city-data.json missing: run scripts/build-place-data.ts");
    loaded = null;
  }
  return loaded;
}

/** Test seam: re-read on next use, optionally from another directory. */
export function resetPlaceData(dir?: string): void {
  loaded = undefined;
  dataDir = dir;
}

export function placeDataInfo(): {
  builtAt: string | null;
  sources: Record<string, SourceInfo>;
  coverage: Record<string, number>;
  anchor: CountryFile["anchor"] | null;
} {
  const d = load();
  return { builtAt: d?.country.builtAt ?? null, sources: d?.country.sources ?? {}, coverage: d?.city.coverage ?? {}, anchor: d?.country.anchor ?? null };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Radius the build used to gather speed tests (kept in step with placeDataMath.cityRadiusKm). */
function radiusKm(population: number): number {
  return population >= 1_000_000 ? 20 : population >= 100_000 ? 10 : 5;
}

function speed(row: number[] | undefined, population: number): SpeedFact | null {
  if (!row || row.length < 4) return null;
  return { downMbps: row[0]!, upMbps: row[1]!, latencyMs: row[2]!, tests: row[3]!, radiusKm: radiusKm(population) };
}

/**
 * Weights of the safety score: political stability counts 60%, the homicide rate 40%.
 * With only one of them the score is that one; with neither there is no score.
 */
export const STABILITY_WEIGHT = 0.6;
export const HOMICIDE_WEIGHT = 0.4;

export function safetyScore(stability: number | null, homicideSafety: number | null): number | null {
  if (stability === null && homicideSafety === null) return null;
  if (stability === null) return homicideSafety;
  if (homicideSafety === null) return stability;
  return Math.round(STABILITY_WEIGHT * stability + HOMICIDE_WEIGHT * homicideSafety);
}

/** Everything measured about one city. Fields are null where there is no data. */
export function placeFacts(city: Pick<City, "id" | "population">, cityName?: (id: string) => string | undefined): PlaceFacts {
  const d = load();
  const row = d?.city.cities[city.id];
  const country = row?.c ? d?.country.countries[row.c] : undefined;
  const region = row?.r ? d?.country.regions[row.r] : undefined;
  const anchor = d?.country.anchor;
  const period = d?.country.sources.internet?.name.match(/(\d{4} Q\d)/)?.[1] ?? null;

  // Cost: the country's price level, for every city. The Eurostat correction coefficients the
  // build also keeps (row.cost) price an expatriate EU official's basket, about 1.5 times the
  // country level at the median and 2.5 to 4 times outside the EU, so mixing them in put the
  // 181 duty-station cities on another scale from the rest (ADR 0013). They are not used here.
  const index: Fact | null = country?.priceLevel
    ? { value: country.priceLevel.v, unit: "index (Belgium = 100)", year: country.priceLevel.y, source: "costCountry", granularity: "country" }
    : null;
  const monthlyEur: Fact | null =
    index && anchor
      ? {
          value: Math.round((anchor.monthlyEur * index.value) / 100 / 10) * 10,
          unit: "EUR per month",
          year: index.year,
          source: index.source,
          granularity: index.granularity,
          estimate: true,
        }
      : null;
  const rent1br: Fact | null = row?.rent ? { value: row.rent.v, unit: "EUR per month", year: row.rent.y, source: "rent", granularity: "city" } : null;
  const rentReference: Fact | null =
    !rent1br && country?.rentRef
      ? {
          value: country.rentRef.v,
          unit: "EUR per month",
          year: country.rentRef.y,
          source: "rent",
          granularity: "country",
          place: cityName?.(country.rentRef.cityId) ?? "the capital",
        }
      : null;

  const fixed = speed(row?.net?.f, city.population);
  const mobile = speed(row?.net?.m, city.population);

  const cf = (yv: YV | undefined, unit: string, source: string): Fact | null =>
    yv ? { value: yv.v, unit, year: yv.y, source, granularity: "country" } : null;
  const uhc = cf(country?.uhc, "index 0-100", "uhc");
  const physicians = cf(country?.physicians, "per 1,000 people", "physicians");
  const beds = cf(country?.beds, "per 1,000 people", "beds");
  const estimate = cf(country?.stability, "estimate (-2.5 to 2.5)", "stability");

  const liv = livabilityFor(city.id);
  const homicideRate = typeof liv?.raw.homicides === "number" ? liv.raw.homicides : null;
  const homicides: Fact | null =
    homicideRate !== null ? { value: r1(homicideRate), unit: "per 100,000 people", year: 0, source: "homicides", granularity: "country" } : null;

  const arrivals = cf(country?.arrivals, "arrivals per year", "arrivals");
  const arrivalsPerResident: Fact | null =
    country?.arrivals && country.population && country.population.v > 0
      ? { value: Math.round((country.arrivals.v / country.population.v) * 100) / 100, unit: "arrivals per resident per year", year: country.arrivals.y, source: "arrivals", granularity: "country" }
      : null;
  const nightsPerResident: Fact | null =
    region?.nights.total && region.population && region.population.v > 0
      ? {
          value: r1(region.nights.total.v / region.population.v),
          unit: "nights per resident per year",
          year: region.nights.total.y,
          source: "nights",
          granularity: "region",
          place: region.name,
        }
      : null;

  let months: VisitorMonths | null = null;
  if (region) months = { index: region.nights.index, basis: "nights", granularity: "region", place: region.name, years: region.nights.years, source: "nights" };
  else if (country?.nights) months = { index: country.nights.index, basis: "nights", granularity: "country", years: country.nights.years, source: "nights" };
  const interestMonths: VisitorMonths | null = row?.views
    ? { index: row.views.i, basis: "pageViews", granularity: "city", years: [], source: "pageViews" }
    : null;

  const stabilityPart = estimate ? stabilityScore(estimate.value) : null;
  const scores: PlaceScores = {
    cost: monthlyEur ? affordabilityScore(monthlyEur.value) : null,
    connectivity: fixed ? speedScore(fixed.downMbps) : mobile ? speedScore(mobile.downMbps) : null,
    health: uhc ? Math.round(uhc.value) : null,
    stability: safetyScore(stabilityPart, liv?.qualityParts.safety ?? null),
    tourism: arrivalsPerResident ? tourismScore(arrivalsPerResident.value) : null,
  };

  return {
    cityId: city.id,
    cost: { monthlyEur, index, rent1br, rentReference },
    internet: { fixed, mobile, source: "internet", period },
    health: { uhc, physicians, beds },
    stability: { estimate, homicides },
    crowds: { arrivalsPerResident, arrivals, nightsPerResident, months, interestMonths },
    scores,
  };
}

/**
 * Measured month-by-month visitor pattern for a city, for the crowd estimate: nights in tourist
 * accommodation for its NUTS 2 region, else its country. Wikipedia page views are not used here
 * (see ADR 0013: they track school terms and news as much as visits).
 */
export function visitorMonthsFor(cityId: string): { index: number[]; basis: "nights"; granularity: FactGranularity } | undefined {
  const d = load();
  const row = d?.city.cities[cityId];
  if (!row) return undefined;
  const region = row.r ? d!.country.regions[row.r] : undefined;
  if (region) return { index: region.nights.index, basis: "nights", granularity: "region" };
  const country = row.c ? d!.country.countries[row.c] : undefined;
  if (country?.nights) return { index: country.nights.index, basis: "nights", granularity: "country" };
  return undefined;
}

/** 0-100: how busy `month` (1-12) is in the place's own year, from measured nights. */
export function measuredBusyness(cityId: string, month: number): number | undefined {
  const m = visitorMonthsFor(cityId);
  return m ? monthBusyness(m.index, month) : undefined;
}
