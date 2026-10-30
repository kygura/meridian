// Journey/stop fingerprint (spec-journal §5). Deterministic given its inputs
// and injected deps: same journey + same weather/holiday fixtures → identical
// fingerprint except computedAt. Never guesses a value: failed weather is
// "pending", missing money is "absent".

import { createHash } from "crypto";
import { haversineKm } from "../../src/lib/geo.js";
import { getCityById } from "./cities.js";
import { peekCitySeasonality } from "./seasonality.js";
import { fetchObservedWeather, defaultObservedWeatherDeps, type ObservedWeatherResult } from "./observedWeather.js";
import { computeCrowdProxy, diskHolidayCache, type CrowdProxy } from "./crowd.js";
import { dominantMonthOfNights, eachNight, isoWeek, midNight, stayNights } from "./stayDates.js";
import type {
  City,
  Fingerprint,
  FingerprintDim,
  FingerprintDimStatus,
  Journey,
  Segment,
  Stop,
} from "../../src/types.js";

export interface FingerprintDeps {
  observedWeather: (cityId: string, arrive: string, depart: string) => Promise<ObservedWeatherResult>;
  /** Crowd proxy for a stay; dateRange is inclusive (first night .. last night). */
  crowd: (cityId: string, month: number, dateRange: { from: string; to: string }) => Promise<CrowdProxy | undefined>;
  getCity: (cityId: string) => City | undefined;
  now: () => Date;
}

const WEATHER_DIMS = ["comfort", "tempC", "precipMm"] as const;

// ── inputsHash ─────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

/** sha1 of the canonical JSON of everything the fingerprint reads. */
export function computeInputsHash(journey: Journey): string {
  const money = (m?: { eur: number }) => (m ? m.eur : undefined);
  const inputs = {
    companions: journey.companions,
    rating: journey.rating,
    tags: journey.tags,
    stops: journey.stops.map((s) => ({
      cityId: s.cityId,
      arrive: s.arrive,
      depart: s.depart,
      lodging: money(s.lodging?.cost),
      rating: s.rating,
      crowdOverride: s.crowdOverride,
    })),
    segments: journey.segments.map((g) => ({ mode: g.mode, from: g.fromCityId, to: g.toCityId, cost: money(g.cost) })),
    experiences: journey.experiences.map((e) => ({ cityId: e.cityId, date: e.date, cost: money(e.cost) })),
  };
  return createHash("sha1").update(JSON.stringify(canonical(inputs))).digest("hex");
}

/** True when inputs changed since the stored fingerprint, or any dim is still pending. */
export function needsRecompute(journey: Journey): boolean {
  const fp = journey.fingerprint;
  if (!fp || fp.inputsHash !== computeInputsHash(journey)) return true;
  const pending = (f?: Fingerprint) => !f || Object.values(f.status).includes("pending");
  return pending(fp) || journey.stops.some((s) => pending(s.fingerprint));
}

// ── helpers ────────────────────────────────────────────────────────────

function flightCostPer1000km(segments: Segment[], getCity: FingerprintDeps["getCity"]): number | undefined {
  let eur = 0;
  let km = 0;
  for (const s of segments) {
    if (s.mode !== "flight" || !s.cost) continue;
    const a = getCity(s.fromCityId);
    const b = getCity(s.toCityId);
    if (!a || !b) continue;
    const d = haversineKm([a.lng, a.lat], [b.lng, b.lat]);
    if (d <= 0) continue;
    eur += s.cost.eur;
    km += d;
  }
  return km > 0 ? round2((eur / km) * 1000) : undefined;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

function stopSpendEur(stop: Stop, journey: Journey): number | undefined {
  let total = 0;
  let any = false;
  if (stop.lodging?.cost) {
    total += stop.lodging.cost.eur;
    any = true;
  }
  for (const e of journey.experiences) {
    if (e.cityId === stop.cityId && e.cost && e.date.slice(0, 10) >= stop.arrive && e.date.slice(0, 10) <= stop.depart) {
      total += e.cost.eur;
      any = true;
    }
  }
  return any ? total : undefined;
}

function emptyStatus(): Record<FingerprintDim, FingerprintDimStatus> {
  return { month: "ok", comfort: "absent", tempC: "absent", precipMm: "absent", dailySpendEur: "absent", flightCostEurPer1000km: "absent", crowdProxy: "absent" };
}

// ── per stop ───────────────────────────────────────────────────────────

export async function computeStopFingerprint(
  stop: Stop,
  journey: Journey,
  deps: FingerprintDeps,
  inputsHash = computeInputsHash(journey)
): Promise<{ stop: Stop; fingerprint: Fingerprint }> {
  const nights = eachNight(stop.arrive, stop.depart);
  const nNights = stayNights(stop.arrive, stop.depart);
  const month = dominantMonthOfNights(nights);
  const status = emptyStatus();
  const fp: Fingerprint = {
    month,
    weekOfYear: isoWeek(midNight(stop.arrive, stop.depart)),
    durationNights: nNights,
    rating: stop.rating,
    tags: [...journey.tags],
    status,
    computedAt: deps.now().toISOString(),
    inputsHash,
  };

  const weather = await deps.observedWeather(stop.cityId, stop.arrive, stop.depart);
  let observed = undefined as Stop["observed"];
  if (weather.ok) {
    observed = weather.observed;
    fp.comfort = observed.comfort;
    fp.tempC = observed.tempC;
    fp.precipMm = observed.precipMm;
    for (const d of WEATHER_DIMS) status[d] = "ok";
  } else {
    // Unknown city can never resolve → absent; everything else retries.
    for (const d of WEATHER_DIMS) status[d] = weather.reason === "no_city" ? "absent" : "pending";
  }

  const spend = stopSpendEur(stop, journey);
  if (spend !== undefined) {
    fp.dailySpendEur = round2(spend / Math.max(1, nNights) / (journey.companions || 1));
    status.dailySpendEur = "ok";
  }

  const flight = flightCostPer1000km(journey.segments.filter((s) => s.toCityId === stop.cityId), deps.getCity);
  if (flight !== undefined) {
    fp.flightCostEurPer1000km = flight;
    status.flightCostEurPer1000km = "ok";
  }

  if (typeof stop.crowdOverride === "number") {
    fp.crowdProxy = stop.crowdOverride;
    fp.crowdIsOverride = true;
    status.crowdProxy = "ok";
  } else {
    const crowd = await deps.crowd(stop.cityId, month, { from: nights[0]!, to: nights[nights.length - 1]! });
    if (crowd) {
      fp.crowdProxy = crowd.value;
      status.crowdProxy = "ok";
      if (crowd.flags.length) fp.crowdFlags = [...crowd.flags];
    }
  }

  const { observed: _o, fingerprint: _f, ...rest } = stop;
  const out: Stop = { ...rest, ...(observed ? { observed } : {}), fingerprint: fp };
  return { stop: out, fingerprint: fp };
}

// ── per journey ────────────────────────────────────────────────────────

/** Nights-weighted mean over stops that have the dim; pending wins over partial data (never guessed). */
function aggregate(
  stops: Fingerprint[],
  weights: number[],
  dim: "comfort" | "tempC" | "precipMm" | "crowdProxy"
): { value?: number; status: FingerprintDimStatus } {
  if (stops.some((s) => s.status[dim] === "pending")) return { status: "pending" };
  let sum = 0;
  let w = 0;
  stops.forEach((s, i) => {
    const v = s[dim];
    if (typeof v === "number") {
      sum += v * weights[i]!;
      w += weights[i]!;
    }
  });
  return w > 0 ? { value: sum / w, status: "ok" } : { status: "absent" };
}

export async function computeFingerprint(
  journey: Journey,
  deps: FingerprintDeps
): Promise<{ journey: Journey; fingerprint: Fingerprint }> {
  const inputsHash = computeInputsHash(journey);
  const perStop = [];
  for (const s of journey.stops) perStop.push(await computeStopFingerprint(s, journey, deps, inputsHash));
  const stopFps = perStop.map((p) => p.fingerprint);
  const weights = journey.stops.map((s) => Math.max(1, stayNights(s.arrive, s.depart)));

  const allNights = journey.stops.flatMap((s) => eachNight(s.arrive, s.depart));
  const startDate = journey.startDate || journey.stops[0]?.arrive || "";
  const endDate = journey.endDate || journey.stops[journey.stops.length - 1]?.depart || startDate;
  const durationNights = startDate && endDate ? stayNights(startDate, endDate) : weights.reduce((a, b) => a + b, 0);
  const status = emptyStatus();
  const fp: Fingerprint = {
    month: allNights.length ? dominantMonthOfNights(allNights) : Number(startDate.slice(5, 7)) || 1,
    weekOfYear: startDate ? isoWeek(midNight(startDate, endDate)) : 1,
    durationNights,
    rating: journey.rating,
    tags: [...journey.tags],
    status,
    computedAt: deps.now().toISOString(),
    inputsHash,
  };

  for (const d of WEATHER_DIMS) {
    const a = aggregate(stopFps, weights, d);
    status[d] = a.status;
    if (a.value !== undefined) fp[d] = d === "tempC" ? round1(a.value) : Math.round(a.value);
  }

  const crowd = aggregate(stopFps, weights, "crowdProxy");
  status.crowdProxy = crowd.status;
  if (crowd.value !== undefined) {
    fp.crowdProxy = Math.round(crowd.value);
    if (journey.stops.some((s) => typeof s.crowdOverride === "number")) fp.crowdIsOverride = true;
    const flags = [...new Set(stopFps.flatMap((s) => s.crowdFlags ?? []))].sort();
    if (flags.length) fp.crowdFlags = flags;
  }

  let spend = 0;
  let anySpend = false;
  for (const s of journey.stops) {
    if (s.lodging?.cost) {
      spend += s.lodging.cost.eur;
      anySpend = true;
    }
  }
  for (const e of journey.experiences) {
    if (e.cost) {
      spend += e.cost.eur;
      anySpend = true;
    }
  }
  if (anySpend) {
    fp.dailySpendEur = round2(spend / Math.max(1, durationNights) / (journey.companions || 1));
    status.dailySpendEur = "ok";
  }

  const flight = flightCostPer1000km(journey.segments, deps.getCity);
  if (flight !== undefined) {
    fp.flightCostEurPer1000km = flight;
    status.flightCostEurPer1000km = "ok";
  }

  return { journey: { ...journey, stops: perStop.map((p) => p.stop), fingerprint: fp }, fingerprint: fp };
}

// ── real wiring ────────────────────────────────────────────────────────

/** Real modules: Open-Meteo archive + disk cache, Nager.Date + disk cache, city DB. */
export function defaultFingerprintDeps(opts: { now?: () => Date; fetch?: typeof fetch } = {}): FingerprintDeps {
  const f = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => new Date());
  const weatherDeps = { ...defaultObservedWeatherDeps(), fetch: f, now };
  const holidayCache = diskHolidayCache();
  const seasonality = (id: string) => {
    const p = peekCitySeasonality(id);
    return p.kind === "hit" ? p.months : undefined;
  };
  return {
    observedWeather: (cityId, arrive, depart) => fetchObservedWeather(cityId, arrive, depart, weatherDeps),
    crowd: (cityId, month, dateRange) =>
      computeCrowdProxy(
        { cityId, month, year: Number(dateRange.from.slice(0, 4)), dateRange },
        { fetch: f, cache: holidayCache, seasonality }
      ),
    getCity: getCityById,
    now,
  };
}
