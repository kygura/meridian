// Converts the legacy Atlas repository data (snake_case, kept under legacy/)
// into the camelCase payload for POST /api/atlas/import.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlasConfigPatch, ImportFare, ImportInput, PartialRange, WishlistEntryInput } from "./client";

type Obj = Record<string, unknown>;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function numArray(v: unknown): number[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : undefined;
}

/** Drops undefined values so the payload carries only what the legacy file had. */
function compact<T extends Obj>(o: T): T {
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) delete o[key];
  }
  return o;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── Months ───────────────────────────────────────────────────────────

function monthFromToken(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : null;
  }
  const idx = MONTH_NAMES.indexOf(t.slice(0, 3));
  return idx === -1 ? null : idx + 1;
}

/**
 * Month names ("Aug", "December") or numbers to month numbers. A range such as
 * "Jun-Aug" expands to 6, 7, 8 (wrapping past December).
 */
export function monthsFromPeriods(periods: unknown): number[] {
  const out = new Set<number>();
  for (const item of Array.isArray(periods) ? periods : []) {
    if (typeof item === "number") {
      if (Number.isInteger(item) && item >= 1 && item <= 12) out.add(item);
      continue;
    }
    if (typeof item !== "string") continue;
    const range = /^\s*([A-Za-z]+|\d{1,2})\s*(?:-|\u2013|\u2014|\bto\b)\s*([A-Za-z]+|\d{1,2})\s*$/.exec(item);
    if (range) {
      const from = monthFromToken(range[1] as string);
      const to = monthFromToken(range[2] as string);
      if (from !== null && to !== null) {
        for (let m = from; ; m = (m % 12) + 1) {
          out.add(m);
          if (m === to) break;
        }
        continue;
      }
    }
    const single = monthFromToken(item);
    if (single !== null) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

// ── Config ───────────────────────────────────────────────────────────

function range(v: unknown): { min: number; max: number } | undefined {
  if (!isObj(v)) return undefined;
  const min = num(v.min);
  const max = num(v.max);
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

export function convertHardFilters(raw: unknown): AtlasConfigPatch["hardFilters"] | undefined {
  if (!isObj(raw)) return undefined;
  return compact({
    maxStops: num(raw.max_stops),
    maxTravelTimeHours: num(raw.max_travel_time_hours),
    maxLayoverWaitHours: num(raw.max_layover_wait_hours),
    budgetEconomyEur: range(raw.budget_economy_eur),
    fallbackOrigins: strArray(raw.fallback_origins),
    lastminuteWindowDays: num(raw.lastminute_window_days)
  });
}

export function convertScoringWeights(raw: unknown): AtlasConfigPatch["scoringWeights"] | undefined {
  if (!isObj(raw)) return undefined;
  return compact({
    priceVsBaseline: num(raw.price_vs_baseline),
    weather: num(raw.weather_score),
    crowd: num(raw.crowd_level),
    surf: num(raw.surf_quality),
    isolation: num(raw.isolation_score),
    opportunityThreshold: num(raw.opportunity_threshold)
  });
}

export function convertDiscoveryWeights(raw: unknown): AtlasConfigPatch["discoveryWeights"] | undefined {
  if (!isObj(raw)) return undefined;
  return compact({
    weather: num(raw.weather_score),
    tourismSeason: num(raw.tourism_season_score),
    conditions: num(raw.conditions_score),
    priceSignal: num(raw.price_signal),
    minCompositeScore: num(raw.min_composite_score),
    repeatPenalty: num(raw.repeat_penalty),
    repeatWindowDays: num(raw.repeat_window_days),
    maxCandidatesPerRun: num(raw.max_candidates_per_run)
  });
}

export function convertProfile(raw: unknown): AtlasConfigPatch["profile"] | undefined {
  if (!isObj(raw)) return undefined;
  return compact({
    persona: str(raw.persona),
    intentTags: strArray(raw.intent_tags),
    luxuryExceptions: str(raw.luxury_exceptions),
    avoid: strArray(raw.avoid)
  });
}

export function convertTripPreferences(raw: unknown): AtlasConfigPatch["tripPreferences"] | undefined {
  if (!isObj(raw)) return undefined;
  const out: NonNullable<AtlasConfigPatch["tripPreferences"]> = {};
  if (isObj(raw.validation_gates)) {
    const g = raw.validation_gates;
    out.gates = compact({
      minCompositeScore: num(g.min_composite_score),
      minWeatherScore: num(g.min_weather_score),
      allowPeakCrowds: typeof g.allow_peak_crowds === "boolean" ? g.allow_peak_crowds : undefined,
      minIsolationScore: num(g.min_isolation_score)
    });
  }
  if (isObj(raw.accommodation)) {
    const a = raw.accommodation;
    out.accommodation = compact({
      style: strArray(a.style),
      minRating: num(a.min_rating),
      excludedChains: strArray(a.excluded_chains),
      sortBy: str(a.sort_by)
    });
  }
  if (isObj(raw.activities)) {
    const a = raw.activities;
    out.activities = compact({
      tags: strArray(a.tags),
      avoidTags: strArray(a.avoid_tags),
      groupSizePref: str(a.group_size_pref),
      includeRestaurants: typeof a.include_restaurants === "boolean" ? a.include_restaurants : undefined,
      includeNightlife: typeof a.include_nightlife === "boolean" ? a.include_nightlife : undefined,
      maxPerDay: num(a.max_per_day),
      budgetPerDayEur: num(a.budget_per_day_eur)
    });
  }
  if (isObj(raw.planning)) {
    const p = raw.planning;
    out.planning = compact({
      maxFullPlans: num(p.max_candidates_full_plan),
      maxAlternatives: num(p.max_candidates_alternative),
      tripBudgetEur: p.trip_budget_eur === null ? null : num(p.trip_budget_eur)
    });
  }
  return out;
}

export function convertTripProfiles(raw: unknown): NonNullable<AtlasConfigPatch["tripProfiles"]> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const profiles: NonNullable<AtlasConfigPatch["tripProfiles"]> = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const id = str(item.id);
    const label = str(item.label);
    if (!id || !label) continue;
    profiles.push({
      id,
      label,
      aliases: strArray(item.aliases) ?? [],
      criteria: strArray(item.criteria) ?? [],
      vibes: strArray(item.vibes) ?? [],
      relevantMonths: numArray(item.relevant_months) ?? [],
      maxResults: num(item.max_results) ?? 3
    });
  }
  return profiles;
}

export interface LegacyConfigFiles {
  hardFilters?: unknown;
  scoringWeights?: unknown;
  discoveryWeights?: unknown;
  travellerProfile?: unknown;
  tripPreferences?: unknown;
  tripProfiles?: unknown;
}

export function convertConfig(files: LegacyConfigFiles): AtlasConfigPatch | undefined {
  const config: AtlasConfigPatch = compact({
    profile: convertProfile(files.travellerProfile),
    hardFilters: convertHardFilters(files.hardFilters),
    scoringWeights: convertScoringWeights(files.scoringWeights),
    discoveryWeights: convertDiscoveryWeights(files.discoveryWeights),
    tripPreferences: convertTripPreferences(files.tripPreferences),
    tripProfiles: convertTripProfiles(files.tripProfiles)
  });
  return Object.keys(config).length > 0 ? config : undefined;
}

// ── Wishlist ─────────────────────────────────────────────────────────

function budgetToRange(v: unknown): PartialRange | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return { max: v };
  if (isObj(v)) {
    const r = compact({ min: num(v.min), max: num(v.max) });
    return Object.keys(r).length > 0 ? r : undefined;
  }
  return undefined;
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export interface WishlistConversion {
  entries: WishlistEntryInput[];
  skipped: number;
  duplicates: number;
}

/**
 * Legacy wishlist entries to import entries. `source: "user_requested"` becomes a wished
 * place with a watch; everything else is scouted. Entries are deduplicated by IATA code:
 * the first one is kept and later ones add their tags, avoid months and (when missing) notes.
 */
export function convertWishlist(raw: unknown): WishlistConversion {
  const byIata = new Map<string, WishlistEntryInput>();
  let skipped = 0;
  let duplicates = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    const iata = isObj(item) ? str(item.iata)?.toUpperCase() : undefined;
    if (!isObj(item) || !iata || !/^[A-Z]{3}$/.test(iata)) {
      skipped++;
      continue;
    }
    const wished = item.source === "user_requested";
    const entry: WishlistEntryInput = {
      place: { iata },
      source: wished ? "wished" : "scouted",
      intentTags: strArray(item.intent_tags) ?? [],
      avoidMonths: monthsFromPeriods(item.avoid_periods),
      ...(str(item.notes) ? { notes: str(item.notes) } : {}),
      ...(num(item.discovery_score) !== undefined ? { discoveryScore: num(item.discovery_score) } : {})
    };
    if (wished) {
      entry.watch = compact({
        active: item.watch_active === false ? false : true,
        targetBudgetEur: budgetToRange(item.target_budget_eur),
        chatId: item.requested_by !== undefined && item.requested_by !== null ? String(item.requested_by) : undefined
      });
    }
    const existing = byIata.get(iata);
    if (!existing) {
      byIata.set(iata, entry);
      continue;
    }
    duplicates++;
    existing.intentTags = uniq([...(existing.intentTags ?? []), ...(entry.intentTags ?? [])]);
    existing.avoidMonths = uniq([...(existing.avoidMonths ?? []), ...(entry.avoidMonths ?? [])]).sort((a, b) => a - b);
    if (!existing.notes && entry.notes) existing.notes = entry.notes;
    if (entry.source === "wished") {
      existing.source = "wished";
      existing.watch = existing.watch ?? entry.watch;
    }
  }
  return { entries: [...byIata.values()], skipped, duplicates };
}

// ── Fares ────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface FaresConversion {
  fares: ImportFare[];
  skipped: number;
}

/**
 * Legacy scan records (data/*.json) to fares. Results flagged as distorted, without a
 * price, with a search error or with unusable airports or dates are skipped. The same
 * fare seen twice (same route, dates, snapshot and price) is kept once.
 */
export function convertScanRecords(records: unknown[]): FaresConversion {
  const seen = new Set<string>();
  const fares: ImportFare[] = [];
  let skipped = 0;
  for (const record of records) {
    if (!isObj(record) || !Array.isArray(record.results)) continue;
    const scanDate = str(record.scan_date);
    for (const result of record.results) {
      if (!isObj(result) || !isObj(result.flight)) {
        skipped++;
        continue;
      }
      const f = result.flight;
      const annotation = isObj(result.annotation) ? result.annotation : null;
      const origin = str(f.origin)?.toUpperCase();
      const destination = str(f.destination)?.toUpperCase();
      const price = num(f.price_economy_eur);
      const departDate = str(f.travel_window_start);
      const returnDate = str(f.travel_window_end);
      const snapshotDate = str(f.snapshot_date) ?? scanDate;
      const usable =
        annotation?.distortion_flag !== true &&
        !str(f.search_error) &&
        price !== undefined &&
        price > 0 &&
        origin !== undefined &&
        /^[A-Z]{3}$/.test(origin) &&
        destination !== undefined &&
        /^[A-Z]{3}$/.test(destination) &&
        departDate !== undefined &&
        ISO_DATE.test(departDate) &&
        snapshotDate !== undefined &&
        ISO_DATE.test(snapshotDate);
      if (!usable) {
        skipped++;
        continue;
      }
      const key = [origin, destination, departDate, returnDate ?? "", snapshotDate, price].join("|");
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      fares.push(
        compact({
          origin,
          destination,
          priceEur: price,
          departDate,
          returnDate: returnDate && ISO_DATE.test(returnDate) ? returnDate : undefined,
          snapshotDate,
          source: str(f.source)?.slice(0, 40) ?? "atlas-legacy"
        }) as ImportFare
      );
    }
  }
  return { fares, skipped };
}

// ── Directory loader ─────────────────────────────────────────────────

export interface LegacyBundle {
  payload: ImportInput;
  summary: {
    configSections: string[];
    wishlist: { entries: number; duplicates: number; skipped: number };
    fares: { fares: number; skipped: number; scanFiles: number };
  };
}

function readIfExists(path: string): unknown {
  return existsSync(path) ? readJson(path) : undefined;
}

/** Reads `<dir>/config/*.json` and `<dir>/data/*.json` and builds the import payload. */
export function loadLegacyDir(dir: string): LegacyBundle {
  const configDir = join(dir, "config");
  const dataDir = join(dir, "data");
  if (!existsSync(configDir) && !existsSync(dataDir)) {
    throw new Error(`No legacy data found: expected ${configDir} or ${dataDir}.`);
  }

  const config = convertConfig({
    hardFilters: readIfExists(join(configDir, "hard_filters.json")),
    scoringWeights: readIfExists(join(configDir, "scoring_weights.json")),
    discoveryWeights: readIfExists(join(configDir, "discovery_weights.json")),
    travellerProfile: readIfExists(join(configDir, "traveller_profile.json")),
    tripPreferences: readIfExists(join(configDir, "trip_preferences.json")),
    tripProfiles: readIfExists(join(configDir, "trip_profiles.json"))
  });

  const wishlist = convertWishlist(readIfExists(join(configDir, "wishlist.json")));

  const scanFiles = existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  const records = scanFiles.map((name) => readJson(join(dataDir, name)));
  const fares = convertScanRecords(records);

  const payload: ImportInput = {};
  if (config) payload.config = config;
  if (wishlist.entries.length > 0) payload.wishlist = wishlist.entries;
  if (fares.fares.length > 0) payload.fares = fares.fares;

  return {
    payload,
    summary: {
      configSections: config ? Object.keys(config) : [],
      wishlist: { entries: wishlist.entries.length, duplicates: wishlist.duplicates, skipped: wishlist.skipped },
      fares: { fares: fares.fares.length, skipped: fares.skipped, scanFiles: scanFiles.length }
    }
  };
}
