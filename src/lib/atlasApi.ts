// Client for /api/atlas (ADR 0020): what the Scout screen reads and steers. Owner-only: every call
// goes through jfetch, which sends the session cookie and turns a 401 into JournalLockedError.
// The shapes mirror server/lib/atlas (service.ts, schemas.ts); the server is the source of truth.

import { jfetch } from "./journalApi";
import type { Trip } from "../types";

export type OriginSource = "rotation-current" | "rotation-next" | "rotation-home" | "fallback";
export type RunMode = "scan" | "discover" | "research";

export interface AtlasOrigin {
  cityId: string;
  name: string;
  country: string;
  iata: string | null;
  source: OriginSource;
  stayId?: string;
}

export interface AtlasStay {
  id: string;
  cityId: string;
  name: string;
  country?: string;
  iata?: string;
  start?: string;
  end?: string;
  status: string;
}

export interface DateWindow {
  from: string;
  to: string;
}

export interface WindowDays {
  minDays: number;
  maxDays: number;
}

export interface AtlasConfig {
  profile: { persona: string; intentTags: string[]; luxuryExceptions?: string; avoid: string[] };
  hardFilters: {
    maxStops: number;
    maxTravelTimeHours: number;
    maxLayoverWaitHours: number;
    budgetEconomyEur: { min: number; max: number };
    fallbackOrigins: string[];
    lastminuteWindowDays: number;
  };
  windows: { a: WindowDays; b: WindowDays };
  tripPreferences: {
    activities: { budgetPerDayEur: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A change to the config: only the fields that differ, nested as in AtlasConfig. */
export type AtlasConfigPatch = {
  profile?: Partial<AtlasConfig["profile"]>;
  hardFilters?: { [K in keyof AtlasConfig["hardFilters"]]?: K extends "budgetEconomyEur" ? Partial<AtlasConfig["hardFilters"][K]> : AtlasConfig["hardFilters"][K] };
  windows?: { a?: Partial<WindowDays>; b?: Partial<WindowDays> };
  tripPreferences?: { activities?: { budgetPerDayEur?: number } };
};

export interface Signal {
  cityId: string;
  month: number;
  quiet?: number;
  conditions?: number;
  events: { title: string; date?: string }[];
  note?: string;
  sources: string[];
  researchedAt: string;
}

export interface MonthPoint {
  month: number;
  comfort: number | null;
  crowd: number | null;
  signal?: Signal;
}

export interface Watch {
  active: boolean;
  targetBudgetEur?: { min?: number; max?: number };
  chatId?: string;
}

export interface WishlistPlace {
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  lat: number;
  lng: number;
  source: "wished" | "scouted";
  intentTags: string[];
  avoidMonths: number[];
  notes?: string;
  watch?: Watch;
  discoveryScore?: number;
  priority: number;
  addedAt: string;
  lastScoutedAt?: string;
  updatedAt: string;
  season: {
    months: MonthPoint[];
    /** Comfort for January to December, or null when there is no climate data. */
    year: number[] | null;
    bestMonths: number[];
    avoidNow: boolean;
  };
}

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
  parts: Record<string, number | null>;
  reasons: string[];
}

export interface ResearchNeed {
  cityId: string;
  name: string;
  priority: number;
  months: number[];
}

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
  status?: "fired" | "failed";
  detail?: string;
  highlights?: ScanHighlight[];
  mode: string;
  at: string;
  origin: string | null;
  counts: Record<string, number>;
  top?: { flightId: string; destination: string; priceEur: number | null; composite: number } | null;
  passed?: string[];
}

export interface AtlasContext {
  today: string;
  origin: AtlasOrigin;
  fallbackOrigins: string[];
  rotation: { current: AtlasStay | null; next: AtlasStay | null; daysLeft: number | null; nextMoveDate: string | null };
  windows: { a: DateWindow; b: DateWindow };
  config: AtlasConfig;
  wishlist: WishlistPlace[];
  ideas: TripIdea[];
  researchNeeded: ResearchNeed[];
  recentlyScouted: { cityId: string; name: string; iata?: string; at: string }[];
  lastRuns: RunSummary[];
  routine: { configured: boolean };
}

export type PlaceRef = { cityId: string } | { iata: string } | { query: string };

export interface WishlistAddEntry {
  place: PlaceRef;
  source?: "wished" | "scouted";
  priority?: number;
  intentTags?: string[];
  notes?: string;
}

export interface WishlistAddResult {
  entries: Omit<WishlistPlace, "season">[];
  unresolved: { place: PlaceRef; reason: string }[];
}

/** What PATCH /wishlist/:cityId accepts. Null removes the watch or the notes. */
export interface WishlistPatch {
  priority?: number;
  notes?: string | null;
  watch?: { active: boolean; targetBudgetEur?: { min?: number; max?: number } } | null;
  avoidMonths?: number[];
  intentTags?: string[];
}

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** GET /api/atlas/context: origin, windows, wishlist with season, ideas, research needed. */
export function getAtlasContext(today?: string): Promise<AtlasContext> {
  return jfetch(`/api/atlas/context${today ? `?today=${enc(today)}` : ""}`);
}

export async function getAtlasRuns(limit = 10): Promise<RunSummary[]> {
  const res = await jfetch<{ runs: RunSummary[] }>(`/api/atlas/runs?limit=${limit}`);
  return res.runs ?? [];
}

export function getAtlasConfig(): Promise<{ config: AtlasConfig; updatedAt: string | null }> {
  return jfetch("/api/atlas/config");
}

/** PATCH /api/atlas/config: a deep merge, so send only what changed. A 400 carries `issues`. */
export function patchAtlasConfig(patch: AtlasConfigPatch): Promise<{ config: AtlasConfig; updatedAt: string | null }> {
  return jfetch("/api/atlas/config", { method: "PATCH", ...json(patch) });
}

/** POST /api/atlas/run: start the routine now. The answer is the stored run (fired or failed). */
export async function runAtlas(mode: RunMode, text?: string): Promise<RunSummary> {
  const res = await jfetch<{ run: RunSummary }>("/api/atlas/run", { method: "POST", ...json(text ? { mode, text } : { mode }) });
  return res.run;
}

export function addToWishlist(entries: WishlistAddEntry[]): Promise<WishlistAddResult> {
  return jfetch("/api/atlas/wishlist", { method: "POST", ...json({ entries }) });
}

export async function patchWishlistPlace(cityId: string, patch: WishlistPatch): Promise<Omit<WishlistPlace, "season">> {
  const res = await jfetch<{ entry: Omit<WishlistPlace, "season"> }>(`/api/atlas/wishlist/${enc(cityId)}`, { method: "PATCH", ...json(patch) });
  return res.entry;
}

export async function removeWishlistPlace(cityId: string): Promise<boolean> {
  const res = await jfetch<{ removed: boolean }>(`/api/atlas/wishlist/${enc(cityId)}`, { method: "DELETE" });
  return res.removed;
}

/** The trips Atlas planned: ordinary Meridian trips whose id starts with "atlas-". */
export const ATLAS_TRIP_PREFIX = "atlas-";

export function atlasTrips(trips: Trip[]): Trip[] {
  return trips.filter((t) => t.id.startsWith(ATLAS_TRIP_PREFIX));
}

export async function getAtlasTrips(): Promise<Trip[]> {
  const res = await jfetch<{ trips: Trip[] }>("/api/trips");
  return atlasTrips(res.trips ?? []);
}
