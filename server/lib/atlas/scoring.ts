// Atlas scoring (ADR 0020): pure functions, ported from Atlas's src/scoring.
// No I/O here: the service passes in the stored fares, config and wishlist.

import type { AtlasAnnotation, AtlasConfig, AtlasFlight, AtlasPlace } from "./schemas.js";

/** A stored, priced, non-distorted fare: the baseline's raw material. */
export interface FareRecord {
  route: string;
  origin: string;
  destination: string;
  priceEur: number;
  departDate: string;
  returnDate?: string;
  snapshotDate: string;
  source: string;
  runId?: string;
}

export interface RouteBaseline {
  route: string;
  median: number | null;
  p25: number | null;
  count: number;
  /** Fewer than 3 records: no deviation is computed. */
  thin: boolean;
}

export interface Gates {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

export interface ScoredFlight {
  flight: AtlasFlight;
  annotation: AtlasAnnotation;
  baseline: RouteBaseline;
  /** (price - median) / median * 100. Negative is cheaper than usual. */
  priceVsMedianPct: number | null;
  composite: number;
  opportunity: boolean;
  opportunityReason: string | null;
  baselineDeal: boolean;
  gates: Gates;
}

export const MIN_BASELINE_RECORDS = 3;
export const BASELINE_DEAL_PCT = -15;
const THIN_BASELINE_REFERENCE_EUR = 1800;
const DISCOVERY_PRICE_REFERENCE_EUR = 900;
const CROWD_POINTS: Record<AtlasAnnotation["crowd"], number> = { low: 10, medium: 6, high: 3, peak: 1 };

export const routeKey = (origin: string, destination: string) => `${origin.toUpperCase()}-${destination.toUpperCase()}`;

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp10 = (n: number) => Math.max(0, Math.min(10, n));
/** 1-5 onto 0-10. */
const scale5 = (n: number) => (n - 1) * 2.5;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function baselineFor(route: string, fares: readonly FareRecord[]): RouteBaseline {
  const prices = fares
    .filter((f) => f.route === route)
    .map((f) => f.priceEur)
    .sort((a, b) => a - b);
  if (prices.length < MIN_BASELINE_RECORDS) return { route, median: null, p25: null, count: prices.length, thin: true };
  return { route, median: round2(quantile(prices, 0.5)), p25: round2(quantile(prices, 0.25)), count: prices.length, thin: false };
}

/** Why a flight breaks the hard filters; empty when it passes. */
export function hardFilterFailures(
  flight: AtlasFlight,
  filters: AtlasConfig["hardFilters"],
  overrides: { budgetEconomyEur?: { min?: number; max?: number }; maxStops?: number } = {}
): string[] {
  const out: string[] = [];
  if (flight.error) out.push(`search error: ${flight.error}`);
  const maxStops = overrides.maxStops ?? filters.maxStops;
  if (flight.stops != null && flight.stops > maxStops) out.push(`${flight.stops} stops, limit ${maxStops}`);
  if (flight.travelHours != null && flight.travelHours > filters.maxTravelTimeHours) out.push(`${flight.travelHours} h travel, limit ${filters.maxTravelTimeHours} h`);
  if (flight.longestLayoverHours != null && flight.longestLayoverHours > filters.maxLayoverWaitHours) {
    out.push(`${flight.longestLayoverHours} h layover, limit ${filters.maxLayoverWaitHours} h`);
  }
  const min = overrides.budgetEconomyEur?.min ?? filters.budgetEconomyEur.min;
  const max = overrides.budgetEconomyEur?.max ?? filters.budgetEconomyEur.max;
  if (flight.priceEur == null) out.push("no economy price");
  else if (flight.priceEur < min || flight.priceEur > max) out.push(`${Math.round(flight.priceEur)} EUR outside ${min}-${max} EUR`);
  return out;
}

export function scoreFlight(
  flight: AtlasFlight,
  annotation: AtlasAnnotation,
  baseline: RouteBaseline,
  weights: AtlasConfig["scoringWeights"],
  intentTags: readonly string[]
): Pick<ScoredFlight, "priceVsMedianPct" | "composite" | "opportunity" | "opportunityReason" | "baselineDeal"> {
  const price = flight.priceEur;
  const median = baseline.thin ? null : baseline.median;

  const priceScore =
    median != null && price != null
      ? clamp10(10 - (price / median - 0.7) * 15)
      : Math.max(0, 10 - ((price ?? THIN_BASELINE_REFERENCE_EUR) / THIN_BASELINE_REFERENCE_EUR) * 10);
  const surf = intentTags.includes("surf") ? scale5(annotation.surf ?? 3) : 5;

  const composite = round2(
    clamp10(
      priceScore * weights.priceVsBaseline +
        scale5(annotation.weather) * weights.weather +
        CROWD_POINTS[annotation.crowd] * weights.crowd +
        surf * weights.surf +
        scale5(annotation.isolation) * weights.isolation
    )
  );

  const priceVsMedianPct = median != null && price != null && median > 0 ? round2(((price - median) / median) * 100) : null;
  const opportunity = median != null && price != null && composite >= weights.opportunityThreshold && price < median * 0.85;
  return {
    priceVsMedianPct,
    composite,
    opportunity,
    opportunityReason: opportunity ? `${Math.round(price!)} EUR vs ${Math.round(median!)} EUR median (${Math.round(((median! - price!) / median!) * 100)}% below)` : null,
    baselineDeal: priceVsMedianPct != null && priceVsMedianPct <= BASELINE_DEAL_PCT,
  };
}

export function checkGates(
  s: Pick<ScoredFlight, "composite" | "annotation">,
  gates: AtlasConfig["tripPreferences"]["gates"],
  relax: boolean
): Gates {
  const issues: string[] = [];
  if (s.composite < gates.minCompositeScore) issues.push(`composite ${s.composite} under ${gates.minCompositeScore}`);
  if (s.annotation.weather < gates.minWeatherScore) issues.push(`weather ${s.annotation.weather}/5 under ${gates.minWeatherScore}`);
  if (!gates.allowPeakCrowds && s.annotation.crowd === "peak") issues.push("peak crowds");
  if (s.annotation.isolation < gates.minIsolationScore) issues.push(`isolation ${s.annotation.isolation}/5 under ${gates.minIsolationScore}`);
  if (s.annotation.distortion) issues.push(`price distorted by an event: ${s.annotation.distortionReason ?? "unspecified"}`);
  // Budget is a hard filter, applied before scoring, so relaxing gates never lets a fare over budget through.
  return relax ? { passed: true, failures: [], warnings: issues } : { passed: issues.length === 0, failures: issues, warnings: [] };
}

/** Top passing result, and an alternative within 0.5 points to a different destination. */
export function selectCandidates(scored: readonly ScoredFlight[]): { top: string | null; alternative: string | null } {
  const ranked = scored.filter((s) => s.gates.passed && !s.annotation.distortion).sort((a, b) => b.composite - a.composite);
  const top = ranked[0];
  if (!top) return { top: null, alternative: null };
  const alt = ranked.find((s) => s.flight.destination !== top.flight.destination && top.composite - s.composite <= 0.5);
  return { top: top.flight.id, alternative: alt?.flight.id ?? null };
}

export interface WatchHit {
  cityId: string;
  name: string;
  flightId: string;
  priceEur: number | null;
  reason: string;
  chatId?: string;
}

/** Fares that clear the deal bar for a watched place: an opportunity, a baseline deal, or within its target budget. */
export function findWatchHits(scored: readonly ScoredFlight[], places: readonly AtlasPlace[]): WatchHit[] {
  const hits: WatchHit[] = [];
  for (const place of places) {
    if (!place.watch?.active || !place.iata) continue;
    const max = place.watch.targetBudgetEur?.max;
    for (const s of scored) {
      if (s.flight.destination !== place.iata || s.annotation.distortion) continue;
      const price = s.flight.priceEur;
      const withinBudget = max != null && price != null && price <= max;
      if (max != null && !withinBudget) continue;
      if (!s.opportunity && !s.baselineDeal && !withinBudget) continue;
      const reason = s.opportunityReason
        ? s.opportunityReason
        : s.baselineDeal
          ? `${Math.abs(Math.round(s.priceVsMedianPct!))}% below the route median`
          : `within target budget of ${max} EUR`;
      hits.push({ cityId: place.cityId, name: place.name, flightId: s.flight.id, priceEur: price, reason, ...(place.watch.chatId ? { chatId: place.watch.chatId } : {}) });
    }
  }
  return hits;
}

export interface DiscoverySignals {
  weather: number;
  conditions: number;
  tourismSeason: number;
  priceSignalEur: number | null;
}

export function scoreDiscovery(
  c: DiscoverySignals,
  weights: AtlasConfig["discoveryWeights"],
  isRepeat: boolean
): { composite: number; repeatPenalty: boolean; thinPriceSignal: boolean } {
  const thinPriceSignal = c.priceSignalEur == null;
  const priceScore = thinPriceSignal ? 5 : clamp10(10 - (c.priceSignalEur! / DISCOVERY_PRICE_REFERENCE_EUR) * 10);
  const raw =
    scale5(c.weather) * weights.weather +
    scale5(c.tourismSeason) * weights.tourismSeason +
    scale5(c.conditions) * weights.conditions +
    priceScore * weights.priceSignal;
  return { composite: round2(clamp10(isRepeat ? raw - weights.repeatPenalty : raw)), repeatPenalty: isRepeat, thinPriceSignal };
}
