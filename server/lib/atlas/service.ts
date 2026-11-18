// Atlas on Meridian (ADR 0020): storage and the work behind /api/atlas.
// One document, "atlas.json", in the shared store (a file under DATA_DIR or Postgres).

import { createHash, randomUUID } from "crypto";
import type { z } from "zod";
import type { City, Trip } from "../../../src/types.js";
import { TRIP_COLORS } from "../../../src/lib/tripColors.js";
import { VIBES } from "../../../src/lib/likeness.js";
import { addDays, daysBetween, todayIso, whatsNext, type RotationStay } from "../../../src/lib/rotation.js";
import { getCities, getCityById, searchCities } from "../cities.js";
import { getAllCitySeasonality, peekCitySeasonality, resolveCitySeasonality, type MonthSeasonality } from "../seasonality.js";
import { crowdProxyForMonth, loadHolidayIndexFromCache, type HolidayIndex } from "../crowd.js";
import { runLikeness } from "../likeness.js";
import { createJsonStore } from "../jsonStore.js";
import { readRotation } from "../rotation.js";
import { putTrip, type TripInput } from "../trips.js";
import { notify, publicBaseUrl, type NotifyResult } from "../notifier.js";
import { DEFAULT_ATLAS_CONFIG } from "./defaults.js";
import {
  atlasConfigSchema,
  atlasNotifyInputSchema,
  discoveryInputSchema,
  fireInputSchema,
  importInputSchema,
  signalInputSchema,
  wishlistPatchSchema,
  scanInputSchema,
  tripPlanInputSchema,
  wishlistEntryInputSchema,
  type AtlasConfig,
  type AtlasPlace,
  type AtlasSignal,
  type PlaceRef,
} from "./schemas.js";
import {
  baselineFor,
  checkGates,
  findWatchHits,
  hardFilterFailures,
  routeKey,
  scoreDiscovery,
  scoreFlight,
  selectCandidates,
  type FareRecord,
  type ScoredFlight,
  type WatchHit,
} from "./scoring.js";

export const MAX_FARES = 20_000;
export const MAX_RUNS = 200;

export interface ScanHighlight {
  flightId: string;
  destination: string;
  origin: string;
  departDate: string;
  returnDate: string;
  priceEur: number | null;
  composite: number;
  priceVsMedianPct: number | null;
  baselineDeal: boolean;
  opportunity: boolean;
  passed: boolean;
  bookingUrl: string | null;
}

export interface RunSummary {
  id: string;
  kind: "scan" | "discovery" | "fire";
  /** Fire runs only: whether the routine accepted the request. */
  status?: "fired" | "failed";
  detail?: string;
  /** Scan runs: the five best results, for the Scout screen. */
  highlights?: ScanHighlight[];
  mode: string;
  at: string;
  origin: string | null;
  counts: Record<string, number>;
  top?: { flightId: string; destination: string; priceEur: number | null; composite: number } | null;
  passed?: string[];
}

interface AtlasFile {
  version: 1;
  config?: AtlasConfig;
  configUpdatedAt?: string;
  places: AtlasPlace[];
  fares: FareRecord[];
  runs: RunSummary[];
  signals?: AtlasSignal[];
}

const store = createJsonStore<AtlasFile>("atlas.json", () => ({ version: 1, places: [], fares: [], runs: [] }));

/** Thrown for input the routine can fix; the route answers 400 with it. */
export class AtlasInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const nowIso = (now: Date) => now.toISOString();
const monthOf = (isoDate: string) => Number(isoDate.slice(5, 7));
const round = (n: number) => Math.round(n * 10) / 10;

// ── Places ───────────────────────────────────────────────────────────

/** The airport city for a code: the largest hub, then the most people. */
function cityByIata(code: string): City | undefined {
  const hubRank = (c: City) => (c.hub === "large" ? 2 : c.hub === "medium" ? 1 : 0);
  return getCities()
    .filter((c) => c.iata?.toUpperCase() === code.toUpperCase())
    .sort((a, b) => hubRank(b) - hubRank(a) || b.population - a.population)[0];
}

export function resolvePlace(ref: PlaceRef): City | undefined {
  if ("cityId" in ref) return getCityById(ref.cityId);
  if ("iata" in ref) return cityByIata(ref.iata);
  return searchCities(ref.query)[0];
}

const refText = (ref: PlaceRef) => ("cityId" in ref ? ref.cityId : "iata" in ref ? ref.iata : ref.query);

// ── Config ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars replace. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
  return out;
}

const configOf = (f: AtlasFile): AtlasConfig => f.config ?? DEFAULT_ATLAS_CONFIG;

export async function getConfig(): Promise<{ config: AtlasConfig; updatedAt: string | null }> {
  const f = await store.read();
  return { config: configOf(f), updatedAt: f.configUpdatedAt ?? null };
}

export async function setConfig(raw: unknown, mode: "patch" | "replace", now = new Date()) {
  return store.update((f) => {
    const next = atlasConfigSchema.safeParse(mode === "patch" ? deepMerge(configOf(f), raw) : raw);
    if (!next.success) throw new AtlasInputError("invalid_config", "The config does not validate.", next.error.issues);
    f.config = next.data;
    f.configUpdatedAt = nowIso(now);
    return { config: f.config, updatedAt: f.configUpdatedAt };
  });
}

// ── Wishlist ─────────────────────────────────────────────────────────

export async function listWishlist(): Promise<AtlasPlace[]> {
  return (await store.read()).places;
}

export interface Unresolved {
  place: PlaceRef;
  reason: string;
}

/** Upserts by city. A scouted upsert never demotes a wished place or drops its watch. */
export async function upsertWishlist(raw: unknown, now = new Date(), opts: { stampScouted?: boolean } = {}): Promise<{ entries: AtlasPlace[]; unresolved: Unresolved[] }> {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.entries) ? raw.entries : null;
  if (!list) throw new AtlasInputError("invalid_wishlist", "Send { entries: [...] }.");
  const parsed = list.map((e) => wishlistEntryInputSchema.safeParse(e));
  const bad = parsed.findIndex((p) => !p.success);
  if (bad !== -1) throw new AtlasInputError("invalid_wishlist", `Entry ${bad} does not validate.`, parsed[bad].error?.issues);

  const unresolved: Unresolved[] = [];
  const resolved: { city: City; input: z.output<typeof wishlistEntryInputSchema> }[] = [];
  for (const p of parsed) {
    const input = p.data!;
    const city = resolvePlace(input.place);
    if (!city) unresolved.push({ place: input.place, reason: `No city matches '${refText(input.place)}'` });
    else resolved.push({ city, input });
  }

  const entries = await store.update((f) => {
    const out: AtlasPlace[] = [];
    for (const { city, input } of resolved) {
      const at = nowIso(now);
      const idx = f.places.findIndex((p) => p.cityId === city.id);
      const prev = idx === -1 ? undefined : f.places[idx];
      const source = prev?.source === "wished" || input.source === "wished" ? "wished" : "scouted";
      const next: AtlasPlace = {
        cityId: city.id,
        name: city.name,
        country: city.country,
        ...(city.iata ? { iata: city.iata } : {}),
        lat: city.lat,
        lng: city.lng,
        source,
        intentTags: [...new Set([...(prev?.intentTags ?? []), ...input.intentTags])],
        avoidMonths: input.avoidMonths.length ? [...new Set(input.avoidMonths)].sort((a, b) => a - b) : (prev?.avoidMonths ?? []),
        ...(input.notes ?? prev?.notes ? { notes: input.notes ?? prev?.notes } : {}),
        ...(input.watch ? { watch: input.watch } : prev?.watch ? { watch: prev.watch } : {}),
        ...(input.discoveryScore != null ? { discoveryScore: input.discoveryScore } : prev?.discoveryScore != null ? { discoveryScore: prev.discoveryScore } : {}),
        priority: input.priority ?? prev?.priority ?? 3,
        addedAt: prev?.addedAt ?? at,
        ...(input.source === "scouted" && opts.stampScouted !== false ? { lastScoutedAt: at } : prev?.lastScoutedAt ? { lastScoutedAt: prev.lastScoutedAt } : {}),
        updatedAt: at,
      };
      if (idx === -1) f.places.push(next);
      else f.places[idx] = next;
      out.push(next);
    }
    return out;
  });
  return { entries, unresolved };
}

export async function removeFromWishlist(cityId: string): Promise<boolean> {
  return store.update((f) => {
    const before = f.places.length;
    f.places = f.places.filter((p) => p.cityId !== cityId);
    return f.places.length !== before;
  });
}

// ── Context ──────────────────────────────────────────────────────────

export interface ResolvedOrigin {
  cityId: string;
  name: string;
  country: string;
  iata: string | null;
  source: "rotation-current" | "rotation-next" | "rotation-home" | "fallback";
  stayId?: string;
}

interface StaySummary {
  id: string;
  cityId: string;
  name: string;
  country?: string;
  iata?: string;
  start?: string;
  end?: string;
  status: string;
}

const staySummary = (s: RotationStay | null): StaySummary | null =>
  s
    ? {
        id: s.id,
        cityId: s.place.cityId,
        name: s.place.name,
        ...(s.place.country ? { country: s.place.country } : {}),
        ...(s.place.iata ? { iata: s.place.iata } : {}),
        ...(s.start ? { start: s.start } : {}),
        ...(s.end ? { end: s.end } : {}),
        status: s.status,
      }
    : null;

function originFromCity(cityId: string, source: ResolvedOrigin["source"], stayId?: string): ResolvedOrigin | null {
  const city = getCityById(cityId);
  if (!city?.iata) return null;
  return { cityId: city.id, name: city.name, country: city.country, iata: city.iata, source, ...(stayId ? { stayId } : {}) };
}

/**
 * Where a run flies from: where the owner is (Current Location), else the next stay when it
 * starts within window A, else the rotation's home, else the first fallback airport Meridian knows.
 */
export function resolveOrigin(
  stays: RotationStay[],
  home: { cityId: string } | undefined,
  today: string,
  config: AtlasConfig
): { origin: ResolvedOrigin; rotation: { current: StaySummary | null; next: StaySummary | null; daysLeft: number | null; nextMoveDate: string | null } } {
  const w = whatsNext(stays, today);
  const rotation = { current: staySummary(w.current), next: staySummary(w.next), daysLeft: w.daysLeft, nextMoveDate: w.nextMoveDate };
  const fromCurrent = w.current && originFromCity(w.current.place.cityId, "rotation-current", w.current.id);
  if (fromCurrent) return { origin: fromCurrent, rotation };
  const soon = w.next?.start && daysBetween(today, w.next.start) <= config.windows.a.maxDays;
  const fromNext = soon && w.next ? originFromCity(w.next.place.cityId, "rotation-next", w.next.id) : null;
  if (fromNext) return { origin: fromNext, rotation };
  const fromHome = home && originFromCity(home.cityId, "rotation-home");
  if (fromHome) return { origin: fromHome, rotation };
  for (const code of config.hardFilters.fallbackOrigins) {
    const city = cityByIata(code);
    if (city) return { origin: { cityId: city.id, name: city.name, country: city.country, iata: code, source: "fallback" }, rotation };
  }
  const code = config.hardFilters.fallbackOrigins[0];
  return { origin: { cityId: "", name: code, country: "", iata: code, source: "fallback" }, rotation };
}

/** The months a date range touches, in order, without repeats. */
export function monthsBetween(from: string, to: string): number[] {
  const out: number[] = [];
  let y = Number(from.slice(0, 4));
  let m = monthOf(from);
  const endY = Number(to.slice(0, 4));
  const endM = monthOf(to);
  while (y < endY || (y === endY && m <= endM)) {
    if (!out.includes(m)) out.push(m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length === 12) break;
  }
  return out;
}

const MAX_CONTEXT_FETCHES = 4;

async function monthsFor(cityId: string, budget: { left: number }): Promise<MonthSeasonality[] | undefined> {
  const peek = peekCitySeasonality(cityId);
  if (peek.kind === "hit") return peek.months;
  if (peek.kind !== "miss" || budget.left <= 0) return undefined;
  budget.left -= 1;
  const r = await resolveCitySeasonality(cityId);
  return r.kind === "hit" ? r.months : undefined;
}

let holidayIndex: HolidayIndex | undefined | null = null;
function holidays(): HolidayIndex | undefined {
  if (holidayIndex === null) holidayIndex = loadHolidayIndexFromCache();
  return holidayIndex;
}

function crowdFor(cityId: string, month: number, months: MonthSeasonality[] | undefined): number | null {
  const c = crowdProxyForMonth(cityId, month, holidays(), () => months);
  return c ? Math.round(c.value) : null;
}

const RESEARCH_FRESH_DAYS = 30;
const MAX_RESEARCH_NEEDED = 12;
const MAX_IDEAS_PER_WINDOW = 5;

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface TripIdea {
  window: "a" | "b";
  from: string;
  to: string;
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  score: number;
  km: number | null;
  parts: { season: number | null; quiet: number | null; conditions: number | null; priority: number; near: number | null };
  reasons: string[];
}

/**
 * Wishlist places ranked for one window, from where the owner is: 0.35 season (comfort), 0.2 quiet
 * (researched quiet, else 100 minus the crowd proxy), 0.15 conditions (researched only), 0.15
 * priority, 0.15 nearness (100 at the origin, 0 at 8,000 km). A part with no figure is left out
 * and the rest reweighted. Places to avoid in every month of the window are skipped.
 */
export function rankIdeas(
  win: { key: "a" | "b"; from: string; to: string },
  places: { place: AtlasPlace; months?: MonthSeasonality[] }[],
  signals: readonly AtlasSignal[],
  from: { lat: number; lng: number } | null,
  crowd: (cityId: string, month: number, months?: MonthSeasonality[]) => number | null
): TripIdea[] {
  const winMonths = monthsBetween(win.from, win.to);
  const out: TripIdea[] = [];
  for (const { place, months } of places) {
    const ok = winMonths.filter((m) => !place.avoidMonths.includes(m));
    if (!ok.length) continue;
    const sig = signals.filter((x) => x.cityId === place.cityId && ok.includes(x.month));
    const season = months ? mean(ok.map((m) => months[m - 1].score)) : null;
    const q = mean(sig.flatMap((x) => (x.quiet != null ? [(x.quiet - 1) * 25] : [])));
    const crowds = ok.map((m) => crowd(place.cityId, m, months)).filter((c): c is number => c != null);
    const quiet = q ?? (crowds.length ? 100 - mean(crowds)! : null);
    const conditions = mean(sig.flatMap((x) => (x.conditions != null ? [(x.conditions - 1) * 25] : [])));
    const priority = ((place.priority ?? 3) - 1) * 25;
    const dist = from ? km(from, place) : null;
    const near = dist == null ? null : Math.max(0, 100 - dist / 80);
    const parts: [number | null, number][] = [
      [season, 0.35],
      [quiet, 0.2],
      [conditions, 0.15],
      [priority, 0.15],
      [near, 0.15],
    ];
    const used = parts.filter((p): p is [number, number] => p[0] != null);
    const score = used.reduce((a, [v, w]) => a + v * w, 0) / used.reduce((a, [, w]) => a + w, 0);
    const reasons: string[] = [];
    if (season != null) reasons.push(`comfort ${Math.round(season)} in ${ok.map((m) => MONTH_NAMES[m - 1]).join("-")}`);
    if (q != null) reasons.push(`researched quiet ${Math.round(q / 25 + 1)}/5`);
    else if (quiet != null) reasons.push(`crowds about ${Math.round(100 - quiet)} of 100 (proxy)`);
    if (conditions != null) reasons.push(`conditions ${Math.round(conditions / 25 + 1)}/5`);
    const events = sig.flatMap((x) => x.events.map((e) => e.title));
    if (events.length) reasons.push(`events: ${events.slice(0, 3).join(", ")}`);
    if (dist != null) reasons.push(`${Math.round(dist)} km away`);
    out.push({
      window: win.key,
      from: win.from,
      to: win.to,
      cityId: place.cityId,
      name: place.name,
      country: place.country,
      ...(place.iata ? { iata: place.iata } : {}),
      score: round(score),
      km: dist == null ? null : Math.round(dist),
      parts: { season: season == null ? null : round(season), quiet: quiet == null ? null : round(quiet), conditions: conditions == null ? null : round(conditions), priority, near: near == null ? null : round(near) },
      reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_IDEAS_PER_WINDOW);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const routineConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.ATLAS_ROUTINE_FIRE_URL?.trim() && env.ATLAS_ROUTINE_TOKEN?.trim());

export async function buildContext(today = todayIso()) {
  const f = await store.read();
  const config = configOf(f);
  const signals = f.signals ?? [];
  const rot = await readRotation();
  const { origin, rotation } = resolveOrigin(rot.stays as RotationStay[], rot.settings.home, today, config);
  const windows = {
    a: { from: addDays(today, config.windows.a.minDays), to: addDays(today, config.windows.a.maxDays) },
    b: { from: addDays(today, config.windows.b.minDays), to: addDays(today, config.windows.b.maxDays) },
  };
  const touched = [...new Set([...monthsBetween(windows.a.from, windows.a.to), ...monthsBetween(windows.b.from, windows.b.to)])];
  const thisMonth = monthOf(today);
  const fresh = addDays(today, -RESEARCH_FRESH_DAYS);
  const signalFor = (cityId: string, m: number) => signals.find((x) => x.cityId === cityId && x.month === m);

  const budget = { left: MAX_CONTEXT_FETCHES };
  const wishlist = [];
  const withMonths: { place: AtlasPlace; months?: MonthSeasonality[] }[] = [];
  const researchNeeded: { cityId: string; name: string; priority: number; months: number[] }[] = [];
  for (const place of f.places) {
    const months = await monthsFor(place.cityId, budget);
    withMonths.push({ place, months });
    const best = months
      ? months
          .map((m, i) => ({ month: i + 1, score: m.score }))
          .filter((m) => !place.avoidMonths.includes(m.month))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((m) => m.month)
      : [];
    wishlist.push({
      ...place,
      priority: place.priority ?? 3,
      season: {
        months: touched.map((m) => {
          const sig = signalFor(place.cityId, m);
          return { month: m, comfort: months ? Math.round(months[m - 1].score) : null, crowd: crowdFor(place.cityId, m, months), ...(sig ? { signal: sig } : {}) };
        }),
        /** Comfort for Jan..Dec, for a 12-month strip. */
        year: months ? months.map((m) => Math.round(m.score)) : null,
        bestMonths: best,
        avoidNow: place.avoidMonths.includes(thisMonth),
      },
    });
    // Research the window months and the two best months, skipping avoided ones and fresh research.
    const want = [...new Set([...touched, ...best.slice(0, 2)])].filter((m) => !place.avoidMonths.includes(m));
    const stale = want.filter((m) => {
      const sig = signalFor(place.cityId, m);
      return !sig || sig.researchedAt.slice(0, 10) < fresh;
    });
    if (stale.length) researchNeeded.push({ cityId: place.cityId, name: place.name, priority: place.priority ?? 3, months: stale });
  }
  researchNeeded.sort((a, b) => b.priority - a.priority);

  const from = origin.cityId ? getCityById(origin.cityId) ?? null : null;
  const ideas = [
    ...rankIdeas({ key: "a", ...windows.a }, withMonths, signals, from, crowdFor),
    ...rankIdeas({ key: "b", ...windows.b }, withMonths, signals, from, crowdFor),
  ];

  const cutoff = addDays(today, -config.discoveryWeights.repeatWindowDays);
  const recentlyScouted = f.places
    .filter((p) => p.lastScoutedAt && p.lastScoutedAt.slice(0, 10) >= cutoff)
    .map((p) => ({ cityId: p.cityId, name: p.name, ...(p.iata ? { iata: p.iata } : {}), at: p.lastScoutedAt! }));

  return {
    today,
    origin,
    fallbackOrigins: config.hardFilters.fallbackOrigins,
    rotation,
    windows,
    config,
    wishlist,
    ideas,
    researchNeeded: researchNeeded.slice(0, MAX_RESEARCH_NEEDED),
    recentlyScouted,
    lastRuns: f.runs.slice(0, 5),
    routine: { configured: routineConfigured() },
  };
}

// ── Wishlist edits ───────────────────────────────────────────────────

export async function patchWishlist(cityId: string, raw: unknown, now = new Date()): Promise<AtlasPlace | null> {
  const parsed = wishlistPatchSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_patch", "The change does not validate.", parsed.error.issues);
  const p = parsed.data;
  return store.update((f) => {
    const place = f.places.find((x) => x.cityId === cityId);
    if (!place) return null;
    if (p.priority !== undefined) place.priority = p.priority;
    if (p.intentTags !== undefined) place.intentTags = [...new Set(p.intentTags)];
    if (p.avoidMonths !== undefined) place.avoidMonths = [...new Set(p.avoidMonths)].sort((a, b) => a - b);
    if (p.notes === null) delete place.notes;
    else if (p.notes !== undefined) place.notes = p.notes;
    if (p.watch === null) delete place.watch;
    else if (p.watch !== undefined) place.watch = p.watch;
    if (p.source !== undefined) place.source = p.source;
    place.updatedAt = nowIso(now);
    return place;
  });
}

// ── Season research ──────────────────────────────────────────────────

export const MAX_SIGNALS = 3000;

export async function recordSignals(raw: unknown, now = new Date()): Promise<{ stored: number; unresolved: Unresolved[] }> {
  const list = isObject(raw) && Array.isArray(raw.signals) ? raw.signals : null;
  if (!list) throw new AtlasInputError("invalid_signals", "Send { signals: [...] }.");
  const parsed = list.map((x) => signalInputSchema.safeParse(x));
  const bad = parsed.findIndex((p) => !p.success);
  if (bad !== -1) throw new AtlasInputError("invalid_signals", `Signal ${bad} does not validate.`, parsed[bad].error?.issues);
  const unresolved: Unresolved[] = [];
  const rows: AtlasSignal[] = [];
  for (const p of parsed) {
    const x = p.data!;
    const city = resolvePlace(x.place);
    if (!city) {
      unresolved.push({ place: x.place, reason: `No city matches '${refText(x.place)}'` });
      continue;
    }
    rows.push({
      cityId: city.id,
      month: x.month,
      ...(x.quiet != null ? { quiet: x.quiet } : {}),
      ...(x.conditions != null ? { conditions: x.conditions } : {}),
      events: x.events,
      ...(x.note ? { note: x.note } : {}),
      sources: x.sources,
      researchedAt: nowIso(now),
    });
  }
  await store.update((f) => {
    const keep = (f.signals ?? []).filter((old) => !rows.some((r) => r.cityId === old.cityId && r.month === old.month));
    f.signals = [...rows, ...keep].slice(0, MAX_SIGNALS);
  });
  return { stored: rows.length, unresolved };
}

export async function listSignals(cityId?: string): Promise<AtlasSignal[]> {
  const all = (await store.read()).signals ?? [];
  return cityId ? all.filter((x) => x.cityId === cityId).sort((a, b) => a.month - b.month) : all;
}

// ── Firing the routine ───────────────────────────────────────────────

/**
 * Starts the Atlas routine through its API trigger (ATLAS_ROUTINE_FIRE_URL and ATLAS_ROUTINE_TOKEN,
 * from the routine's API trigger on claude.ai). The routine reads its context from /api/atlas itself,
 * so the payload only names the mode.
 */
export async function fireRoutine(raw: unknown, deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: Date } = {}): Promise<RunSummary> {
  const parsed = fireInputSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AtlasInputError("invalid_run", "The run request does not validate.", parsed.error.issues);
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const run: RunSummary = { id: runId("fire", now), kind: "fire", mode: parsed.data.mode, at: nowIso(now), origin: null, counts: {}, status: "fired" };
  if (!routineConfigured(env)) {
    run.status = "failed";
    run.detail = "ATLAS_ROUTINE_FIRE_URL and ATLAS_ROUTINE_TOKEN are not set on the server.";
  } else {
    const text = [`atlas ${parsed.data.mode}`, `run_id: ${run.id}`, ...(parsed.data.text ? ["", parsed.data.text] : [])].join("\n");
    try {
      const res = await (deps.fetch ?? fetch)(env.ATLAS_ROUTINE_FIRE_URL!.trim(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.ATLAS_ROUTINE_TOKEN!.trim()}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "experimental-cc-routine-2026-04-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        run.status = "failed";
        run.detail = `The routine trigger answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
      }
    } catch (err) {
      run.status = "failed";
      run.detail = `The routine trigger could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
  }
  await store.update((f) => {
    f.runs.unshift(run);
    f.runs = f.runs.slice(0, MAX_RUNS);
  });
  return run;
}

// ── Seasonal ranking ─────────────────────────────────────────────────

export interface SeasonalRow {
  cityId: string;
  name: string;
  country: string;
  iata: string;
  comfort: number;
  crowd: number | null;
  strength: number | null;
  role: "source" | "echo" | null;
  score: number;
}

const KNOWN_VIBES = new Set(VIBES.map((v) => v.id));

/**
 * Cities with an airport for the given months, ranked. With vibes: 0.55 comfort, 0.25 quiet
 * (100 minus crowd) and 0.2 likeness strength. Without: 0.7 comfort and 0.3 quiet. A city
 * with no crowd figure is ranked on its other parts, reweighted. Comfort comes from the
 * cached normals only; this never calls the climate provider.
 */
export async function seasonalRanking(q: { months: number[]; vibes?: string[]; profileId?: string; limit?: number }) {
  const f = await store.read();
  const config = configOf(f);
  const profile = q.profileId ? config.tripProfiles.find((p) => p.id === q.profileId) : undefined;
  if (q.profileId && !profile) throw new AtlasInputError("unknown_profile", `No trip profile '${q.profileId}'.`);
  const vibes = [...new Set([...(q.vibes ?? []), ...(profile?.vibes ?? [])])].filter((v) => KNOWN_VIBES.has(v));
  const months = q.months.length ? q.months : [monthOf(todayIso())];
  const limit = Math.max(1, Math.min(100, q.limit ?? 25));

  const likeness = new Map<string, { strength: number; role: "source" | "echo" }>();
  let pool: string[];
  if (vibes.length) {
    const res = runLikeness({ vibes, like: [], level: "city", limit: 300 });
    if (res.level === "city") for (const r of [...res.sources, ...res.echoes]) likeness.set(r.cityId, { strength: r.strength, role: r.role });
    pool = [...likeness.keys()];
  } else {
    pool = Object.keys(getAllCitySeasonality());
  }

  const rows: SeasonalRow[] = [];
  for (const cityId of pool) {
    const city = getCityById(cityId);
    if (!city?.iata) continue;
    const peek = peekCitySeasonality(cityId);
    if (peek.kind !== "hit") continue;
    const comfort = months.reduce((s, m) => s + peek.months[m - 1].score, 0) / months.length;
    const crowds = months.map((m) => crowdFor(cityId, m, peek.months)).filter((c): c is number => c != null);
    const crowd = crowds.length ? crowds.reduce((a, b) => a + b, 0) / crowds.length : null;
    const lk = likeness.get(cityId);
    const parts: [number, number][] = vibes.length ? [[comfort, 0.55], [lk?.strength ?? 0, 0.2]] : [[comfort, 0.7]];
    if (crowd != null) parts.push([100 - crowd, vibes.length ? 0.25 : 0.3]);
    const weight = parts.reduce((s, [, w]) => s + w, 0);
    const score = parts.reduce((s, [v, w]) => s + v * w, 0) / weight;
    rows.push({
      cityId,
      name: city.name,
      country: city.country,
      iata: city.iata,
      comfort: round(comfort),
      crowd: crowd == null ? null : round(crowd),
      strength: lk ? round(lk.strength) : null,
      role: lk?.role ?? null,
      score: round(score),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return { months, vibes, cities: rows.slice(0, limit) };
}

// ── Scans ────────────────────────────────────────────────────────────

const runId = (prefix: string, now: Date) => `${prefix}_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;

export async function recordScan(raw: unknown, now = new Date()) {
  const parsed = scanInputSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_scan", "The scan does not validate.", parsed.error.issues);
  const input = parsed.data;
  const byId = new Map(input.annotations.map((a) => [a.flightId, a]));
  const missing = input.flights.filter((fl) => !byId.has(fl.id)).map((fl) => fl.id);
  if (missing.length) throw new AtlasInputError("missing_annotations", `No annotation for: ${missing.join(", ")}`);

  const id = runId("scan", now);
  const snapshotDate = now.toISOString().slice(0, 10);

  return store.update((f) => {
    const config = configOf(f);
    const tagsByIata = new Map(f.places.filter((p) => p.iata).map((p) => [p.iata!, p.intentTags]));
    const scored: ScoredFlight[] = [];
    const rejected: { flight: (typeof input.flights)[number]; reasons: string[] }[] = [];

    for (const flight of input.flights) {
      const reasons = hardFilterFailures(flight, config.hardFilters, input.overrides);
      if (reasons.length) {
        rejected.push({ flight, reasons });
        continue;
      }
      const annotation = byId.get(flight.id)!;
      const baseline = baselineFor(routeKey(flight.origin, flight.destination), f.fares);
      const s = scoreFlight(flight, annotation, baseline, config.scoringWeights, tagsByIata.get(flight.destination) ?? config.profile.intentTags);
      const gates = checkGates({ composite: s.composite, annotation }, config.tripPreferences.gates, input.relaxGates === true);
      scored.push({ flight, annotation, baseline, ...s, gates });
    }
    scored.sort((a, b) => b.composite - a.composite);

    // Baselines learn from every priced, non-distorted fare, rejected ones included: a fare over
    // this run's budget is still the route's price.
    for (const flight of input.flights) {
      const a = byId.get(flight.id)!;
      if (flight.priceEur == null || flight.error || a.distortion) continue;
      f.fares.unshift({
        route: routeKey(flight.origin, flight.destination),
        origin: flight.origin,
        destination: flight.destination,
        priceEur: flight.priceEur,
        departDate: flight.departDate,
        returnDate: flight.returnDate,
        snapshotDate,
        source: flight.source,
        runId: id,
      });
    }
    f.fares = f.fares.slice(0, MAX_FARES);

    const selection = selectCandidates(scored);
    const watchHits: WatchHit[] = findWatchHits(scored, f.places);
    const top = scored.find((s) => s.flight.id === selection.top);
    f.runs.unshift({
      id,
      kind: "scan",
      mode: input.mode,
      at: nowIso(now),
      origin: input.origin,
      counts: { flights: input.flights.length, scored: scored.length, rejected: rejected.length, passed: scored.filter((s) => s.gates.passed).length, watchHits: watchHits.length },
      top: top ? { flightId: top.flight.id, destination: top.flight.destinationName, priceEur: top.flight.priceEur, composite: top.composite } : null,
      highlights: scored.slice(0, 5).map((s) => ({
        flightId: s.flight.id,
        destination: s.flight.destinationName,
        origin: s.flight.origin,
        departDate: s.flight.departDate,
        returnDate: s.flight.returnDate,
        priceEur: s.flight.priceEur,
        composite: s.composite,
        priceVsMedianPct: s.priceVsMedianPct,
        baselineDeal: s.baselineDeal,
        opportunity: s.opportunity,
        passed: s.gates.passed,
        bookingUrl: s.flight.bookingUrl,
      })),
    });
    f.runs = f.runs.slice(0, MAX_RUNS);
    return { runId: id, scored, rejected, watchHits, selection };
  });
}

// ── Discovery ────────────────────────────────────────────────────────

export async function recordDiscovery(raw: unknown, now = new Date()) {
  const parsed = discoveryInputSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_discovery", "The discovery run does not validate.", parsed.error.issues);
  const input = parsed.data;
  const today = now.toISOString().slice(0, 10);
  const id = runId("disc", now);

  const unresolved: Unresolved[] = [];
  const found = input.candidates.flatMap((c) => {
    const city = resolvePlace(c.place);
    if (!city) {
      unresolved.push({ place: c.place, reason: `No city matches '${refText(c.place)}'` });
      return [];
    }
    return [{ c, city }];
  });

  const result = await store.update((f) => {
    const config = configOf(f);
    const w = config.discoveryWeights;
    const cutoff = addDays(today, -w.repeatWindowDays);
    const recent = new Set(f.places.filter((p) => p.lastScoutedAt && p.lastScoutedAt.slice(0, 10) >= cutoff).map((p) => p.cityId));
    const month = monthOf(today);
    const scored = found
      .map(({ c, city }) => {
        const s = scoreDiscovery(c, w, recent.has(city.id));
        const peek = peekCitySeasonality(city.id);
        return {
          ...c,
          cityId: city.id,
          name: city.name,
          ...(city.iata ? { iata: city.iata } : {}),
          composite: s.composite,
          repeatPenalty: s.repeatPenalty,
          thinPriceSignal: s.thinPriceSignal,
          comfortNow: peek.kind === "hit" ? Math.round(peek.months[month - 1].score) : null,
          passed: false,
        };
      })
      .sort((a, b) => b.composite - a.composite);
    let kept = 0;
    for (const s of scored) {
      if (s.composite >= w.minCompositeScore && kept < w.maxCandidatesPerRun) {
        s.passed = true;
        kept += 1;
      }
    }
    f.runs.unshift({
      id,
      kind: "discovery",
      mode: "discovery",
      at: nowIso(now),
      origin: input.origin ?? null,
      counts: { candidates: input.candidates.length, scored: scored.length, passed: kept, unresolved: unresolved.length },
      passed: scored.filter((s) => s.passed).map((s) => s.cityId),
    });
    f.runs = f.runs.slice(0, MAX_RUNS);
    return scored;
  });

  const passing = result.filter((s) => s.passed);
  if (passing.length) {
    await upsertWishlist(
      passing.map((s) => ({
        place: { cityId: s.cityId },
        source: "scouted",
        intentTags: s.intentTags,
        avoidMonths: s.avoidMonths,
        notes: s.reason,
        discoveryScore: s.composite,
      })),
      now
    );
  }
  return { runId: id, scored: result, unresolved };
}

// ── Trips ────────────────────────────────────────────────────────────

const eurMoney = (amount: number) => ({ amount: Math.round(amount * 100) / 100, currency: "EUR" });
const eurText = (n: number | null | undefined) => (n == null ? "not priced" : `${Math.round(n)} EUR`);

export function atlasTripId(cityId: string, departDate: string): string {
  return `atlas-${cityId}-${departDate}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
}

export async function createTripFromPlan(raw: unknown) {
  const parsed = tripPlanInputSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_trip", "The trip plan does not validate.", parsed.error.issues);
  const plan = parsed.data;
  const origin = resolvePlace(plan.origin);
  const dest = resolvePlace(plan.destination);
  if (!origin) throw new AtlasInputError("unknown_origin", `No city matches '${refText(plan.origin)}'.`);
  if (!dest) throw new AtlasInputError("unknown_destination", `No city matches '${refText(plan.destination)}'.`);

  const node = (c: City) => ({ cityId: c.id, name: c.name, ...(c.iata ? { iata: c.iata } : {}), lat: c.lat, lng: c.lng });
  const nights = daysBetween(plan.departDate, plan.returnDate);
  const stayTotal = plan.stay?.totalEur ?? (plan.stay?.pricePerNightEur != null ? plan.stay.pricePerNightEur * nights : undefined);

  const notes = [
    `Planned by Atlas. Flight ${plan.departDate} to ${plan.returnDate}: ${eurText(plan.flight.priceEur)}` +
      (plan.flight.stops != null ? `, ${plan.flight.stops} stops` : "") +
      (plan.flight.travelHours != null ? `, ${plan.flight.travelHours} h` : "") +
      (plan.flight.layover ? ` via ${plan.flight.layover}` : "") +
      (plan.flight.carrier ? ` (${plan.flight.carrier})` : "") +
      ".",
    plan.flight.bookingUrl ? `Book the flight: ${plan.flight.bookingUrl}` : null,
    plan.stay?.summary ? `Stay: ${plan.stay.name}${plan.stay.rating != null ? `, rated ${plan.stay.rating}` : ""}. ${plan.stay.summary}` : null,
    plan.stayAlternative
      ? `Other stay: ${plan.stayAlternative.name}${plan.stayAlternative.pricePerNightEur != null ? `, ${Math.round(plan.stayAlternative.pricePerNightEur)} EUR a night` : ""}${plan.stayAlternative.link ? ` (${plan.stayAlternative.link})` : ""}.`
      : null,
    plan.totals
      ? `Estimate: flight ${eurText(plan.totals.flightEur)}, stay ${eurText(plan.totals.stayEur)}, activities ${eurText(plan.totals.activitiesEur)}, total ${eurText(plan.totals.totalEur)}.`
      : null,
    plan.notes ?? null,
  ]
    .filter(Boolean)
    .join("\n");

  const input: TripInput = {
    name: plan.name ?? `Atlas: ${dest.name}`,
    color: TRIP_COLORS[0],
    status: "scouting",
    year: Number(plan.departDate.slice(0, 4)),
    season: { start: monthOf(plan.departDate), end: monthOf(plan.returnDate) },
    departure: node(origin),
    returnHome: true,
    ...(plan.travellers ? { travellers: plan.travellers } : {}),
    nodes: [
      {
        ...node(dest),
        months: { start: monthOf(plan.departDate), end: monthOf(plan.returnDate) },
        arrive: plan.departDate,
        depart: plan.returnDate,
        ...(plan.stay
          ? {
              lodging: {
                name: plan.stay.name,
                ...(plan.stay.kind ? { kind: plan.stay.kind } : {}),
                ...(plan.stay.address ? { address: plan.stay.address } : {}),
                checkIn: plan.departDate,
                checkOut: plan.returnDate,
                ...(stayTotal != null ? { cost: eurMoney(stayTotal) } : {}),
                ...(plan.stay.link ? { link: plan.stay.link } : {}),
              },
            }
          : {}),
        activities: plan.activities.map((a, i) => {
          const extra = [a.durationHours != null ? `${a.durationHours} h` : null, a.rating != null ? `rated ${a.rating}` : null].filter(Boolean).join(", ");
          const note = [a.note, extra].filter(Boolean).join(" ");
          return {
            id: `atlas-${i + 1}`,
            title: a.title,
            date: a.date,
            ...(a.time ? { time: a.time } : {}),
            ...(a.costEur != null ? { cost: eurMoney(a.costEur) } : {}),
            ...(a.link ? { link: a.link } : {}),
            ...(note ? { note: note.slice(0, 1000) } : {}),
          };
        }),
        notes: notes.slice(0, 4000),
        travel: { fromCityId: origin.id, mode: "flight" as const },
      },
    ],
    homeLeg: { fromCityId: dest.id, mode: "flight" },
  };

  const id = atlasTripId(dest.id, plan.departDate);
  const trip = await putTrip(id, input);
  const path = `/#/trips/plan/${encodeURIComponent(id)}`;
  const base = publicBaseUrl();
  return { trip: trip as Trip, url: base ? `${base}${path}` : path };
}

// ── Notices ──────────────────────────────────────────────────────────

export async function atlasNotify(raw: unknown): Promise<NotifyResult> {
  const parsed = atlasNotifyInputSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_notice", "The notice does not validate.", parsed.error.issues);
  const n = parsed.data;
  const hash = createHash("sha256").update(`${n.title}\n${n.body}`).digest("hex").slice(0, 16);
  return notify({
    kind: `atlas-${n.kind}`,
    title: n.title,
    body: n.body,
    url: n.url ?? "/#/trips",
    dedupeKey: `atlas-${n.kind}:${n.dedupeKey ?? hash}`,
  });
}

// ── Runs, fares, import ──────────────────────────────────────────────

export async function listRuns(limit = 20): Promise<RunSummary[]> {
  return (await store.read()).runs.slice(0, Math.max(1, Math.min(MAX_RUNS, limit)));
}

export async function routeFares(route: string) {
  const key = route.toUpperCase();
  if (!/^[A-Z]{3}-[A-Z]{3}$/.test(key)) throw new AtlasInputError("invalid_route", "A route is two airport codes, like MAD-LIS.");
  const f = await store.read();
  return {
    route: key,
    baseline: baselineFor(key, f.fares),
    fares: f.fares.filter((x) => x.route === key).map(({ priceEur, departDate, snapshotDate, source }) => ({ priceEur, departDate, snapshotDate, source })),
  };
}

/**
 * Legacy trip profiles have no vibes and lack profiles added since. Merge them by id over the
 * defaults (legacy fields win, default vibes stay) and keep the default-only profiles.
 */
function withDefaultProfiles(config: unknown): unknown {
  if (!isObject(config) || !Array.isArray(config.tripProfiles)) return config;
  const legacy = config.tripProfiles.filter(isObject);
  const ids = new Set(legacy.map((p) => p.id));
  const merged = legacy.map((p) => {
    const d = DEFAULT_ATLAS_CONFIG.tripProfiles.find((x) => x.id === p.id);
    return d ? { ...d, ...p, vibes: Array.isArray(p.vibes) && p.vibes.length ? p.vibes : d.vibes } : p;
  });
  return { ...config, tripProfiles: [...merged, ...DEFAULT_ATLAS_CONFIG.tripProfiles.filter((d) => !ids.has(d.id))] };
}

export async function importLegacy(raw: unknown, now = new Date()) {
  const parsed = importInputSchema.safeParse(raw);
  if (!parsed.success) throw new AtlasInputError("invalid_import", "The import does not validate.", parsed.error.issues);
  const input = parsed.data;
  let config = false;
  if (input.config !== undefined) {
    await setConfig(withDefaultProfiles(input.config), "patch", now);
    config = true;
  }
  let wishlist = { added: 0, unresolved: 0 };
  if (input.wishlist?.length) {
    // Imported places were scouted in the past, not now: no repeat penalty from the import itself.
    const r = await upsertWishlist(input.wishlist, now, { stampScouted: false });
    wishlist = { added: r.entries.length, unresolved: r.unresolved.length };
  }
  const fares = await store.update((f) => {
    const seen = new Set(f.fares.map((x) => `${x.route}|${x.departDate}|${x.snapshotDate}|${x.priceEur}`));
    let added = 0;
    let skipped = 0;
    for (const x of input.fares ?? []) {
      const rec: FareRecord = { route: routeKey(x.origin, x.destination), ...x };
      const key = `${rec.route}|${rec.departDate}|${rec.snapshotDate}|${rec.priceEur}`;
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      f.fares.push(rec);
      added += 1;
    }
    f.fares.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
    f.fares = f.fares.slice(0, MAX_FARES);
    return { added, skipped };
  });
  return { config, wishlist, fares };
}

/** Test seam: forget the cached holiday index. */
export function resetAtlasCaches(): void {
  holidayIndex = null;
}
