// Shared pieces of the live event sources (ADR 0021): the fetch seam, the SPARQL client,
// Wikidata parsing helpers and the city index that places coordinates and countries on
// Meridian cities. No source-specific logic lives here.

import type { City, MeridianEvent } from "../../../src/types.js";
import { haversineKm } from "../../../src/lib/geo.js";

export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
export const USER_AGENT = "Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)";

/** Two cities this close are one place for matching; the bigger one wins. */
const SAME_PLACE_KM = 5;
/** A country-wide event is placed on cities at least this far apart. */
const NEIGHBOUR_KM = 30;
/** Wikidata's own query limit is 60 s. */
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_CAP_MS = 60_000;
const MAX_RETRIES = 2;

export type Fetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>;
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** An event as stored: the public shape plus the source that produced it. */
export type StoredEvent = MeridianEvent & { feed: string };

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// SPARQL client
export interface SparqlBinding {
  [variable: string]: { type?: string; value: string } | undefined;
}

export interface SparqlContext {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms after which no request or retry starts, and running ones are cut off. */
  deadline?: number;
}

function retryDelayMs(header: string | null, attempt: number): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(RETRY_CAP_MS, secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(RETRY_CAP_MS, Math.max(0, at - Date.now()));
  }
  return Math.min(RETRY_CAP_MS, 5000 * (attempt + 1));
}

/** One query. On 429 or 503 waits Retry-After (at most 60 s) and retries up to twice. */
export async function runSparql(query: string, ctx: SparqlContext): Promise<SparqlBinding[]> {
  const url = `${WIKIDATA_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const left = () => (ctx.deadline === undefined ? Infinity : ctx.deadline - Date.now());
  for (let attempt = 0; ; attempt++) {
    if (left() <= 1000) throw new Error("out of time for this run; the next run continues");
    const res = await ctx.fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left())),
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt >= MAX_RETRIES) throw new Error(`Wikidata answered ${res.status} after ${MAX_RETRIES} retries`);
      const wait = retryDelayMs(res.headers.get("retry-after"), attempt);
      if (wait >= left()) throw new Error(`Wikidata answered ${res.status}; its retry wait outlasts this run`);
      await ctx.sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
    return bindingsOf(await res.json());
  }
}

export function bindingsOf(json: unknown): SparqlBinding[] {
  const b = (json as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(b)) throw new Error("unexpected SPARQL response");
  return b as SparqlBinding[];
}

// Parsing helpers

/** Wikidata month items: January Q108, February Q109, March Q110, April to December Q118 to Q126. */
const MONTH_QIDS: Record<string, number> = {
  Q108: 1, Q109: 2, Q110: 3, Q118: 4, Q119: 5, Q120: 6, Q121: 7, Q122: 8, Q123: 9, Q124: 10, Q125: 11, Q126: 12,
};
export const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A month item URI (.../entity/Q119) or an English month name, as 1-12; anything else is undefined. */
export function monthOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const qid = /Q\d+$/.exec(value)?.[0];
  if (qid) return MONTH_QIDS[qid];
  const i = MONTH_NAMES.indexOf(value.trim().toLowerCase());
  return i >= 0 ? i + 1 : undefined;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** WKT "Point(lng lat)" as a coordinate. */
export function parsePoint(wkt: string | undefined): LatLng | undefined {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(wkt?.trim() ?? "");
  if (m === null) return undefined;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

export const qidOf = (uri: string | undefined): string | undefined => /Q\d+$/.exec(uri ?? "")?.[0];
export const split = (s: string | undefined): string[] => (s ? s.split("|").map((x) => x.trim()).filter(Boolean) : []);

/** Lower-case kebab of a Wikidata type label, with "annual", "recurring" and "edition of the" removed. */
export function tagOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/^edition of( the)?\s+/, "")
    .replace(/^(annual|recurring|international|biennial|yearly)\s+/, "")
    .replace(/\s+edition$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// City matching

export interface CityIndex {
  /** Nearest city within `radiusKm`; the bigger of two cities within 5 km of each other. */
  nearest(p: LatLng, radiusKm: number, airportOnly?: boolean): City | undefined;
  /** The capital if it has an airport, else the largest airport city, else the capital, else the largest city. */
  hubOfCountry(name: string): City | undefined;
  /**
   * The cities a country-wide event is placed on: the capital, then the biggest airport
   * cities, `airports` of them at most (default 3), each city once. Empty for an unknown country.
   */
  citiesOfCountry(name: string, airports?: number): City[];
  /** True when some city in the dataset belongs to this country name (after aliases). */
  knowsCountry(name: string): boolean;
}

const COUNTRY_ALIASES: Record<string, string> = {
  "united states of america": "united states",
  "czech republic": "czechia",
  "south korea": "korea south",
  "north korea": "korea north",
  "democratic republic of the congo": "congo kinshasa",
  "republic of the congo": "congo brazzaville",
  "ivory coast": "cote d ivoire",
  myanmar: "burma",
  "north macedonia": "macedonia",
  eswatini: "swaziland",
  bahamas: "bahamas the",
  "the bahamas": "bahamas the",
  gambia: "gambia the",
  "the gambia": "gambia the",
  "east timor": "timor leste",
  "cabo verde": "cape verde",
  turkiye: "turkey",
  "people s republic of china": "china",
};

export function countryKey(name: string): string {
  const k = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return COUNTRY_ALIASES[k] ?? k;
}

export function buildCityIndex(cities: City[]): CityIndex {
  // One-degree grid: a lookup scans the cells its radius touches, not all 5,900 cities.
  const cells = new Map<string, City[]>();
  const cellKey = (la: number, ln: number) => `${la},${((ln % 360) + 360) % 360}`;
  for (const c of cities) {
    const k = cellKey(Math.floor(c.lat), Math.floor(c.lng + 180));
    const list = cells.get(k);
    if (list) list.push(c);
    else cells.set(k, [c]);
  }

  const within = (p: LatLng, radiusKm: number, airportOnly: boolean): { c: City; d: number }[] => {
    const dLat = Math.ceil(radiusKm / 111);
    const dLng = Math.min(180, Math.ceil(radiusKm / (111 * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.02))));
    const la0 = Math.floor(p.lat);
    const ln0 = Math.floor(p.lng + 180);
    const out: { c: City; d: number }[] = [];
    for (let la = la0 - dLat; la <= la0 + dLat; la++) {
      if (la < -90 || la > 90) continue;
      for (let ln = ln0 - dLng; ln <= ln0 + dLng; ln++) {
        for (const c of cells.get(cellKey(la, ln)) ?? []) {
          if (airportOnly && !c.iata) continue;
          const d = haversineKm([p.lng, p.lat], [c.lng, c.lat]);
          if (d <= radiusKm) out.push({ c, d });
        }
      }
    }
    return out;
  };

  const byCountry = new Map<string, City[]>();
  for (const c of cities) {
    const k = countryKey(c.country);
    const list = byCountry.get(k);
    if (list) list.push(c);
    else byCountry.set(k, [c]);
  }
  const bySize = (a: City, b: City) => b.population - a.population;
  const hubs = new Map<string, City>();
  for (const [k, list] of byCountry) {
    const capital = list.find((c) => c.capital);
    const airports = list.filter((c) => c.iata).sort(bySize);
    const hub = capital?.iata ? capital : (airports[0] ?? capital ?? [...list].sort(bySize)[0]);
    if (hub) hubs.set(k, hub);
  }

  return {
    nearest(p, radiusKm, airportOnly = false) {
      const found = within(p, radiusKm, airportOnly).sort((a, b) => a.d - b.d);
      const first = found[0];
      if (!first) return undefined;
      let best = first.c;
      for (const { c } of found) {
        if (c.population > best.population && haversineKm([first.c.lng, first.c.lat], [c.lng, c.lat]) <= SAME_PLACE_KM) best = c;
      }
      return best;
    },
    hubOfCountry: (name) => hubs.get(countryKey(name)),
    citiesOfCountry(name, airports = 3) {
      const list = byCountry.get(countryKey(name));
      if (!list) return [];
      const out: City[] = [];
      const capital = list.find((c) => c.capital);
      if (capital) out.push(capital);
      for (const c of list.filter((x) => x.iata).sort(bySize)) {
        if (out.length >= airports + (capital ? 1 : 0)) break;
        // A neighbouring city of one already chosen (New Delhi and Delhi) is the same place for a traveller.
        if (!out.some((o) => o === c || haversineKm([o.lng, o.lat], [c.lng, c.lat]) < NEIGHBOUR_KM)) out.push(c);
      }
      if (out.length === 0) out.push([...list].sort(bySize)[0]!);
      return out;
    },
    knowsCountry: (name) => byCountry.has(countryKey(name)),
  };
}

const indexCache = new WeakMap<City[], CityIndex>();
export function cityIndexFor(cities: City[]): CityIndex {
  let idx = indexCache.get(cities);
  if (!idx) {
    idx = buildCityIndex(cities);
    indexCache.set(cities, idx);
  }
  return idx;
}

// Plain HTTP for the non-SPARQL sources

export interface HttpContext {
  fetch: Fetch;
  /** Epoch ms after which no request starts and running ones are cut off. */
  deadline?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter: string | null = null
  ) {
    super(message);
  }
}

/** GET with the Meridian User-Agent, a timeout that respects the run deadline and a typed error for non-2xx. */
export async function httpGet(url: string, ctx: HttpContext, label: string, accept = "application/json", timeoutMs = 30_000): Promise<FetchResponse> {
  const left = ctx.deadline === undefined ? Infinity : ctx.deadline - Date.now();
  if (left <= 1000) throw new Error(`${label}: out of time for this run; the next run continues`);
  const res = await ctx.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(Math.min(timeoutMs, left)) });
  if (!res.ok) throw new HttpError(res.status, `${label} answered ${res.status}`, res.headers.get("retry-after"));
  return res;
}

// Source contract

export interface SourceStatus {
  id: string;
  ok: boolean;
  /** Events this source contributes after placing and de-duplication. */
  count: number;
  /** Rows dropped because no Meridian city matches. */
  unmatched?: number;
  /** Events kept with no city (eclipses outside every radius and country list). */
  unplaced?: number;
  /** Source-specific numbers: stations matched, checks run, cities covered. */
  detail?: Record<string, number | string>;
  error?: string;
  /** Last time this source returned data. */
  fetchedAt?: string;
}

export interface LiveEventsFile {
  version: 1;
  /** Last refresh in which at least one source returned data. */
  fetchedAt?: string;
  /** Last refresh attempt, successful or not. */
  attemptedAt?: string;
  sources: SourceStatus[];
  events: StoredEvent[];
  /** Per-source working state that is not events (the iNaturalist highlights found per city). */
  state?: Record<string, unknown>;
}

export interface SourceResult {
  events: StoredEvent[];
  unmatched?: number;
  unplaced?: number;
  detail?: Record<string, number | string>;
  /** Replaces this source's entry in `LiveEventsFile.state`. */
  state?: unknown;
}

/** Where a source finds the owner's places and the cities people look at. Replaced in tests. */
export interface PlaceDeps {
  /** City ids the owner cares about: wishlist, shortlist, rotation, trip stops. */
  ownerCityIds(): Promise<string[]>;
  /** Every city with measured attention (page views), the most looked at first. */
  attentionCityIds(): string[];
}

export interface SourceContext {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms after which no request starts and running ones are cut off. */
  deadline?: number;
  /** Epoch ms after which a rolling source starts no more work (earlier than `deadline`, which leaves room to save). */
  softDeadline?: number;
  now: Date;
  cities: City[];
  index: CityIndex;
  /** The stored file when this refresh began. */
  prev: LiveEventsFile;
  places: PlaceDeps;
  /** City checks one rolling source may run in this refresh (the iNaturalist source). */
  maxChecks: number;
  /** Pause between requests to one polite host, ms. */
  hostPauseMs: number;
  /** Saves a partial result now, so a run that is cut off keeps it. */
  checkpoint(result: SourceResult): Promise<void>;
}

export interface SourceDef {
  id: string;
  /** A source is due when it never landed or its last fetch is older than this. */
  intervalMs: number;
  /** True when the source may legitimately return no events. */
  mayBeEmpty?: boolean;
  run(ctx: SourceContext): Promise<SourceResult>;
}

export const DAY_MS = 86_400_000;
