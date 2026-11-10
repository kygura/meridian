// Replay engine (spec-journal §6, ADR 0005). Deterministic ranking of
// destination × month cells against a (bent) fingerprint template. Pure
// apart from the injected deps; no LLM, no synthesized scoring surfaces.

import { haversineKm, estimateFlightHours } from "../../src/lib/geo.js";
import { WEEKS_PER_MONTH, monthOfWeek, weekOfDayOfYear } from "../../src/lib/comfort.js";
import { comfortScore, getAllCityWeeks, peekCitySeasonality, loadSeasonality, type MonthSeasonality, type WeekSeasonality } from "./seasonality.js";
import { getCities, getCityById } from "./cities.js";
import { getFlightEstimate, REGION_COUNTRIES } from "./agent/tools.js";
import { crowdProxyForMonth, loadHolidayIndexFromCache, type HolidayIndex } from "./crowd.js";
import type {
  City,
  FlightEstimateResult,
  Fingerprint,
  JournalSettings,
  Journey,
  MeridianEvent,
  ReplayDim,
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
  /** cityId -> 52 week-of-year normals (precip per 7 days). Used only at week resolution; cities without it are matched by month. */
  weekly?: Record<string, WeekSeasonality[]>;
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
  constructor(public code: "template_not_found" | "template_not_fingerprinted" | "origin_not_found" | "origin_required", message: string) {
    super(message);
  }
}

export const STAGE1_KEEP = 60;
export const STAGE2_PRICED = 20;
export const DEFAULT_LIMIT = 30;

/** Distance normalizers: a gap this large (or larger) means similarity 0. */
export const NORMALIZERS = { tempC: 15, precipMm: 150, comfort: 50, crowdProxy: 50, month: 6, weekOfYear: 26 } as const;

/** At week resolution a city keeps at most this many weeks, at least MIN_WEEK_GAP weeks apart, so one city's adjacent weeks don't crowd out every other city. */
export const MAX_WEEKS_PER_CITY = 3;
export const MIN_WEEK_GAP = 4;

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

/** Circular distance between two weeks of the year (1-52). */
export function weekDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 52;
  return Math.min(d, 52 - d);
}

export function dimSimilarity(dim: keyof typeof NORMALIZERS, value: number, template: number): number {
  const d = dim === "month" ? monthDistance(value, template) : dim === "weekOfYear" ? weekDistance(value, template) : Math.abs(value - template);
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
  name: ReplayDim;
  value: number;
  templateValue: number;
  similarity: number;
  weight: number;
  basis?: ReplayDimScore["basis"];
}

/**
 * Weighted match over present dims (weights renormalized), with contribution shares.
 * `equalIfAllZero`: no positive-weight dim → equal weights (stage-1 pre-ranking only);
 * otherwise such a cell scores 0 on nothing, never on dims the user turned off.
 */
export function scoreDims(dims: DimInput[], equalIfAllZero = true): { match: number; dims: ReplayDimScore[]; scoredOn: ReplayDim[] } {
  let use = dims.filter((d) => d.weight > 0);
  if (use.length === 0 && equalIfAllZero) use = dims.map((d) => ({ ...d, weight: 1 })); // all weights 0 → equal
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
      ...(d.basis ? { basis: d.basis } : {}),
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

/**
 * The week of the year (1-52) a template sits in at week resolution: its own week of the year
 * (53 folds into 52), else the middle of its month; shifted by the month bend (a month is ~4.33
 * weeks); undefined when the bend says "any month" or the template has neither.
 */
export function templateWeek(template: Partial<Fingerprint>, bend: ReplayQuery["bend"]): number | undefined {
  if (bend.monthShift === null) return undefined;
  let week: number | undefined;
  if (typeof template.weekOfYear === "number") week = Math.min(52, Math.max(1, template.weekOfYear));
  else if (typeof template.month === "number") week = weekOfDayOfYear(MONTH_MID_DOY[template.month - 1] ?? 183);
  if (week === undefined) return undefined;
  if (bend.monthShift) week = ((((week - 1 + Math.round((bend.monthShift * 52) / 12)) % 52) + 52) % 52) + 1;
  return week;
}

const MONTH_MID_DOY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

/** The middle day of `week` in the next occurrence strictly after now. */
export function representativeDateOfWeek(week: number, now: Date): string {
  const doy = (week - 1) * 7 + 4;
  const at = (y: number) => new Date(Date.UTC(y, 0, doy)).toISOString().slice(0, 10);
  const y = now.getUTCFullYear();
  return at(y) > now.toISOString().slice(0, 10) ? at(y) : at(y + 1);
}

/** Keeps a city's best weeks, at least MIN_WEEK_GAP apart (deterministic: ties go to the earlier week). */
export function thinWeeks<T extends { week?: number; stage1: number }>(cands: T[]): T[] {
  const sorted = [...cands].sort((a, b) => b.stage1 - a.stage1 || (a.week ?? 0) - (b.week ?? 0));
  const kept: T[] = [];
  for (const c of sorted) {
    if (kept.length >= MAX_WEEKS_PER_CITY) break;
    if (kept.every((k) => weekDistance(k.week!, c.week!) >= MIN_WEEK_GAP)) kept.push(c);
  }
  return kept;
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
  /** Week of the year (1-52) for a weekly cell. */
  week?: number;
  base: DimInput[];
  stage1: number;
}

/** What stage 1 reads off one month or one week of a city's normals. precipMm is always a monthly-equivalent total, to compare with the template. */
interface Slot {
  month: number;
  week?: number;
  score: number;
  tempC: number;
  precipMm: number;
}

export async function runReplay(query: ReplayQuery, deps: ReplayDeps): Promise<ReplayResponse> {
  const filled = fillTemplateClimate(resolveTemplate(query, deps.journeys), templateStops(query, deps.journeys), deps.seasonality);
  const template = applyBend(filled.template, query.bend ?? {});
  const c = query.constraints ?? {};
  const limit = query.limit ?? DEFAULT_LIMIT;
  const qw = query.weights;
  // All weights 0 → equal weights, decided once per query (not per cell).
  const w = qw.climate || qw.spend || qw.crowd || qw.flight ? qw : { climate: 1, spend: 1, crowd: 1, flight: 1 };
  const hist = history(deps.journeys, deps.getCity);
  const fromCityId = c.fromCityId ?? deps.settings.homeCityId;
  const fromCity = fromCityId ? deps.getCity(fromCityId) : undefined;
  if (c.fromCityId && !fromCity) throw new ReplayError("origin_not_found", `origin city ${c.fromCityId} not found`);
  if (c.maxFlightHours !== undefined && !fromCity) {
    throw new ReplayError("origin_required", "maxFlightHours needs an origin: pass constraints.fromCityId or set a home city");
  }
  const tagFilter = c.tags?.map((t) => t.toLowerCase()) ?? [];

  const weekMode = query.resolution === "week";
  const tWeek = weekMode ? templateWeek(filled.template, query.bend ?? {}) : undefined;
  const weekFilter = c.weeks?.length ? new Set(c.weeks) : undefined;
  /** A month-resolution fallback cell is kept when the weeks constraint reaches into its month. */
  const weekMonths = weekFilter ? new Set([...weekFilter].map(monthOfWeek)) : undefined;

  // The climate dims a cell is scored on: the template's comfort/temperature/rain, plus when in the year
  // (the month, or the week of the year for a weekly cell). Weight is shared equally among them.
  const climateBase = (["comfort", "tempC", "precipMm"] as const).filter((d) => typeof template[d] === "number");
  const timeTemplate = (weekly: boolean) => (weekly ? tWeek : typeof template.month === "number" ? template.month : undefined);
  const climateCount = (weekly: boolean) => climateBase.length + (timeTemplate(weekly) !== undefined ? 1 : 0);
  const climateEach = (weekly: boolean) => (climateCount(weekly) ? w.climate / climateCount(weekly) : 0);

  const universe = Object.keys(deps.seasonality);
  const cells: Cell[] = [];
  /** Stage-1 match for all 12 months per city (ignores month/tag filters) → ReplayResponse.grid. */
  const gridRows = new Map<string, Array<number | null>>();
  /** Week resolution: stage-1 match for all 52 weeks of each city that has weekly normals. */
  const weekGridRows = new Map<string, Array<number | null>>();

  const stage1Dims = (city: City, slot: Slot): DimInput[] => {
    const weekly = slot.week !== undefined;
    const each = climateEach(weekly);
    const values = { comfort: slot.score, tempC: slot.tempC, precipMm: slot.precipMm } as const;
    const base: DimInput[] = climateBase.map((d) => ({
      name: d as ReplayDim,
      value: values[d],
      templateValue: template[d] as number,
      similarity: dimSimilarity(d, values[d], template[d] as number),
      weight: each,
    }));
    const when = timeTemplate(weekly);
    if (when !== undefined) {
      const dim = weekly ? "weekOfYear" : "month";
      const value = weekly ? slot.week! : slot.month;
      base.push({ name: dim, value, templateValue: when, similarity: dimSimilarity(dim, value, when), weight: each });
    }
    if (typeof template.crowdProxy === "number") {
      const crowd = crowdProxyForMonth(city.id, slot.month, deps.holidayIndex, (id) => deps.seasonality[id]);
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

    const tagsOk = (month: number) =>
      !tagFilter.length || eventsFor(deps.events, city.id, month).some((e) => e.tags.some((t) => tagFilter.includes(t.toLowerCase())));
    const weeks = weekMode ? deps.weekly?.[city.id] : undefined;
    const useWeeks = !!weeks && weeks.length === 52;

    const row: Array<number | null> = [];
    for (let month = 1; month <= 12; month++) {
      const m = months[month - 1]!;
      const base = stage1Dims(city, { month, score: m.score, tempC: m.tempC, precipMm: m.precipMm });
      const stage1 = base.length ? scoreDims(base).match : null;
      row.push(stage1);
      if (stage1 === null || useWeeks) continue; // a city with weekly normals is matched by its weeks instead
      if (c.months?.length && !c.months.includes(month)) continue;
      if (weekMonths && !weekMonths.has(month)) continue;
      if (!tagsOk(month)) continue;
      cells.push({ city, month, base, stage1 });
    }
    gridRows.set(city.id, row);

    if (useWeeks) {
      const wrow: Array<number | null> = [];
      const cands: Cell[] = [];
      for (let week = 1; week <= 52; week++) {
        const wk = weeks![week - 1]!;
        const month = monthOfWeek(week);
        const base = stage1Dims(city, { month, week, score: wk.score, tempC: wk.tempC, precipMm: wk.precipMm * WEEKS_PER_MONTH });
        const stage1 = base.length ? scoreDims(base).match : null;
        wrow.push(stage1);
        if (stage1 === null) continue;
        if (c.months?.length && !c.months.includes(month)) continue;
        if (weekFilter && !weekFilter.has(week)) continue;
        if (!tagsOk(month)) continue;
        cands.push({ city, month, week, base, stage1 });
      }
      cells.push(...thinWeeks(cands));
      weekGridRows.set(city.id, wrow);
    }
  }

  // Stage 1: cheap climate/season ranking (ties broken by cityId, month for determinism).
  cells.sort((a, b) => b.stage1 - a.stage1 || a.city.id.localeCompare(b.city.id) || a.month - b.month || (a.week ?? 0) - (b.week ?? 0));
  const survivors = cells.slice(0, STAGE1_KEEP);

  const today = deps.now().toISOString().slice(0, 10);
  const ranked: Array<{ result: ReplayResult; priceBand: boolean }> = await Promise.all(
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
          est = await deps.flightEstimate({
            originIata: fromCity.iata,
            destinationIata: cell.city.iata,
            departureDate: cell.week !== undefined ? representativeDateOfWeek(cell.week, deps.now()) : representativeDate(cell.month, deps.now()),
          });
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
              // No baseline to compare against: templateValue is a placeholder, the tooltip shows the basis.
              dims.push({ name: "flightCostEurPer1000km", value: per1000, templateValue: per1000, similarity: DEAL_SIMILARITY[est.dealRating], weight: w.flight, basis: "dealRating" });
            }
          }
        }
      }

      const scored = scoreDims(dims, false);
      const events = eventsFor(deps.events, cell.city.id, cell.month);
      const result: ReplayResult = {
        cityId: cell.city.id,
        month: cell.month,
        ...(cell.week !== undefined ? { week: cell.week } : {}),
        match: scored.match,
        dims: scored.dims,
        scoredOn: scored.scoredOn,
        visitedBefore: hist.visited.has(cell.city.id),
      };
      if (price) result.price = price;
      if (events.length) result.events = events;
      return { result, priceBand: rank < STAGE2_PRICED };
    })
  );

  // Once any cell is scored on price, only the priced band is compared on the full score:
  // cells 21-60 were never priced, so they rank after it instead of overtaking it on
  // climate alone (an absent-by-cutoff dim is not the same basis as a poor price).
  const tiered = ranked.some((r) => r.result.scoredOn.includes("flightCostEurPer1000km"));
  const tier = (r: (typeof ranked)[number]) => (tiered && !r.priceBand ? 1 : 0);
  ranked.sort(
    (x, y) =>
      tier(x) - tier(y) ||
      y.result.match - x.result.match ||
      x.result.cityId.localeCompare(y.result.cityId) ||
      x.result.month - y.result.month ||
      (x.result.week ?? 0) - (y.result.week ?? 0)
  );
  const results = ranked.map((r) => r.result);
  const top = results.slice(0, limit);
  const grid = [...new Set(top.map((r) => r.cityId))].map((cityId) => ({ cityId, months: gridRows.get(cityId)! }));
  const resultIds = [...new Set(top.map((r) => r.cityId))];
  return {
    results: top,
    universeSize: universe.length,
    template,
    fromCityId,
    grid,
    templateClimate: filled.templateClimate,
    ...(weekMode
      ? {
          resolution: "week" as const,
          weekGrid: resultIds.filter((id) => weekGridRows.has(id)).map((cityId) => ({ cityId, weeks: weekGridRows.get(cityId)! })),
          weeklyUniverseSize: Object.keys(deps.weekly ?? {}).length,
        }
      : {}),
  };
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

export const FLIGHT_CACHE_TTL_MS = 6 * 3600_000;
/** A mock (provider failed / keyless) is kept briefly so a recovered provider is retried soon. */
export const FLIGHT_CACHE_MOCK_TTL_MS = 10 * 60_000;
const FLIGHT_CACHE_MAX = 2_000;

/**
 * Per-(origin, destination, departureDate) price memo with a TTL and in-flight
 * dedupe. Replay re-runs on every slider move and watch/agent run, so without it
 * each request re-spends up to STAGE2_PRICED live provider searches. Failures are not cached.
 */
export function cachedFlightEstimate(fetcher: ReplayDeps["flightEstimate"], now: () => number = Date.now): ReplayDeps["flightEstimate"] {
  const cache = new Map<string, { at: number; ttl: number; value: Promise<FlightEstimateResult> }>();
  return (p) => {
    const key = `${p.originIata}|${p.destinationIata}|${p.departureDate}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    cache.delete(key);
    const entry = { at: now(), ttl: FLIGHT_CACHE_TTL_MS, value: fetcher(p) };
    entry.value.then(
      (r) => {
        if (r.source === "mock") entry.ttl = FLIGHT_CACHE_MOCK_TTL_MS;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      }
    );
    cache.set(key, entry);
    if (cache.size > FLIGHT_CACHE_MAX) cache.delete(cache.keys().next().value!);
    return entry.value;
  };
}

/** One process-wide memo shared by POST /api/replay, watch runs and the agent tool. */
const sharedFlightEstimate = cachedFlightEstimate((q) => getFlightEstimate(q));

/** Real modules for the route: seasonality cache, city DB, agent flight estimate (memoized), cached holidays. */
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
    weekly: getAllCityWeeks(),
    getCity: getCityById,
    flightEstimate: sharedFlightEstimate,
    now: p.now ?? (() => new Date()),
    holidayIndex: loadHolidayIndexFromCache(),
  };
}
