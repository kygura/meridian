// Replay engine (spec-journal §6, ADR 0005). Deterministic ranking of
// destination × month cells against a (bent) fingerprint template. Pure
// apart from the injected deps; no LLM, no synthesized scoring surfaces.

import { haversineKm, estimateFlightHours } from "../../src/lib/geo.js";
import { comfortScore, peekCitySeasonality, loadSeasonality, type MonthSeasonality } from "./seasonality.js";
import { getCities, getCityById } from "./cities.js";
import { getFlightEstimate, REGION_COUNTRIES } from "./agent/tools.js";
import { crowdProxyForMonth, loadHolidayIndexFromCache, type HolidayIndex } from "./crowd.js";
import type {
  City,
  FingerprintDim,
  FlightEstimateResult,
  Fingerprint,
  JournalSettings,
  Journey,
  MeridianEvent,
  ReplayDimScore,
  ReplayQuery,
  ReplayResponse,
  ReplayResult,
  Stop,
} from "../../src/types.js";
import { dominantMonth, stayNights } from "./stayDates.js";

export interface ReplayDeps {
  journeys: Journey[];
  settings: JournalSettings;
  /** cityId → 12 monthly normals (Jan..Dec). Its key count is the universe. */
  seasonality: Record<string, MonthSeasonality[]>;
  getCity: (cityId: string) => City | undefined;
  flightEstimate: (p: { originIata: string; destinationIata: string; departureDate: string }) => Promise<FlightEstimateResult>;
  /** EUR value of an amount at `date` (YYYY-MM-DD); undefined when no rate. */
  eurOf: (amount: number, currency: string, date: string) => Promise<number | undefined> | number | undefined;
  now: () => Date;
  events?: MeridianEvent[];
  /** Cached per-month holiday share for the crowd proxy (no network in the loop). */
  holidayIndex?: HolidayIndex;
}

export class ReplayError extends Error {
  constructor(public code: "template_not_found" | "template_not_fingerprinted", message: string) {
    super(message);
  }
}

export const STAGE1_KEEP = 60;
export const STAGE2_PRICED = 20;
export const DEFAULT_LIMIT = 30;

/** Distance normalizers: a gap this large (or larger) means similarity 0. */
export const NORMALIZERS = { tempC: 15, precipMm: 150, comfort: 50, crowdProxy: 50, month: 6 } as const;

const CLIMATE_DIMS = ["comfort", "tempC", "precipMm", "month"] as const;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── template ───────────────────────────────────────────────────────────

export function resolveTemplate(query: ReplayQuery, journeys: Journey[]): Partial<Fingerprint> {
  const t = query.template;
  if ("fingerprint" in t) return { ...t.fingerprint };
  const j = journeys.find((x) => x.id === t.journeyId);
  if (!j) throw new ReplayError("template_not_found", `journey ${t.journeyId} not found`);
  if (t.stopIndex !== undefined) {
    const stop = j.stops[t.stopIndex];
    if (!stop) throw new ReplayError("template_not_found", `stop ${t.stopIndex} not found`);
    if (!stop.fingerprint) throw new ReplayError("template_not_fingerprinted", "stop has no fingerprint");
    return { ...stop.fingerprint };
  }
  if (!j.fingerprint) throw new ReplayError("template_not_fingerprinted", "journey has no fingerprint");
  return { ...j.fingerprint };
}

/** The stops behind a journey/stop template (empty for a partial-fingerprint template). */
export function templateStops(query: ReplayQuery, journeys: Journey[]): Stop[] {
  const t = query.template;
  if ("fingerprint" in t) return [];
  const j = journeys.find((x) => x.id === t.journeyId);
  if (!j) return [];
  if (t.stopIndex !== undefined) return j.stops[t.stopIndex] ? [j.stops[t.stopIndex]!] : [];
  return j.stops;
}

const WEATHER_DIMS = ["comfort", "tempC", "precipMm"] as const;

/**
 * R8: when observed weather is pending/absent, fill the template's missing
 * comfort/tempC/precipMm from the stops' seasonality normals (nights-weighted,
 * each stop at its own dominant month) so the tempC bend still bends. Returns a
 * copy; the stored fingerprint is never touched.
 */
export function fillTemplateClimate(
  template: Partial<Fingerprint>,
  stops: Stop[],
  seasonality: Record<string, MonthSeasonality[]>
): { template: Partial<Fingerprint>; templateClimate: "observed" | "normal" | "none" } {
  const missing = WEATHER_DIMS.filter((d) => typeof template[d] !== "number");
  if (missing.length === 0) return { template, templateClimate: "observed" };
  const acc = { comfort: 0, tempC: 0, precipMm: 0 };
  let w = 0;
  for (const s of stops) {
    const months = seasonality[s.cityId];
    const month = s.fingerprint?.month ?? dominantMonth(s.arrive, s.depart);
    const m = months?.[month - 1];
    if (!m) continue;
    const n = Math.max(1, stayNights(s.arrive, s.depart));
    acc.comfort += m.score * n;
    acc.tempC += m.tempC * n;
    acc.precipMm += m.precipMm * n;
    w += n;
  }
  if (w === 0) return { template, templateClimate: missing.length === WEATHER_DIMS.length ? "none" : "observed" };
  const out: Partial<Fingerprint> = { ...template };
  if (missing.includes("tempC")) out.tempC = Math.round((acc.tempC / w) * 10) / 10;
  if (missing.includes("precipMm")) out.precipMm = Math.round(acc.precipMm / w);
  if (missing.includes("comfort")) out.comfort = Math.round(acc.comfort / w);
  return { template: out, templateClimate: "normal" };
}

/** Applies the bend sliders. Only defined template dims are bent; nothing is invented. */
export function applyBend(template: Partial<Fingerprint>, bend: ReplayQuery["bend"]): Partial<Fingerprint> {
  const t: Partial<Fingerprint> = { ...template };
  if (bend.tempC && typeof t.tempC === "number") {
    t.tempC = Math.round((t.tempC + bend.tempC) * 10) / 10;
    if (typeof t.precipMm === "number") t.comfort = comfortScore(t.tempC, t.precipMm);
  }
  if (bend.spendPct && typeof t.dailySpendEur === "number") {
    t.dailySpendEur = Math.round(t.dailySpendEur * (1 + bend.spendPct / 100) * 100) / 100;
  }
  if (bend.crowd && typeof t.crowdProxy === "number") t.crowdProxy = clamp(t.crowdProxy + bend.crowd, 0, 100);
  if (bend.monthShift === null) delete t.month;
  else if (bend.monthShift && typeof t.month === "number") t.month = ((((t.month - 1 + bend.monthShift) % 12) + 12) % 12) + 1;
  return t;
}

// ── similarity primitives ──────────────────────────────────────────────

export function monthDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

export function dimSimilarity(dim: keyof typeof NORMALIZERS, value: number, template: number): number {
  const d = dim === "month" ? monthDistance(value, template) : Math.abs(value - template);
  return 1 - Math.min(1, d / NORMALIZERS[dim]);
}

/** Relative spend gap: 100% off → 0. */
export function spendSimilarity(value: number, template: number): number {
  return 1 - Math.min(1, Math.abs(value - template) / Math.max(1, template));
}

/** Cheaper than baseline caps at 1; 2× baseline (or worse) → 0. */
export function priceSimilarity(priceEur: number, baselineEur: number): number {
  if (baselineEur <= 0) return 0;
  return clamp(1 - (priceEur / baselineEur - 1), 0, 1);
}

export const DEAL_SIMILARITY = { low: 1, typical: 0.6, high: 0.2 } as const;

interface DimInput {
  name: FingerprintDim;
  value: number;
  templateValue: number;
  similarity: number;
  weight: number;
}

/** Weighted match over present dims (weights renormalized), with contribution shares. */
export function scoreDims(dims: DimInput[]): { match: number; dims: ReplayDimScore[]; scoredOn: FingerprintDim[] } {
  let use = dims.filter((d) => d.weight > 0);
  if (use.length === 0) use = dims.map((d) => ({ ...d, weight: 1 })); // all weights 0 → equal
  const wSum = use.reduce((a, d) => a + d.weight, 0);
  const wsSum = use.reduce((a, d) => a + d.weight * d.similarity, 0);
  const match = wSum > 0 ? Math.round((wsSum / wSum) * 1000) / 10 : 0;
  return {
    match,
    scoredOn: use.map((d) => d.name),
    dims: use.map((d) => ({
      name: d.name,
      value: d.value,
      templateValue: d.templateValue,
      contribution: wsSum > 0 ? (d.weight * d.similarity) / wsSum : d.weight / wSum,
    })),
  };
}

// ── history (confirmed journeys only) ──────────────────────────────────

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

function history(journeys: Journey[], getCity: ReplayDeps["getCity"]) {
  const confirmed = journeys.filter((j) => j.status === "confirmed");
  const visited = new Set<string>();
  const spendByCity = new Map<string, number[]>();
  const spendByCountry = new Map<string, number[]>();
  for (const j of confirmed) {
    for (const s of j.stops) {
      visited.add(s.cityId);
      const v = s.fingerprint?.dailySpendEur;
      if (typeof v !== "number") continue;
      spendByCity.set(s.cityId, [...(spendByCity.get(s.cityId) ?? []), v]);
      const country = getCity(s.cityId)?.country;
      if (country) spendByCountry.set(country, [...(spendByCountry.get(country) ?? []), v]);
    }
  }
  const baselinePer1000 = median(
    confirmed.map((j) => j.fingerprint?.flightCostEurPer1000km).filter((v): v is number => typeof v === "number")
  );
  return { visited, spendByCity, spendByCountry, baselinePer1000 };
}

// ── filters ────────────────────────────────────────────────────────────

export function cityInRegions(city: City, regions: string[]): boolean {
  return regions.some((r) => {
    const key = r.trim().toLowerCase();
    return (
      REGION_COUNTRIES[key]?.includes(city.country) ||
      city.region?.toLowerCase() === key ||
      city.country.toLowerCase() === key
    );
  });
}

/** 15th of the next occurrence of `month` strictly after now. */
export function representativeDate(month: number, now: Date): string {
  const y = now.getUTCFullYear();
  const mm = String(month).padStart(2, "0");
  const thisYear = `${y}-${mm}-15`;
  return thisYear > now.toISOString().slice(0, 10) ? thisYear : `${y + 1}-${mm}-15`;
}

// ── main ───────────────────────────────────────────────────────────────

interface Cell {
  city: City;
  month: number;
  base: DimInput[];
  stage1: number;
}

export async function runReplay(query: ReplayQuery, deps: ReplayDeps): Promise<ReplayResponse> {
  const filled = fillTemplateClimate(resolveTemplate(query, deps.journeys), templateStops(query, deps.journeys), deps.seasonality);
  const template = applyBend(filled.template, query.bend ?? {});
  const c = query.constraints ?? {};
  const limit = query.limit ?? DEFAULT_LIMIT;
  const w = query.weights;
  const hist = history(deps.journeys, deps.getCity);
  const fromCityId = c.fromCityId ?? deps.settings.homeCityId;
  const fromCity = fromCityId ? deps.getCity(fromCityId) : undefined;
  const tagFilter = c.tags?.map((t) => t.toLowerCase()) ?? [];

  const climateDims = CLIMATE_DIMS.filter((d) => typeof template[d] === "number");
  const climateEach = climateDims.length ? w.climate / climateDims.length : 0;

  const universe = Object.keys(deps.seasonality);
  const cells: Cell[] = [];
  /** Stage-1 match for all 12 months per city (ignores month/tag filters) → ReplayResponse.grid. */
  const gridRows = new Map<string, Array<number | null>>();

  const stage1Dims = (city: City, month: number, m: MonthSeasonality): DimInput[] => {
    const values: Record<(typeof CLIMATE_DIMS)[number], number> = { comfort: m.score, tempC: m.tempC, precipMm: m.precipMm, month };
    const base: DimInput[] = climateDims.map((d) => ({
      name: d as FingerprintDim,
      value: values[d],
      templateValue: template[d] as number,
      similarity: dimSimilarity(d, values[d], template[d] as number),
      weight: climateEach,
    }));
    if (typeof template.crowdProxy === "number") {
      const crowd = crowdProxyForMonth(city.id, month, deps.holidayIndex, (id) => deps.seasonality[id]);
      if (crowd) {
        base.push({
          name: "crowdProxy",
          value: crowd.value,
          templateValue: template.crowdProxy,
          similarity: dimSimilarity("crowdProxy", crowd.value, template.crowdProxy),
          weight: w.crowd,
        });
      }
    }
    return base;
  };

  for (const cityId of universe) {
    const months = deps.seasonality[cityId];
    const city = deps.getCity(cityId);
    if (!city || !months || months.length !== 12) continue;
    if (c.cityIds?.length && !c.cityIds.includes(city.id)) continue;
    if (fromCity && city.id === fromCity.id) continue;
    if (c.excludeVisited && hist.visited.has(city.id)) continue;
    if (c.regions?.length && !cityInRegions(city, c.regions)) continue;
    if (c.maxFlightHours !== undefined && fromCity) {
      const km = haversineKm([fromCity.lng, fromCity.lat], [city.lng, city.lat]);
      if (estimateFlightHours(km) > c.maxFlightHours) continue;
    }

    const row: Array<number | null> = [];
    for (let month = 1; month <= 12; month++) {
      const base = stage1Dims(city, month, months[month - 1]!);
      const stage1 = base.length ? scoreDims(base).match : null;
      row.push(stage1);
      if (stage1 === null) continue;
      if (c.months?.length && !c.months.includes(month)) continue;
      if (tagFilter.length && !eventsFor(deps.events, city.id, month).some((e) => e.tags.some((t) => tagFilter.includes(t.toLowerCase())))) continue;
      cells.push({ city, month, base, stage1 });
    }
    gridRows.set(city.id, row);
  }

  // Stage 1: cheap climate/season ranking (ties broken by cityId, month for determinism).
  cells.sort((a, b) => b.stage1 - a.stage1 || a.city.id.localeCompare(b.city.id) || a.month - b.month);
  const survivors = cells.slice(0, STAGE1_KEEP);

  const today = deps.now().toISOString().slice(0, 10);
  const results: ReplayResult[] = await Promise.all(
    survivors.map(async (cell, rank) => {
      const dims = [...cell.base];

      // Spend: user's recorded spend in that city, else that country. Otherwise absent.
      if (typeof template.dailySpendEur === "number") {
        const v = mean(hist.spendByCity.get(cell.city.id) ?? []) ?? mean(hist.spendByCountry.get(cell.city.country) ?? []);
        if (v !== undefined) {
          dims.push({ name: "dailySpendEur", value: v, templateValue: template.dailySpendEur, similarity: spendSimilarity(v, template.dailySpendEur), weight: w.spend });
        }
      }

      // Stage 2: price only the top N.
      let price: ReplayResult["price"];
      if (rank < STAGE2_PRICED && fromCity?.iata && cell.city.iata) {
        const distanceKm = Math.round(haversineKm([fromCity.lng, fromCity.lat], [cell.city.lng, cell.city.lat]));
        let est: FlightEstimateResult | undefined;
        try {
          est = await deps.flightEstimate({ originIata: fromCity.iata, destinationIata: cell.city.iata, departureDate: representativeDate(cell.month, deps.now()) });
        } catch {
          est = undefined;
        }
        if (est) {
          let priceEur: number | undefined;
          try {
            priceEur = await deps.eurOf(est.priceAmount, est.currency, today);
          } catch {
            priceEur = undefined;
          }
          const baselineEur = hist.baselinePer1000 !== undefined ? Math.round((hist.baselinePer1000 * distanceKm) / 1000) : undefined;
          price = { ...est, priceEur, baselineEur, distanceKm };
          // Mock prices are shown (badged) but never scored.
          if (est.source !== "mock" && priceEur !== undefined && distanceKm > 0) {
            const per1000 = Math.round((priceEur / distanceKm) * 1000 * 100) / 100;
            if (baselineEur !== undefined) {
              dims.push({ name: "flightCostEurPer1000km", value: per1000, templateValue: hist.baselinePer1000!, similarity: priceSimilarity(priceEur, baselineEur), weight: w.flight });
            } else if (est.dealRating) {
              dims.push({ name: "flightCostEurPer1000km", value: per1000, templateValue: per1000, similarity: DEAL_SIMILARITY[est.dealRating], weight: w.flight });
            }
          }
        }
      }

      const scored = scoreDims(dims);
      const events = eventsFor(deps.events, cell.city.id, cell.month);
      const result: ReplayResult = {
        cityId: cell.city.id,
        month: cell.month,
        match: scored.match,
        dims: scored.dims,
        scoredOn: scored.scoredOn,
        visitedBefore: hist.visited.has(cell.city.id),
      };
      if (price) result.price = price;
      if (events.length) result.events = events;
      return result;
    })
  );

  results.sort((a, b) => b.match - a.match || a.cityId.localeCompare(b.cityId) || a.month - b.month);
  const top = results.slice(0, limit);
  const grid = [...new Set(top.map((r) => r.cityId))].map((cityId) => ({ cityId, months: gridRows.get(cityId)! }));
  return { results: top, universeSize: universe.length, template, fromCityId, grid, templateClimate: filled.templateClimate };
}

function eventsFor(events: MeridianEvent[] | undefined, cityId: string, month: number): MeridianEvent[] {
  return (events ?? []).filter((e) => e.month === month && e.cityIds.includes(cityId));
}

// ── real wiring ────────────────────────────────────────────────────────

/** Seed + runtime seasonality cache as a plain map (cache-only, never fetches). */
export function seasonalityUniverse(): Record<string, MonthSeasonality[]> {
  const out: Record<string, MonthSeasonality[]> = {};
  const ids = new Set([...Object.keys(loadSeasonality().cities), ...getCities().map((c) => c.id)]);
  for (const id of ids) {
    const p = peekCitySeasonality(id);
    if (p.kind === "hit") out[id] = p.months;
  }
  return out;
}

/** Real modules for the route: seasonality cache, city DB, agent flight estimate, cached holidays. */
export function defaultReplayDeps(p: {
  journeys: Journey[];
  settings: JournalSettings;
  eurOf: ReplayDeps["eurOf"];
  events?: MeridianEvent[];
  now?: () => Date;
}): ReplayDeps {
  return {
    journeys: p.journeys,
    settings: p.settings,
    eurOf: p.eurOf,
    events: p.events,
    seasonality: seasonalityUniverse(),
    getCity: getCityById,
    flightEstimate: (q) => getFlightEstimate(q),
    now: p.now ?? (() => new Date()),
    holidayIndex: loadHolidayIndexFromCache(),
  };
}
