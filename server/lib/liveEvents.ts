// Live events from Wikidata (ADR 0021). Replaces the hand-kept data/events.json.
//
// Five sources, each one SPARQL query, two at a time:
//   festivals        recurring festivals and culture (month of the year, P2922)
//   sports           recurring sporting events (marathons, races, tournaments)
//   dated-festivals  festivals with a start date or point in time in the next 18 months
//   dated-sports     sporting events with a date in the next 18 months
//   eclipses         solar eclipses (total, annular, hybrid) in the next 30 months
//
// Each coordinate is placed on the nearest Meridian city within 40 km; events with no
// city are dropped and counted. The result is cached in the document store
// (events-live.json) with one status line per source. A source that fails keeps its
// previous events, so a transient error never empties the list.
//
// getLiveEvents() is what consumers call. It never throws and never blocks on a stale
// copy; it blocks (once, single-flight) only when there is nothing stored yet.

import type { City, MeridianEvent } from "../../src/types.js";
import { haversineKm } from "../../src/lib/geo.js";
import { getCities } from "./cities.js";
import { createJsonStore } from "./jsonStore.js";

export const WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql";
export const USER_AGENT = "Meridian/2.0 (personal travel planner; https://github.com/kygura/meridian)";
export const SOURCE_LABEL = "Wikidata (CC0)";

/** Nearest-city radius for a coordinate, and for an eclipse's greatest-eclipse point (the belt is wide). */
const MATCH_RADIUS_KM = 40;
const ECLIPSE_RADIUS_KM = 150;
/** Two cities this close are one place for matching; the bigger one wins. */
const SAME_PLACE_KM = 5;
/** Wikidata's own limit is 60 s; the dated sporting query takes about 22 s. */
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_CAP_MS = 60_000;
const MAX_RETRIES = 2;
const PAUSE_BETWEEN_QUERIES_MS = 1000;
const FILE_CACHE_MS = 60_000;
/** After an attempt (successful or not) no new refresh is started for this long. */
const RETRY_AFTER_ATTEMPT_MS = 60 * 60 * 1000;
const MAX_DATED_PER_SOURCE = 150;
const MAX_TAGS_PER_EVENT = 6;

// Types

export type Fetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>;
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export interface SourceStatus {
  id: string;
  ok: boolean;
  /** Events this source contributes after placing and de-duplication. */
  count: number;
  /** Rows dropped because no Meridian city lies within the radius. */
  unmatched?: number;
  /** Events kept with no city (eclipses outside every radius and country list). */
  unplaced?: number;
  error?: string;
  /** Last time this source returned data. */
  fetchedAt?: string;
}

/** An event as stored: the public shape plus the source that produced it. */
export type StoredEvent = MeridianEvent & { feed: string };

export interface LiveEventsFile {
  version: 1;
  /** Last refresh in which at least one source returned data. */
  fetchedAt?: string;
  /** Last refresh attempt, successful or not. */
  attemptedAt?: string;
  sources: SourceStatus[];
  events: StoredEvent[];
}

const emptyFile = (): LiveEventsFile => ({ version: 1, sources: [], events: [] });
const store = createJsonStore<LiveEventsFile>("events-live.json", emptyFile);

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

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// Queries

const COORD = `
  OPTIONAL { ?e wdt:P625 ?c0 } OPTIONAL { ?e wdt:P276/wdt:P625 ?c1 } OPTIONAL { ?e wdt:P131/wdt:P625 ?c2 }
  BIND(COALESCE(?c0,?c1,?c2) AS ?c) FILTER(BOUND(?c))`;
const TYPES = `OPTIONAL { ?e wdt:P31 ?type . ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel)="en") }`;
const LABEL = `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }`;

export function festivalsQuery(): string {
  return `SELECT ?e ?eLabel ?month ?sl (SAMPLE(?c) AS ?coord) (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) WHERE {
  ?e wdt:P31/wdt:P279* wd:Q132241 ; wdt:P2922 ?month ; wikibase:sitelinks ?sl .
  FILTER(?sl >= 8)${COORD}
  ${TYPES}
  ${LABEL}
} GROUP BY ?e ?eLabel ?month ?sl ORDER BY DESC(?sl) LIMIT 400`;
}

export function sportsQuery(): string {
  return `SELECT ?e ?eLabel ?month ?sl (SAMPLE(?c) AS ?coord) (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) WHERE {
  VALUES ?class { wd:Q16510064 wd:Q40244 }
  ?e wdt:P31/wdt:P279* ?class ; wdt:P2922 ?month ; wikibase:sitelinks ?sl .
  FILTER(?sl >= 12)${COORD}
  ${TYPES}
  ${LABEL}
} GROUP BY ?e ?eLabel ?month ?sl ORDER BY DESC(?sl) LIMIT 250`;
}

const addMonths = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function datedQuery(classQid: "Q132241" | "Q16510064", now: Date): string {
  return `SELECT ?e ?eLabel ?date ?sl (SAMPLE(?c) AS ?coord) (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) WHERE {
  ?e wdt:P31/wdt:P279* wd:${classQid} ; wikibase:sitelinks ?sl .
  FILTER(?sl >= 5)
  { ?e wdt:P580 ?date } UNION { ?e wdt:P585 ?date }
  FILTER(?date >= "${isoDay(now)}T00:00:00Z"^^xsd:dateTime && ?date < "${isoDay(addMonths(now, 18))}T00:00:00Z"^^xsd:dateTime)${COORD}
  ${TYPES}
  ${LABEL}
} GROUP BY ?e ?eLabel ?date ?sl ORDER BY DESC(?sl) LIMIT 300`;
}

export function eclipsesQuery(now: Date): string {
  return `SELECT ?e ?eLabel ?date (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) (GROUP_CONCAT(DISTINCT ?countryLabel; separator="|") AS ?countries) (GROUP_CONCAT(DISTINCT STR(?coord); separator="|") AS ?coords) WHERE {
  ?e wdt:P31/wdt:P279* wd:Q3887 ; wdt:P585 ?date .
  FILTER(?date >= "${isoDay(now)}T00:00:00Z"^^xsd:dateTime && ?date < "${isoDay(addMonths(now, 30))}T00:00:00Z"^^xsd:dateTime)
  OPTIONAL { ?e wdt:P31 ?type . ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel)="en") }
  OPTIONAL { ?e wdt:P17 ?cn . ?cn rdfs:label ?countryLabel FILTER(LANG(?countryLabel)="en") }
  OPTIONAL { ?e wdt:P625 ?coord }
  ${LABEL}
} GROUP BY ?e ?eLabel ?date ORDER BY ?date`;
}

// Parsing

/** Wikidata month items: January Q108, February Q109, March Q110, April to December Q118 to Q126. */
const MONTH_QIDS: Record<string, number> = {
  Q108: 1, Q109: 2, Q110: 3, Q118: 4, Q119: 5, Q120: 6, Q121: 7, Q122: 8, Q123: 9, Q124: 10, Q125: 11, Q126: 12,
};
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

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

export interface RawEvent {
  qid: string;
  title: string;
  month: number;
  date?: string;
  recurring: boolean;
  points: LatLng[];
  countries: string[];
  types: string[];
  sitelinks: number;
}

const qidOf = (uri: string | undefined): string | undefined => /Q\d+$/.exec(uri ?? "")?.[0];
const split = (s: string | undefined): string[] => (s ? s.split("|").map((x) => x.trim()).filter(Boolean) : []);

function baseRaw(b: SparqlBinding): { qid: string; title: string } | undefined {
  const qid = qidOf(b.e?.value);
  const title = b.eLabel?.value?.trim();
  // The label service answers with the bare Q-id when an item has no English label.
  if (!qid || !title || /^Q\d+$/.test(title)) return undefined;
  return { qid, title };
}

/** Recurring rows: one per (item, month), month from P2922. Rows whose month is not a month item are ignored. */
export function parseRecurring(bindings: SparqlBinding[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const b of bindings) {
    const base = baseRaw(b);
    const month = monthOf(b.month?.value);
    const point = parsePoint(b.coord?.value);
    if (!base || !month || !point) continue;
    out.push({ ...base, month, recurring: true, points: [point], countries: [], types: split(b.types?.value), sitelinks: Number(b.sl?.value) || 0 });
  }
  return out;
}

/**
 * Dated rows. An item can carry several dates (a year-precision 1 January next to the real
 * start); the query cannot tell precision, so a date on 1 January is read as a year and
 * skipped. An item with nothing else is dropped. The earliest remaining date wins.
 */
export function parseDated(bindings: SparqlBinding[]): RawEvent[] {
  const byItem = new Map<string, { raw: RawEvent; dates: string[] }>();
  for (const b of bindings) {
    const base = baseRaw(b);
    const date = /^\d{4}-\d{2}-\d{2}/.exec(b.date?.value ?? "")?.[0];
    const point = parsePoint(b.coord?.value);
    if (!base || !date || !point || date.endsWith("-01-01")) continue;
    const cur = byItem.get(base.qid);
    if (cur) {
      cur.dates.push(date);
      continue;
    }
    const raw: RawEvent = { ...base, month: 0, recurring: false, points: [point], countries: [], types: split(b.types?.value), sitelinks: Number(b.sl?.value) || 0 };
    byItem.set(base.qid, { raw, dates: [date] });
  }
  return [...byItem.values()].map(({ raw, dates }) => {
    const date = [...dates].sort()[0] ?? "";
    return { ...raw, date, month: Number(date.slice(5, 7)) };
  });
}

/** Eclipse rows: the greatest-eclipse points (P625) and the countries (P17) Wikidata lists. */
export function parseEclipses(bindings: SparqlBinding[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const b of bindings) {
    const base = baseRaw(b);
    const date = /^\d{4}-\d{2}-\d{2}/.exec(b.date?.value ?? "")?.[0];
    if (!base || !date) continue;
    const types = split(b.types?.value);
    // A partial eclipse is not a reason to travel.
    if (types.some((t) => /partial/i.test(t)) || /partial/i.test(base.title)) continue;
    out.push({
      ...base,
      month: Number(date.slice(5, 7)),
      date,
      recurring: false,
      points: split(b.coords?.value).map(parsePoint).filter((p): p is LatLng => p !== undefined),
      countries: split(b.countries?.value),
      types,
      sitelinks: 0,
    });
  }
  return out;
}

// Classification

const CULTURE_TYPE = /film|cinema|music|concert|jazz|opera|arts?\b|literar|book|poetry|theat|dance|comedy|photograph|culture/i;
const GENERIC_TAGS = new Set(["event", "organization", "occurrence", "sporting-event", "sports-season", "sports-competition", "competition", "future-event", "award", "article", "nonprofit-organization", "non-profit-organization"]);

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

/**
 * Festival items are "culture" when a type names film, music, arts, literature, theatre
 * or dance, and "festival" otherwise (carnival, folk, religious, harvest, food). Sporting
 * items are "sport"; eclipse items are "eclipse".
 */
export function classify(feed: "festival" | "sport" | "eclipse", types: string[]): { kind: MeridianEvent["kind"]; tags: string[] } {
  const kind: MeridianEvent["kind"] = feed === "sport" ? "sport" : feed === "eclipse" ? "eclipse" : types.some((t) => CULTURE_TYPE.test(t)) ? "culture" : "festival";
  const tags: string[] = feed === "festival" ? ["festival"] : [];
  if (!tags.includes(kind)) tags.push(kind);
  if (feed === "eclipse") tags.push("solar-eclipse");
  for (const t of types) {
    const tag = tagOf(t);
    if (tag && !GENERIC_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return { kind, tags: tags.slice(0, MAX_TAGS_PER_EVENT) };
}

// City matching

export interface CityIndex {
  /** Nearest city within `radiusKm`; the bigger of two cities within 5 km of each other. */
  nearest(p: LatLng, radiusKm: number, airportOnly?: boolean): City | undefined;
  /** The capital if it has an airport, else the largest airport city, else the capital, else the largest city. */
  hubOfCountry(name: string): City | undefined;
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

// Sources

type Feed = "festival" | "sport" | "eclipse";

export interface SourceDef {
  id: string;
  feed: Feed;
  /** Runs the query and returns parsed rows. */
  fetch(ctx: SparqlContext, now: Date): Promise<RawEvent[]>;
}

export interface Built {
  events: StoredEvent[];
  /** Rows dropped because no city lies within the radius. */
  unmatched: number;
  /** Eclipses kept with no city. */
  unplaced: number;
}

const wikidataUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;

/**
 * Places raw events on cities and builds the public shape. An item with several months
 * becomes one event per month, ids suffixed "-m<month>". Rows with no city are dropped;
 * an eclipse with no city is kept (it then shows in lists, not on the map).
 */
export function buildEvents(sourceId: string, feed: Feed, raws: RawEvent[], index: CityIndex): Built {
  const monthCount = new Map<string, number>();
  for (const r of raws) monthCount.set(r.qid, (monthCount.get(r.qid) ?? 0) + 1);
  const events: StoredEvent[] = [];
  let unmatched = 0;
  let unplaced = 0;
  for (const r of raws) {
    const cityIds = new Set<string>();
    for (const p of r.points) {
      const c = index.nearest(p, feed === "eclipse" ? ECLIPSE_RADIUS_KM : MATCH_RADIUS_KM, feed === "eclipse");
      if (c) cityIds.add(c.id);
    }
    // Wikidata lists few countries for an eclipse and no path: each listed country's hub city stands for it.
    for (const name of r.countries) {
      const c = index.hubOfCountry(name);
      if (c) cityIds.add(c.id);
    }
    if (cityIds.size === 0) {
      if (feed !== "eclipse") {
        unmatched++;
        continue;
      }
      unplaced++;
    }
    const { kind, tags } = classify(feed, r.types);
    const several = !r.recurring ? false : (monthCount.get(r.qid) ?? 0) > 1;
    events.push({
      id: `wd-${r.qid}${several ? `-m${r.month}` : ""}`,
      title: r.title.charAt(0).toUpperCase() + r.title.slice(1),
      kind,
      cityIds: [...cityIds],
      month: r.month,
      ...(r.date ? { date: r.date } : {}),
      recurring: r.recurring,
      tags,
      source: "wikidata",
      sourceUrl: wikidataUrl(r.qid),
      feed: sourceId,
    });
  }
  if (events.length > MAX_DATED_PER_SOURCE && events.every((e) => !e.recurring)) events.length = MAX_DATED_PER_SOURCE;
  return { events, unmatched, unplaced };
}

/** Order matters: when two sources carry the same item, the earlier one wins. */
export const SOURCES: SourceDef[] = [
  { id: "eclipses", feed: "eclipse", fetch: async (ctx, now) => parseEclipses(await runSparql(eclipsesQuery(now), ctx)) },
  { id: "dated-sports", feed: "sport", fetch: async (ctx, now) => parseDated(await runSparql(datedQuery("Q16510064", now), ctx)) },
  { id: "dated-festivals", feed: "festival", fetch: async (ctx, now) => parseDated(await runSparql(datedQuery("Q132241", now), ctx)) },
  { id: "festivals", feed: "festival", fetch: async (ctx) => parseRecurring(await runSparql(festivalsQuery(), ctx)) },
  { id: "sports", feed: "sport", fetch: async (ctx) => parseRecurring(await runSparql(sportsQuery(), ctx)) },
];

// Refresh

export interface RefreshOptions {
  fetch?: Fetch;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between queries in one lane. */
  pauseMs?: number;
  /** Test seam: replaces the loaded city list. */
  cities?: City[];
  /**
   * Time this run may take, in ms. Sources not started by then wait for the next run; each
   * finished source is already saved. Default 45 s on Vercel (functions stop at 60 s), none elsewhere.
   */
  budgetMs?: number;
  /** Sources queried at once. Wikidata allows a few parallel queries per client; default 2. */
  concurrency?: number;
}

/** True when real network use is off: LIVE_EVENTS=off, or a test run that injected no fetch. */
function networkOff(fetchGiven: boolean): boolean {
  return process.env.LIVE_EVENTS === "off" || (process.env.VITEST !== undefined && !fetchGiven);
}

async function readFileSafe(): Promise<LiveEventsFile> {
  try {
    const f = await store.read();
    return f && Array.isArray(f.events) && Array.isArray(f.sources) ? f : emptyFile();
  } catch (err) {
    console.warn("[events] could not read events-live.json:", err instanceof Error ? err.message : String(err));
    return emptyFile();
  }
}

export function dedupeAndSort(events: StoredEvent[]): StoredEvent[] {
  const seen = new Set<string>();
  const out: StoredEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => a.month - b.month || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

const sourceRank = (id: string) => {
  const i = SOURCES.findIndex((s) => s.id === id);
  return i === -1 ? SOURCES.length : i;
};

/**
 * Puts one source's outcome into the file: its events replace that source's earlier ones,
 * and when two sources carry the same item the one earlier in SOURCES wins.
 */
export function applySource(file: LiveEventsFile, status: SourceStatus, events: StoredEvent[]): void {
  const known = new Set(SOURCES.map((x) => x.id));
  // Events from a feed no source produces any more (renamed or retired) are dropped here.
  const merged = [...file.events.filter((e) => e.feed !== status.id && known.has(e.feed)), ...events].sort((a, b) => sourceRank(a.feed) - sourceRank(b.feed));
  file.events = dedupeAndSort(merged);
  file.sources = [...file.sources.filter((x) => x.id !== status.id), status].sort((a, b) => sourceRank(a.id) - sourceRank(b.id));
  for (const x of file.sources) x.count = file.events.filter((e) => e.feed === x.id).length;
  if (status.ok && status.fetchedAt && (!file.fetchedAt || status.fetchedAt > file.fetchedAt)) file.fetchedAt = status.fetchedAt;
}

/** Sources never fetched first, then the oldest, so a run cut short still moves the oldest forward. */
function sourceOrder(prev: LiveEventsFile): SourceDef[] {
  const at = (id: string) => prev.sources.find((x) => x.id === id && x.ok)?.fetchedAt ?? "";
  return [...SOURCES].sort((a, b) => at(a.id).localeCompare(at(b.id)) || sourceRank(a.id) - sourceRank(b.id));
}

/**
 * Runs the sources, two at a time by default, and saves each one as it finishes, so a run
 * that is stopped (a serverless time limit) keeps what it got. A source that fails, or
 * returns nothing where it had events before, keeps its previous events and fetchedAt and
 * records the error. Sources left when the budget runs out are not started. Throws only
 * when the store cannot be written.
 */
export async function refreshLiveEvents(opts: RefreshOptions = {}): Promise<LiveEventsFile> {
  if (networkOff(opts.fetch !== undefined)) throw new Error("live events fetching is disabled (LIVE_EVENTS=off or a test run)");
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? (process.env.VERCEL ? 45_000 : undefined);
  const deadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const ctx: SparqlContext = {
    fetch: opts.fetch ?? ((url, init) => fetch(url, init) as Promise<FetchResponse>),
    sleep: opts.sleep ?? realSleep,
    ...(deadline !== undefined ? { deadline } : {}),
  };
  const pauseMs = opts.pauseMs ?? PAUSE_BETWEEN_QUERIES_MS;
  const cities = opts.cities ?? getCities();
  const nowIso = now.toISOString();

  let prev: LiveEventsFile;
  try {
    prev = await store.update((f) => {
      if (!Array.isArray(f.events) || !Array.isArray(f.sources)) Object.assign(f, emptyFile());
      f.attemptedAt = nowIso;
      return structuredClone(f);
    });
  } catch (err) {
    // A corrupt store is replaced rather than left to block every refresh.
    console.warn("[events] events-live.json is unreadable; starting it again:", err instanceof Error ? err.message : String(err));
    prev = { ...emptyFile(), attemptedAt: nowIso };
    await store.write(prev);
  }
  memo = undefined;

  const queue = sourceOrder(prev);
  const runOne = async (src: SourceDef): Promise<void> => {
    const before = prev.sources.find((x) => x.id === src.id);
    const beforeEvents = prev.events.filter((e) => e.feed === src.id);
    let status: SourceStatus;
    let events: StoredEvent[];
    try {
      if (cities.length === 0) throw new Error("cities are not loaded");
      const raws = await src.fetch(ctx, now);
      if (raws.length === 0 && beforeEvents.length > 0) throw new Error("query returned no rows; kept the previous events");
      const built = buildEvents(src.id, src.feed, raws, cityIndexFor(cities));
      events = built.events;
      status = { id: src.id, ok: true, count: events.length, unmatched: built.unmatched, ...(built.unplaced ? { unplaced: built.unplaced } : {}), fetchedAt: nowIso };
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.warn(`[events] ${src.id} failed: ${error}`);
      events = beforeEvents;
      status = { id: src.id, ok: false, count: beforeEvents.length, error, ...(before?.fetchedAt ? { fetchedAt: before.fetchedAt } : {}) };
    }
    await store.update((f) => applySource(f, status, events));
    memo = undefined;
  };

  const lanes = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, queue.length)) }, async (_, lane) => {
    let first = true;
    for (let src = queue.shift(); src; src = queue.shift()) {
      if (deadline !== undefined && Date.now() > deadline - 5000) {
        queue.length = 0;
        break;
      }
      if (!first && pauseMs > 0) await ctx.sleep(pauseMs);
      first = false;
      await runOne(src);
    }
    void lane;
  });
  await Promise.all(lanes);

  const file = await readFileSafe();
  memo = undefined;
  return file;
}

// Reading

let memo: { key: string; at: number; file: LiveEventsFile } | undefined;
let inflight: Promise<LiveEventsFile> | undefined;

/** Test seam: forget the in-memory copy and any refresh in flight. */
export function resetLiveEventsForTests(): void {
  memo = undefined;
  inflight = undefined;
}

async function readCached(): Promise<LiveEventsFile> {
  const key = store.path();
  if (memo && memo.key === key && Date.now() - memo.at < FILE_CACHE_MS) return memo.file;
  const file = await readFileSafe();
  memo = { key, at: Date.now(), file };
  return file;
}

function startRefresh(opts: RefreshOptions): Promise<LiveEventsFile> {
  inflight ??= refreshLiveEvents(opts).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

function validEvent(e: unknown): e is StoredEvent {
  if (e === null || typeof e !== "object") return false;
  const x = e as Partial<StoredEvent>;
  return (
    typeof x.id === "string" &&
    typeof x.title === "string" &&
    Number.isInteger(x.month) && (x.month ?? 0) >= 1 && (x.month ?? 0) <= 12 &&
    Array.isArray(x.cityIds) && x.cityIds.every((c) => typeof c === "string") &&
    Array.isArray(x.tags) && x.tags.every((t) => typeof t === "string") &&
    (x.date === undefined || typeof x.date === "string")
  );
}

function isStale(file: LiveEventsFile, now: Date, maxAgeDays: number): boolean {
  const last = file.fetchedAt ? Date.parse(file.fetchedAt) : NaN;
  const old = !Number.isFinite(last) || now.getTime() - last > maxAgeDays * 86_400_000;
  if (!old) return false;
  const attempt = file.attemptedAt ? Date.parse(file.attemptedAt) : NaN;
  return !(Number.isFinite(attempt) && now.getTime() - attempt < RETRY_AFTER_ATTEMPT_MS);
}

export interface LiveEventsStatus {
  fetchedAt: string | null;
  attemptedAt: string | null;
  total: number;
  sources: SourceStatus[];
}

/** Sources, counts and errors of the stored copy. Reads only; never starts a refresh. */
export async function liveEventsStatus(): Promise<LiveEventsStatus> {
  const f = await readCached();
  return { fetchedAt: f.fetchedAt ?? null, attemptedAt: f.attemptedAt ?? null, total: f.events.length, sources: f.sources };
}

/**
 * The live events. Serves the stored copy; when it is older than `maxAgeDays` a refresh
 * starts (one refresh at a time, shared by concurrent callers) and the stale copy is served
 * meanwhile. An empty store waits up to `waitMs` (8 s) and then serves what has been saved so far. Never throws: on failure it
 * returns what it has, or [].
 */
export async function getLiveEvents(opts: { maxAgeDays?: number; waitMs?: number } & RefreshOptions = {}): Promise<MeridianEvent[]> {
  try {
    const now = opts.now ?? new Date();
    let file = await readCached();
    if (isStale(file, now, opts.maxAgeDays ?? 7) && !networkOff(opts.fetch !== undefined)) {
      const run = startRefresh(opts);
      if (file.events.length === 0) {
        // Wait a little for the first sources; the rest keep filling the store after this answer.
        const waitMs = opts.waitMs ?? 8000;
        const timer = new Promise<"late">((r) => setTimeout(() => r("late"), waitMs).unref?.());
        try {
          const out = await Promise.race([run, timer]);
          if (out === "late") {
            run.catch((err) => console.error("[events] refresh failed:", err instanceof Error ? err.message : String(err)));
            memo = undefined;
            file = await readCached();
          } else file = out;
        } catch (err) {
          console.error("[events] refresh failed:", err instanceof Error ? err.message : String(err));
        }
      } else {
        run.catch((err) => console.error("[events] background refresh failed:", err instanceof Error ? err.message : String(err)));
      }
    }
    return file.events.filter(validEvent).map(({ feed: _feed, ...e }) => e);
  } catch (err) {
    console.error("[events] could not load events:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
