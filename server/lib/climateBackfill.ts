// Resumable, quota-aware backfill of climate normals for every city (ADR 0014).
//
// Cities are grouped by 0.25 degree climate cell, so one fetch serves every city in a cell.
// Each cell needs two Open-Meteo calls: the archive API (10 years of daily temperature and rain)
// and the air quality API (3 years of hourly PM2.5 from CAMS). The same code runs as a script
// (scripts/backfill-climate.ts) and as the server's nightly job (climateJob.ts); only the
// persistence differs (a `ClimateSink`).
//
// Open-Meteo's free tier is 600 calls/minute, 5,000/hour and 10,000/day, where a call is
// weighted by variables and days: (variables / 10) x (days / 14). Ten years of three daily
// variables therefore weighs about 78, so the free tier fetches roughly 7 cells a minute, 60 an
// hour or 120 a day (the minute limit was confirmed by hitting it at one call every 1.5 seconds). We spend a configurable share of that, record every call in a ledger that survives
// restarts, and stop (never fabricate) when a limit answers back.

import type { City } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";
import { aggregateDailyToMonthly, type DailyRecord } from "./seasonality.js";
import {
  cellKeyFor,
  dailyFromHourly,
  encodeWeekly,
  monthlyMeanNormals,
  weeklyNormals,
  type ClimateCell,
  type DailyValue,
} from "./climateNormals.js";

export const WEATHER_START = "2015-01-01";
export const WEATHER_END = "2024-12-31";
export const WEATHER_WINDOW = "2015-2024";
export const AIR_START = "2023-01-01";
export const AIR_END = "2025-12-31";
export const AIR_WINDOW = "2023-2025";

const WEATHER_URL = "https://archive-api.open-meteo.com/v1/archive";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

/** A cell is refetched when its weather is older than this (the normals window moves slowly). */
export const REFRESH_AFTER_DAYS = 730;

// ── quota ledger ──────────────────────────────────────────────────────────

export interface Limits {
  /** Weighted calls we allow ourselves per rolling minute / hour / day (Open-Meteo allows 600 / 5,000 / 10,000). */
  minutely: number;
  hourly: number;
  daily: number;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { minutely: n(env.OPEN_METEO_MINUTELY_BUDGET, 400), hourly: n(env.OPEN_METEO_HOURLY_BUDGET, 3500), daily: n(env.OPEN_METEO_DAILY_BUDGET, 7000) };
}

interface Ledger {
  /** [epoch ms, weight] of each call we made, newest last; pruned to 24 hours. */
  spent: Array<[number, number]>;
  /** A limit answered back: do not call again before this time. */
  blockedUntil?: number;
}

const ledgerStore = createJsonStore<Ledger>("cache/open-meteo-ledger.json", () => ({ spent: [] }));

export function weightOf(variables: number, days: number): number {
  return Math.max(1, Math.ceil((variables / 10) * (days / 14) * 10) / 10);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
export const WEATHER_WEIGHT = weightOf(3, daysBetween(WEATHER_START, WEATHER_END));
export const AIR_WEIGHT = weightOf(1, daysBetween(AIR_START, AIR_END));

export function usedIn(ledger: Ledger, now: number, windowMs: number): number {
  return ledger.spent.reduce((s, [t, w]) => (now - t < windowMs ? s + w : s), 0);
}

/** Milliseconds until `weight` more fits under both limits, 0 if it fits now, Infinity if it can never fit. */
export function waitFor(ledger: Ledger, now: number, weight: number, limits: Limits): number {
  if (weight > limits.minutely || weight > limits.hourly || weight > limits.daily) return Infinity;
  let wait = Math.max(0, (ledger.blockedUntil ?? 0) - now);
  for (const [windowMs, cap] of [[60_000, limits.minutely], [3_600_000, limits.hourly], [86_400_000, limits.daily]] as const) {
    let used = usedIn(ledger, now, windowMs);
    if (used + weight <= cap) continue;
    // Walk forward until enough old calls age out of the window.
    for (const [t, w] of ledger.spent) {
      if (now - t >= windowMs) continue;
      used -= w;
      wait = Math.max(wait, t + windowMs - now + 1000);
      if (used + weight <= cap) break;
    }
  }
  return wait;
}

// ── fetchers ──────────────────────────────────────────────────────────────

export type FetchFailure = "minutely" | "hourly" | "daily" | "limit" | "network" | "timeout" | "bad";
export type FetchOutcome<T> = { ok: true; data: T } | { ok: false; reason: FetchFailure; message?: string };

type Fetch = typeof fetch;

async function getJson(url: string, fetchFn: Fetch, timeoutMs = 60_000): Promise<FetchOutcome<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!res.ok || body?.error === true) {
      const reason = String(body?.reason ?? "");
      if (/minutely/i.test(reason)) return { ok: false, reason: "minutely", message: reason };
      if (/hourly/i.test(reason)) return { ok: false, reason: "hourly", message: reason };
      if (/daily/i.test(reason)) return { ok: false, reason: "daily", message: reason };
      if (res.status === 429 || /limit|too many/i.test(reason)) return { ok: false, reason: "limit", message: reason || `HTTP ${res.status}` };
      return { ok: false, reason: res.status >= 500 ? "network" : "bad", message: reason || `HTTP ${res.status}` };
    }
    if (!body) return { ok: false, reason: "network", message: "unreadable response" };
    return { ok: true, data: body };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "AbortError" || name === "TimeoutError" ? "timeout" : "network", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface WeatherDaily {
  temp: DailyValue[];
  rain: DailyValue[];
  /** Same days as `temp`, in the shape aggregateDailyToMonthly expects. */
  records: DailyRecord[];
}

export async function fetchWeatherDaily(lat: number, lng: number, fetchFn: Fetch = fetch): Promise<FetchOutcome<WeatherDaily>> {
  const url =
    `${WEATHER_URL}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${WEATHER_START}&end_date=${WEATHER_END}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=UTC`;
  const r = await getJson(url, fetchFn);
  if (!r.ok) return r;
  const daily = r.data.daily as { time?: string[]; temperature_2m_max?: Array<number | null>; temperature_2m_min?: Array<number | null>; precipitation_sum?: Array<number | null> } | undefined;
  if (!daily?.time || !Array.isArray(daily.time)) return { ok: false, reason: "bad", message: "no daily block" };
  const temp: DailyValue[] = [];
  const rain: DailyValue[] = [];
  const records: DailyRecord[] = [];
  for (let i = 0; i < daily.time.length; i++) {
    const max = daily.temperature_2m_max?.[i];
    const min = daily.temperature_2m_min?.[i];
    if (max == null || min == null) continue;
    const date = daily.time[i]!;
    const tempC = (max + min) / 2;
    const precipMm = daily.precipitation_sum?.[i] ?? 0;
    temp.push({ date, v: tempC });
    rain.push({ date, v: precipMm });
    records.push({ date, tempC, precipMm });
  }
  if (records.length === 0) return { ok: false, reason: "bad", message: "no usable days" };
  return { ok: true, data: { temp, rain, records } };
}

export async function fetchAirDaily(lat: number, lng: number, fetchFn: Fetch = fetch): Promise<FetchOutcome<DailyValue[]>> {
  const url =
    `${AIR_URL}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    `&start_date=${AIR_START}&end_date=${AIR_END}&hourly=pm2_5&timezone=UTC`;
  const r = await getJson(url, fetchFn);
  if (!r.ok) return r;
  const hourly = r.data.hourly as { time?: string[]; pm2_5?: Array<number | null> } | undefined;
  if (!hourly?.time || !Array.isArray(hourly.pm2_5)) return { ok: false, reason: "bad", message: "no hourly block" };
  const daily = dailyFromHourly(hourly.time, hourly.pm2_5);
  if (daily.length === 0) return { ok: false, reason: "bad", message: "no usable air-quality days" };
  return { ok: true, data: daily };
}

// ── building a cell ───────────────────────────────────────────────────────

const q10 = (x: number) => Math.round(x * 10);

/** The monthly (and weekly, when the series is dense enough) record for fetched weather, keeping any air data already on the cell. */
export function cellFromWeather(w: WeatherDaily, today: string, prior?: ClimateCell): ClimateCell {
  const months = aggregateDailyToMonthly(w.records);
  const weekly = encodeWeekly(w.temp, w.rain);
  return {
    ...prior,
    at: today,
    m: { t: months.map((m) => q10(m.tempC)), p: months.map((m) => m.precipMm), ...(prior?.m?.a ? { a: prior.m.a } : {}) },
    ...(weekly ? { w: { ...weekly, ...(prior?.w?.a ? { a: prior.w.a } : {}) } } : prior?.w ? { w: prior.w } : {}),
  };
}

/** Adds PM2.5 (monthly and weekly) to a cell that already has weather. */
export function withAir(cell: ClimateCell, air: DailyValue[], today: string): ClimateCell {
  const monthly = monthlyMeanNormals(air);
  const weeklyAir = weeklyNormals(air)?.map(q10);
  const out: ClimateCell = { ...cell, aq: today };
  if (monthly && cell.m) out.m = { ...cell.m, a: monthly.map(q10) };
  if (weeklyAir && cell.w) out.w = { ...cell.w, a: weeklyAir };
  return out;
}

// ── planning ──────────────────────────────────────────────────────────────

export interface PlanItem {
  key: string;
  /** The most populous city in the cell: the coordinates we query, and the city the cell is named for in logs. */
  rep: City;
  cityCount: number;
  needsWeather: boolean;
  needsAir: boolean;
  /** Smaller = sooner. */
  rank: number;
}

export interface PlanOptions {
  /** City ids the product already shows data for (the committed seed): refreshed first. */
  seedIds?: ReadonlySet<string>;
  /** City ids to do before everything else (the script's --first flag). */
  firstIds?: ReadonlySet<string>;
  today?: string;
}

/**
 * Every cell that has a gap, ordered: cells with nothing yet (seed cities first, then capitals and
 * large-airport cities, then by population), then cells missing only air quality, then stale cells
 * oldest first. A cell is a gap if it has no weather, no weekly profile, no air quality, or weather
 * older than REFRESH_AFTER_DAYS.
 */
export function planBackfill(cities: City[], cells: Record<string, ClimateCell>, opts: PlanOptions = {}): PlanItem[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const byKey = new Map<string, City[]>();
  for (const c of cities) {
    const k = cellKeyFor(c.lat, c.lng);
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }
  const items: PlanItem[] = [];
  for (const [key, list] of byKey) {
    const rep = [...list].sort((a, b) => b.population - a.population || a.id.localeCompare(b.id))[0]!;
    const cell = cells[key];
    const needsWeather = !cell?.m || !cell.w;
    const needsAir = !cell?.aq;
    const ageDays = cell?.at ? (Date.parse(today) - Date.parse(cell.at)) / 86_400_000 : Infinity;
    const stale = !needsWeather && ageDays > REFRESH_AFTER_DAYS;
    if (!needsWeather && !needsAir && !stale) continue;
    const important = list.some((c) => opts.firstIds?.has(c.id)) ? -1 : list.some((c) => opts.seedIds?.has(c.id)) ? 0 : list.some((c) => c.capital || c.hub === "large") ? 1 : 2;
    // rank: unfetched (0-2) before air-only (3) before stale (4); within a tier by population or age.
    const tier = needsWeather || important < 0 ? important : needsAir ? 3 : 4;
    const within = tier === 4 ? Date.parse(cell?.at ?? today) / 86_400_000 : -rep.population / 1e9;
    items.push({ key, rep, cityCount: list.length, needsWeather: needsWeather || stale, needsAir: needsAir || stale, rank: tier * 1e6 + within });
  }
  return items.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

// ── running ───────────────────────────────────────────────────────────────

export interface ClimateSink {
  /** Current record for a cell, so a partial cell is completed instead of redone. */
  get(key: string): ClimateCell | undefined;
  /** Persist a cell right away: an interrupted run must lose nothing already fetched. */
  save(key: string, cell: ClimateCell): Promise<void> | void;
}

export interface BackfillOptions {
  sink: ClimateSink;
  plan: PlanItem[];
  /** Weighted calls this run may spend, on top of the rolling hourly/daily limits. */
  runBudget: number;
  limits?: Limits;
  fetchFn?: Fetch;
  now?: () => number;
  /** Pause between calls (ms). */
  delayMs?: number;
  /** When a limit is hit, sleep until it clears (script mode) instead of ending the run (server job). */
  wait?: boolean;
  /** Stop after this many cells. */
  maxCells?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface BackfillResult {
  cellsCompleted: number;
  cellsPartial: number;
  spent: number;
  stoppedBy: "done" | "run-budget" | "quota-wait" | "limit" | "max-cells" | "error";
  remainingGaps: number;
  lastError?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const limits = opts.limits ?? limitsFromEnv();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? (() => undefined);
  const delayMs = opts.delayMs ?? 1500;
  const fetchFn = opts.fetchFn ?? fetch;
  const result: BackfillResult = { cellsCompleted: 0, cellsPartial: 0, spent: 0, stoppedBy: "done", remainingGaps: opts.plan.length };

  const record = async (weight: number) => {
    await ledgerStore.update((l) => {
      const t = now();
      l.spent = l.spent.filter(([at]) => t - at < 86_400_000);
      l.spent.push([t, weight]);
    });
    result.spent += weight;
  };

  /** Waits (or reports) until `weight` fits. Returns false when the run should end. */
  const admit = async (weight: number): Promise<boolean> => {
    for (;;) {
      if (result.spent + weight > opts.runBudget) {
        result.stoppedBy = "run-budget";
        return false;
      }
      const ledger = await ledgerStore.read();
      const wait = waitFor(ledger, now(), weight, limits);
      if (wait === 0) return true;
      if (!opts.wait || !Number.isFinite(wait)) {
        result.stoppedBy = "quota-wait";
        return false;
      }
      log(`waiting ${Math.round(wait / 60_000)} min for quota`);
      await sleep(Math.min(wait, 10 * 60_000));
    }
  };

  const onLimit = async (reason: FetchFailure): Promise<boolean> => {
    // Back off by the scope that answered. Returns true to keep going after waiting (script mode).
    const t = now();
    const until = reason === "minutely" ? t + 70_000 : reason === "hourly" ? t + 3_600_000 : t + 6 * 3_600_000;
    await ledgerStore.update((l) => {
      l.blockedUntil = until;
    });
    if (!opts.wait) result.stoppedBy = "limit";
    return !!opts.wait;
  };

  for (let i = 0; i < opts.plan.length; i++) {
    const item = opts.plan[i]!;
    if (opts.maxCells !== undefined && result.cellsCompleted + result.cellsPartial >= opts.maxCells) {
      result.stoppedBy = "max-cells";
      break;
    }
    let cell = opts.sink.get(item.key);
    const today = new Date(now()).toISOString().slice(0, 10);
    let fresh = false;
    let failed = false;

    if (item.needsWeather && !(cell?.at === today && cell.m && cell.w)) {
      if (!(await admit(WEATHER_WEIGHT))) break;
      await record(WEATHER_WEIGHT);
      const w = await fetchWeatherDaily(item.rep.lat, item.rep.lng, fetchFn);
      if (!w.ok) {
        result.lastError = `${item.rep.id}: ${w.reason} ${w.message ?? ""}`.trim();
        log(`weather failed for ${result.lastError}`);
        if (w.reason === "minutely" || w.reason === "hourly" || w.reason === "daily" || w.reason === "limit") {
          if (await onLimit(w.reason)) {
            await sleep(w.reason === "minutely" ? 70_000 : 60_000);
            i--; // same cell again once the limit has cleared
            continue;
          }
          break;
        }
        failed = true;
      } else {
        cell = cellFromWeather(w.data, today, cell);
        await opts.sink.save(item.key, cell);
        fresh = true;
        await sleep(delayMs);
      }
    }

    if (!failed && item.needsAir && cell?.m) {
      if (!(await admit(AIR_WEIGHT))) {
        if (fresh) result.cellsPartial++;
        break;
      }
      await record(AIR_WEIGHT);
      const a = await fetchAirDaily(item.rep.lat, item.rep.lng, fetchFn);
      if (!a.ok) {
        result.lastError = `${item.rep.id}: air ${a.reason} ${a.message ?? ""}`.trim();
        log(`air quality failed for ${result.lastError}`);
        if (fresh) result.cellsPartial++;
        if (a.reason === "minutely" || a.reason === "hourly" || a.reason === "daily" || a.reason === "limit") {
          if (await onLimit(a.reason)) {
            await sleep(60_000);
            i--;
            continue;
          }
          break;
        }
        continue;
      }
      cell = withAir(cell, a.data, today);
      await opts.sink.save(item.key, cell);
      await sleep(delayMs);
    }

    if (!failed && cell?.m) {
      result.cellsCompleted++;
      result.remainingGaps--;
      log(`${item.rep.name} (${item.rep.country}) cell ${item.key}: done, ${item.cityCount} cit${item.cityCount === 1 ? "y" : "ies"}`);
    }
  }
  return result;
}
