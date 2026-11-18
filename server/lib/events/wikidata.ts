// The Wikidata sources (ADR 0021): local festivities, country-wide festivities and eclipses.
// Each is one or two SPARQL queries; coordinates and countries are placed on Meridian cities.

import { orderMonths } from "../../../src/lib/eventKinds.js";
import { parseWhen, type When } from "./calendars.js";
import {
  monthOf,
  parsePoint,
  qidOf,
  runSparql,
  split,
  tagOf,
  type CityIndex,
  type LatLng,
  type SourceDef,
  type SourceResult,
  type SparqlBinding,
  type StoredEvent,
  DAY_MS,
} from "./common.js";

/** Nearest-city radius for a coordinate, and for an eclipse's greatest-eclipse point (the belt is wide). */
const MATCH_RADIUS_KM = 40;
const ECLIPSE_RADIUS_KM = 150;
const MAX_TAGS_PER_EVENT = 6;
const wikidataUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;

const addMonths = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Classes of festival the owner does not mean by local festivities (film, music, arts, pride, ...), by Wikidata QID. */
export const EXCLUDED_FESTIVAL_CLASSES = [
  "Q220505", // film festival
  "Q868557", // music festival
  "Q1751626", // theatre festival
  "Q4801521", // arts festival
  "Q23902005", // literary festival
  "Q2393315", // dance festival
  "Q5151487", // comedy festival
  "Q27186004", // poetry festival
  "Q3070310", // photography festival
  "Q129598636", // pride festival
  "Q55735290", // queer culture festival
  "Q137682498", // LGBTQ+ festival
  "Q124312353", // sculpture festival
  "Q7433676", // science festival
  "Q3070233", // storytelling festival
  "Q21030243", // puppet festival
  "Q18232178", // arts and crafts festival
  "Q3070220", // comic book convention
  "Q1367629", // ancient Roman festival
  "Q114834437", // conference
  "Q548126", // anime convention
  "Q3070242", // gaming convention
  "Q16510064", // sporting event
  "Q40244", // marathon
];

/**
 * A backstop for items Wikidata files as a plain "festival" while the name says film, music,
 * theatre, pride, books or a race. Applied to the title and the type labels.
 */
export const NOT_A_LOCAL_FESTIVITY =
  /\b(films?|cinema|music|musical|jazz|opera|theat(?:re|er)|pride|lgbtq?\+?|queer|gay|lesbian|literature|literary|books?|comics?|poetry|marathon|awards?|outfest|animation|documentary)\b/i;

// Festivities

export function festivitiesQuery(): string {
  const classes = EXCLUDED_FESTIVAL_CLASSES.filter((q) => q !== "Q16510064" && q !== "Q40244").map((q) => `wd:${q}`).join(" ");
  return `SELECT ?e ?eLabel ?month ?sl (SAMPLE(?c) AS ?coord) (SAMPLE(?gone) AS ?ended) (GROUP_CONCAT(DISTINCT ?tl; separator="|") AS ?types) WHERE {
  ?e wdt:P31 ?t ; wdt:P2922 ?month ; wikibase:sitelinks ?sl . ?t wdt:P279* wd:Q132241 .
  FILTER(?sl >= 5)
  FILTER NOT EXISTS { VALUES ?x { ${classes} } ?t wdt:P279* ?x }
  ?t rdfs:label ?tl FILTER(LANG(?tl)="en")
  OPTIONAL { ?e wdt:P576 ?gone }
  OPTIONAL { ?e wdt:P625 ?c0 } OPTIONAL { ?e wdt:P276/wdt:P625 ?c1 } OPTIONAL { ?e wdt:P131/wdt:P625 ?c2 }
  BIND(COALESCE(?c0,?c1,?c2) AS ?c) FILTER(BOUND(?c))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?e ?eLabel ?month ?sl ORDER BY DESC(?sl) LIMIT 300`;
}

/**
 * Items the first query lets through because one of their several types is a plain festival
 * while another is film, music, sport or an ancient festival. Run on the candidates only.
 */
export function festivityExclusionQuery(qids: string[]): string {
  const classes = EXCLUDED_FESTIVAL_CLASSES.map((q) => `wd:${q}`).join(" ");
  return `SELECT DISTINCT ?e WHERE {
  VALUES ?e { ${qids.map((q) => `wd:${q}`).join(" ")} }
  VALUES ?x { ${classes} }
  ?e wdt:P31/wdt:P279* ?x .
}`;
}

export interface RawFestivity {
  qid: string;
  title: string;
  /** Months (1-12) in calendar order, from one or several rows. */
  months: number[];
  point?: LatLng;
  countries: string[];
  types: string[];
  sitelinks: number;
  /** Dates when the recurrence resolves to specific days (lunisolar festivals). */
  dates?: string[];
  approximate?: boolean;
}

function baseOf(b: SparqlBinding): { qid: string; title: string } | undefined {
  const qid = qidOf(b.e?.value);
  const title = b.eLabel?.value?.trim();
  // The label service answers with the bare Q-id when an item has no English label.
  if (!qid || !title || /^Q\d+$/.test(title)) return undefined;
  return { qid, title };
}

/** Rows of festivitiesQuery: one row per (item, month), merged to one entry per item. Ended items and rows without a month item are skipped. */
export function parseFestivities(bindings: SparqlBinding[]): RawFestivity[] {
  const byQid = new Map<string, RawFestivity>();
  for (const b of bindings) {
    const base = baseOf(b);
    const month = monthOf(b.month?.value);
    const point = parsePoint(b.coord?.value);
    if (!base || !month || !point || b.ended?.value) continue;
    const cur = byQid.get(base.qid);
    if (cur) {
      if (!cur.months.includes(month)) cur.months.push(month);
      continue;
    }
    byQid.set(base.qid, { ...base, months: [month], point, countries: [], types: split(b.types?.value), sitelinks: Number(b.sl?.value) || 0 });
  }
  return [...byQid.values()].map((r) => ({ ...r, months: orderMonths(r.months) }));
}

const GENERIC_TAGS = new Set(["event", "organization", "occurrence", "competition", "future-event", "article", "nonprofit-organization", "non-profit-organization", "recurring-event", "annual-event", "tradition", "holiday"]);

function tagsFor(base: string[], types: string[]): string[] {
  const tags = [...base];
  for (const t of types) {
    const tag = tagOf(t);
    if (tag && !GENERIC_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, MAX_TAGS_PER_EVENT);
}

export interface Built {
  events: StoredEvent[];
  /** Rows dropped because no city matches. */
  unmatched: number;
  /** Events kept with no city. */
  unplaced: number;
}

/** Local festivities: each item on the nearest city within 40 km. A festival with no city is dropped and counted. */
export function buildFestivities(sourceId: string, raws: RawFestivity[], index: CityIndex): Built {
  const events: StoredEvent[] = [];
  let unmatched = 0;
  for (const r of raws) {
    const city = r.point ? index.nearest(r.point, MATCH_RADIUS_KM) : undefined;
    if (!city) {
      unmatched++;
      continue;
    }
    events.push({
      id: `wd-${r.qid}`,
      title: cap(r.title),
      kind: "festival",
      cityIds: [city.id],
      month: r.months[0]!,
      ...(r.months.length > 1 ? { months: r.months } : {}),
      recurring: true,
      tags: tagsFor(["festival"], r.types),
      source: "wikidata",
      sourceUrl: wikidataUrl(r.qid),
      feed: sourceId,
    });
  }
  return { events, unmatched, unplaced: 0 };
}

/** Candidates the exclusion query names are dropped; so are items whose title or types name film, music, pride, books or a race. */
export function applyFestivityExclusions(raws: RawFestivity[], excluded: Set<string>): RawFestivity[] {
  return raws.filter((r) => !excluded.has(r.qid) && !NOT_A_LOCAL_FESTIVITY.test(r.title) && !r.types.some((t) => NOT_A_LOCAL_FESTIVITY.test(t)));
}

export function excludedQids(bindings: SparqlBinding[]): Set<string> {
  return new Set(bindings.map((b) => qidOf(b.e?.value)).filter((q): q is string => !!q));
}

export const festivitiesSource: SourceDef = {
  id: "festivities",
  intervalMs: 7 * DAY_MS,
  async run(ctx) {
    const raws = parseFestivities(await runSparql(festivitiesQuery(), ctx));
    if (raws.length === 0) return { events: [] };
    const excluded = excludedQids(await runSparql(festivityExclusionQuery(raws.map((r) => r.qid)), ctx));
    const kept = applyFestivityExclusions(raws, excluded);
    const built = buildFestivities("festivities", kept, ctx.index);
    return { events: built.events, unmatched: built.unmatched, detail: { candidates: raws.length, excluded: raws.length - kept.length } };
  },
};

// National festivities

/** More countries than this and a festival is not tied to a place. The owner said "about 8"; Diwali lists 11 and is wanted, Nowruz lists 23 and is not. */
export const NATIONAL_MAX_COUNTRIES = 12;
export const NATIONAL_AIRPORT_CITIES = 3;

export function nationalFestivitiesQuery(): string {
  return `SELECT ?e ?eLabel ?sl ?when ?whenLabel (COUNT(DISTINCT ?country) AS ?nc) (GROUP_CONCAT(DISTINCT ?cl; separator="|") AS ?countries) (GROUP_CONCAT(DISTINCT ?tl; separator="|") AS ?types) WHERE {
  { ?e wdt:P837 ?when } UNION { ?e wdt:P2922 ?when }
  ?e wikibase:sitelinks ?sl FILTER(?sl >= 20)
  FILTER NOT EXISTS { ?e wdt:P625 ?pt }
  FILTER NOT EXISTS { ?e wdt:P276 ?venue }
  ?e wdt:P17 ?country . ?country rdfs:label ?cl FILTER(LANG(?cl)="en")
  FILTER NOT EXISTS { ?country wdt:P576 ?countryEnd }
  ?e wdt:P31 ?t . ?t rdfs:label ?tl FILTER(LANG(?tl)="en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?e ?eLabel ?sl ?when ?whenLabel ORDER BY DESC(?sl) LIMIT 800`;
}

/** Types that mark a festival or holiday a traveller plans around. */
const NATIONAL_ALLOW = /festival|carnival|matsuri|harvest|religious holiday|new year|fiesta|feast|^holiday$|annual event|celebration/i;
/** Types and titles that mark an observance, a race, a company or a film event. */
const NATIONAL_DENY = /film|music|jazz|race|sport|prize|award|compan|organi[sz]ation|cycling|marathon|tournament|competition|league|lottery|theat|federal|public holidays? in|national day|independence|awareness|world day|anniversary|book fair|sculpture|city|town|tourist|astronomical|parade|military|regatta/i;
/** A bare "holiday" or "annual event" type needs this many sitelinks (a festival type needs 20). */
const NATIONAL_GENERIC_SITELINKS = 30;
const OBSERVANCE_TITLE = /\b(day|eve)\b(?! of the dead)/i;

export interface RawNational {
  qid: string;
  title: string;
  countries: string[];
  types: string[];
  sitelinks: number;
  /** How many countries Wikidata lists (more than 12 means not location-specific). */
  countryCount: number;
  whens: string[];
}

export function parseNational(bindings: SparqlBinding[]): RawNational[] {
  const byQid = new Map<string, RawNational>();
  for (const b of bindings) {
    const base = baseOf(b);
    if (!base) continue;
    const when = b.whenLabel?.value?.trim() ?? "";
    const cur = byQid.get(base.qid);
    if (cur) {
      if (when && !cur.whens.includes(when)) cur.whens.push(when);
      continue;
    }
    byQid.set(base.qid, {
      ...base,
      countries: split(b.countries?.value),
      types: split(b.types?.value),
      sitelinks: Number(b.sl?.value) || 0,
      countryCount: Number(b.nc?.value) || 0,
      whens: when ? [when] : [],
    });
  }
  return [...byQid.values()];
}

/** The festival-like, country-specific items: 1 to 12 countries, a festival or holiday type, no observance-day names. */
export function isNationalFestivity(r: RawNational): boolean {
  if (r.countryCount < 1 || r.countryCount > NATIONAL_MAX_COUNTRIES) return false;
  if (NATIONAL_DENY.test(r.title) || r.types.some((t) => NATIONAL_DENY.test(t))) return false;
  const festivalType = r.types.some((t) => /festival|carnival|matsuri|harvest|religious holiday|new year|fiesta|feast/i.test(t));
  const genericType = r.types.some((t) => NATIONAL_ALLOW.test(t));
  if (festivalType) return true;
  return genericType && r.sitelinks >= NATIONAL_GENERIC_SITELINKS && !OBSERVANCE_TITLE.test(r.title);
}

export interface BuiltNational extends Built {
  /** Items kept as festivities whose recurrence could not be read as a month or a date. */
  undated: number;
}

/**
 * Country-wide festivities: each placed on the country's capital and its biggest airport
 * cities. A recurrence in the Gregorian or Hindu calendar becomes a recurring event with
 * months; one in the Chinese calendar becomes dated events inside [now, now + 18 months].
 */
export function buildNational(sourceId: string, raws: RawNational[], index: CityIndex, now: Date): BuiltNational {
  const events: StoredEvent[] = [];
  let unmatched = 0;
  let undated = 0;
  const horizon = addMonths(now, 18);
  for (const r of raws) {
    const cityIds = new Set<string>();
    for (const name of r.countries) for (const c of index.citiesOfCountry(name, NATIONAL_AIRPORT_CITIES)) cityIds.add(c.id);
    if (cityIds.size === 0) {
      unmatched++;
      continue;
    }
    const months = new Set<number>();
    const dates = new Set<string>();
    let approximate = false;
    for (const w of r.whens) {
      const parsed: When | undefined = parseWhen(w, now, horizon);
      if (!parsed) continue;
      if (parsed.kind === "months") {
        for (const m of parsed.months) months.add(m);
        approximate ||= !!parsed.approximate;
      } else for (const d of parsed.dates) dates.add(d);
    }
    if (months.size === 0 && dates.size === 0) {
      undated++;
      continue;
    }
    const tags = tagsFor(["festival", "country-wide"], r.types);
    const common = { title: cap(r.title), kind: "festival" as const, cityIds: [...cityIds], tags, source: "wikidata", sourceUrl: wikidataUrl(r.qid), feed: sourceId };
    if (months.size > 0) {
      const ordered = orderMonths(months);
      events.push({
        ...common,
        id: `wd-${r.qid}`,
        month: ordered[0]!,
        ...(ordered.length > 1 ? { months: ordered } : {}),
        recurring: true,
        ...(approximate ? { note: "Month is approximate: the festival follows a lunar calendar." } : {}),
      });
    } else {
      // Lunisolar dates, only when no fixed month is known (a festival with both keeps the month form).
      for (const date of [...dates].sort()) {
        if (date < isoDay(now)) continue;
        events.push({ ...common, id: `wd-${r.qid}-${date}`, month: Number(date.slice(5, 7)), date, recurring: false, note: "Date follows the Chinese calendar." });
      }
    }
  }
  return { events, unmatched, unplaced: 0, undated };
}

export const nationalFestivitiesSource: SourceDef = {
  id: "national-festivities",
  intervalMs: 7 * DAY_MS,
  async run(ctx) {
    const raws = parseNational(await runSparql(nationalFestivitiesQuery(), ctx));
    if (raws.length === 0) return { events: [] };
    const kept = raws.filter(isNationalFestivity);
    const built = buildNational("national-festivities", kept, ctx.index, ctx.now);
    return { events: built.events, unmatched: built.unmatched, detail: { candidates: raws.length, kept: kept.length, undated: built.undated } };
  },
};

// Eclipses

export function eclipsesQuery(now: Date): string {
  return `SELECT ?e ?eLabel ?date (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types) (GROUP_CONCAT(DISTINCT ?countryLabel; separator="|") AS ?countries) (GROUP_CONCAT(DISTINCT STR(?coord); separator="|") AS ?coords) WHERE {
  ?e wdt:P31/wdt:P279* wd:Q3887 ; wdt:P585 ?date .
  FILTER(?date >= "${isoDay(now)}T00:00:00Z"^^xsd:dateTime && ?date < "${isoDay(addMonths(now, 30))}T00:00:00Z"^^xsd:dateTime)
  OPTIONAL { ?e wdt:P31 ?type . ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel)="en") }
  OPTIONAL { ?e wdt:P17 ?cn . ?cn rdfs:label ?countryLabel FILTER(LANG(?countryLabel)="en") }
  OPTIONAL { ?e wdt:P625 ?coord }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?e ?eLabel ?date ORDER BY ?date`;
}

/** Total lunar eclipses (Q19693318) in the next 36 months. Wikidata files most lunar eclipses under the plain class, so few qualify. */
export function lunarEclipsesQuery(now: Date): string {
  return `SELECT ?e ?eLabel ?date (GROUP_CONCAT(DISTINCT ?countryLabel; separator="|") AS ?countries) WHERE {
  ?e wdt:P31/wdt:P279* wd:Q19693318 ; wdt:P585 ?date .
  FILTER(?date >= "${isoDay(now)}T00:00:00Z"^^xsd:dateTime && ?date < "${isoDay(addMonths(now, 36))}T00:00:00Z"^^xsd:dateTime)
  OPTIONAL { ?e wdt:P17 ?cn . ?cn rdfs:label ?countryLabel FILTER(LANG(?countryLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?e ?eLabel ?date ORDER BY ?date`;
}

export interface RawEclipse {
  qid: string;
  title: string;
  date: string;
  month: number;
  points: LatLng[];
  countries: string[];
  types: string[];
}

/** Eclipse rows: the greatest-eclipse points (P625) and the countries (P17) Wikidata lists. Partial eclipses are skipped. */
export function parseEclipses(bindings: SparqlBinding[]): RawEclipse[] {
  const out: RawEclipse[] = [];
  for (const b of bindings) {
    const base = baseOf(b);
    const date = /^\d{4}-\d{2}-\d{2}/.exec(b.date?.value ?? "")?.[0];
    if (!base || !date) continue;
    const types = split(b.types?.value);
    // A partial eclipse is not a reason to travel.
    if (types.some((t) => /partial|penumbral/i.test(t)) || /partial|penumbral/i.test(base.title)) continue;
    out.push({
      ...base,
      month: Number(date.slice(5, 7)),
      date,
      points: split(b.coords?.value).map(parsePoint).filter((p): p is LatLng => p !== undefined),
      countries: split(b.countries?.value),
      types,
    });
  }
  return out;
}

/**
 * Solar eclipses go on the airport cities within 150 km of the point of greatest eclipse
 * (the belt is wide) and on the hub city of each country Wikidata lists. Total lunar eclipses
 * are kind "sky" and go on the hub cities of the countries Wikidata lists, if any. An eclipse
 * with no city is kept (it shows in lists, not on the map) and counted.
 */
export function buildEclipses(sourceId: string, raws: RawEclipse[], index: CityIndex, lunar: boolean): Built {
  const events: StoredEvent[] = [];
  let unplaced = 0;
  for (const r of raws) {
    const cityIds = new Set<string>();
    for (const p of r.points) {
      const c = index.nearest(p, ECLIPSE_RADIUS_KM, true);
      if (c) cityIds.add(c.id);
    }
    for (const name of r.countries) {
      const c = index.hubOfCountry(name);
      if (c) cityIds.add(c.id);
    }
    if (cityIds.size === 0) unplaced++;
    const tags = lunar ? ["eclipse", "lunar-eclipse", "total-lunar-eclipse"] : tagsFor(["eclipse", "solar-eclipse"], r.types);
    events.push({
      id: `wd-${r.qid}`,
      title: cap(r.title),
      kind: lunar ? "sky" : "eclipse",
      cityIds: [...cityIds],
      month: r.month,
      date: r.date,
      recurring: false,
      tags,
      source: "wikidata",
      sourceUrl: wikidataUrl(r.qid),
      feed: sourceId,
    });
  }
  return { events, unmatched: 0, unplaced };
}

export const eclipsesSource: SourceDef = {
  id: "eclipses",
  intervalMs: 7 * DAY_MS,
  async run(ctx): Promise<SourceResult> {
    const solar = parseEclipses(await runSparql(eclipsesQuery(ctx.now), ctx));
    // The lunar query is a second chance, not a reason to lose the solar eclipses.
    let lunarRaws: RawEclipse[] = [];
    let lunarError: string | undefined;
    try {
      lunarRaws = parseEclipses(await runSparql(lunarEclipsesQuery(ctx.now), ctx));
    } catch (err) {
      lunarError = (err instanceof Error ? err.message : String(err)).slice(0, 120);
    }
    const a = buildEclipses("eclipses", solar, ctx.index, false);
    const b = buildEclipses("eclipses", lunarRaws, ctx.index, true);
    return {
      events: [...a.events, ...b.events],
      unplaced: a.unplaced + b.unplaced,
      detail: { solar: a.events.length, lunar: b.events.length, ...(lunarError ? { lunarError } : {}) },
    };
  },
};

