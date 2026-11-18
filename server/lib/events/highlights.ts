// Seasonal highlights of a place, found from iNaturalist observations (ADR 0021). Nothing
// here names a species: a species is a highlight of a place when most of its observations
// there fall in a short run of months, and it is worth showing when few other places share
// that. Pure functions, no network.

import { orderMonths } from "../../../src/lib/eventKinds.js";
import { MONTH_NAMES, type StoredEvent } from "./common.js";
import type { City } from "../../../src/types.js";

export type Kind = "plant" | "animal";

/** Observations within this distance of the city count as the place. */
export const RADIUS_KM = 30;
/** A species is seasonal when this share of its local observations falls in the window. */
export const SEASON_SHARE = 0.6;
/** The window is at most this many consecutive months (wrapping the year). */
export const MAX_WINDOW = 3;
/** Fewest local observations: flowering plants, and animals. */
export const MIN_COUNT: Record<Kind, number> = { plant: 20, animal: 30 };
/** Taxa with fewer observations on iNaturalist as a whole are too obscure to recognise. */
export const MIN_GLOBAL_OBSERVATIONS = 1000;
/** Candidates kept per city and kind. More than the three that are shown: species found to be everywhere are dropped later, and the next ones take their place; the ones the place's text mentions are kept first. */
export const KEEP_PER_KIND = 30;
/** Candidates per kind that get their names looked up in the place's text. */
export const POOL_PER_KIND = 80;
/** A species the place's own text mentions needs only this share of the usual minimum count. */
export const MENTIONED_MIN_FACTOR = 0.5;
/** Mentioned highlights rank this many times higher than their score says. */
export const MENTION_BOOST = 20;
/** An unmentioned highlight is shown only when this much of its observations fall in the window and few other cities share it. */
export const UNMENTIONED_MIN_SHARE = 0.75;
export const UNMENTIONED_MAX_CITY_SHARE = 0.05;
/** A species that is a highlight in more than this share of the checked cities is not special anywhere. */
export const COMMON_SHARE = 0.15;
/** The share rule applies once this many cities are checked. */
export const COMMON_AFTER_CITIES = 40;
export const MAX_EVENTS_PER_CITY = 3;
/** An animal this concentrated (off-window share at most 5%) is absent the rest of the year: a migration for birds. */
export const ABSENT_SHARE = 0.95;
/** An edge month of the window holding less than this share of the window is left out of the peak months. */
const EDGE_TRIM = 0.15;

export interface SpeciesRow {
  taxonId: number;
  name: string;
  common: string | null;
  /** iNaturalist iconic taxon name: Plantae, Aves, Mammalia, ... */
  iconic: string;
  /** Observations of this taxon on iNaturalist as a whole. */
  globalCount: number;
  rank: string;
  rankLevel: number;
  /** The two taxa above the species, nearest first (genus, and subgenus or family): their common names are what the genus is called. */
  parentIds?: number[];
  /** Observations within the radius (in the month asked for, when one was). */
  count: number;
}

export interface SpeciesPage {
  total: number;
  rows: SpeciesRow[];
}

/** One seasonal species at one place, as kept in the store: what cannot be derived from the monthly counts. */
export interface StoredHighlight {
  /** iNaturalist taxon id. */
  t: number;
  /** Common name, "" when iNaturalist has none. */
  c: string;
  /** Scientific name, kept only when there is no common name. */
  n?: string;
  /** Iconic taxon name: Plantae, Aves, Mammalia, ... */
  i: string;
  /** Local observations per month, January first. Months a page cut off are estimates (see monthlyTable). */
  m: number[];
  /** What the place's own text says: 1 mentions the species, 2 mentions its genus or kind. Absent: not mentioned, or no text was found. */
  w?: 1 | 2;
  /** Genus (scientific), kept when mentioned through the genus, to group species of one genus. */
  g?: string;
  /** The genus name as the text has it (singular), for a mention of 2. */
  gc?: string;
  /** The text speaks of "<gc> blossom". */
  b?: 1;
}

/** A stored highlight with its season worked out from the monthly counts. */
export interface Highlight extends StoredHighlight {
  k: Kind;
  /** Local observations in all. */
  total: number;
  /** Months of the peak window, in calendar order from the first. */
  months: number[];
  /** Share of the local observations inside the window, 0 to 1. */
  share: number;
  /** Set on a highlight that stands for several species of one genus (see rankHighlights). */
  agg?: { ids: number[]; species: number };
}

export const kindOf = (iconic: string): Kind => (iconic === "Plantae" ? "plant" : "animal");

export function compactHighlight(h: Highlight): StoredHighlight {
  return { t: h.t, c: h.c, ...(h.c ? {} : h.n ? { n: h.n } : {}), i: h.i, m: h.m, ...(h.w ? { w: h.w } : {}), ...(h.w === 2 && h.g ? { g: h.g } : {}), ...(h.w === 2 && h.gc ? { gc: h.gc } : {}), ...(h.b ? { b: 1 as const } : {}) };
}

/** The season of a stored highlight, or undefined when its counts show none (they always do for what was stored). */
export function expandHighlight(s: StoredHighlight): Highlight | undefined {
  if (!Array.isArray(s.m) || s.m.length !== 12) return undefined;
  const w = seasonWindow(s.m);
  if (!w) return undefined;
  return { ...s, k: kindOf(s.i), total: s.m.reduce((a, b) => a + b, 0), months: w.months, share: Number(w.share.toFixed(3)) };
}

/** The SpeciesPage of a species_counts answer, or undefined when the body is not one. */
export function parseSpeciesCounts(json: unknown): SpeciesPage | undefined {
  const j = json as { total_results?: unknown; results?: unknown } | null;
  if (!j || typeof j.total_results !== "number" || !Array.isArray(j.results)) return undefined;
  const rows: SpeciesRow[] = [];
  for (const r of j.results as { count?: unknown; taxon?: Record<string, unknown> }[]) {
    const t = r?.taxon;
    if (!t || typeof r.count !== "number" || typeof t.id !== "number" || typeof t.name !== "string") continue;
    rows.push({
      taxonId: t.id,
      name: t.name,
      common: typeof t.preferred_common_name === "string" && t.preferred_common_name.trim() ? t.preferred_common_name.trim() : null,
      iconic: typeof t.iconic_taxon_name === "string" ? t.iconic_taxon_name : "",
      globalCount: typeof t.observations_count === "number" ? t.observations_count : 0,
      rank: typeof t.rank === "string" ? t.rank : "",
      rankLevel: typeof t.rank_level === "number" ? t.rank_level : 10,
      ...(Array.isArray(t.ancestor_ids) ? { parentIds: (t.ancestor_ids as unknown[]).filter((x): x is number => typeof x === "number").slice(-3, -1).reverse() } : typeof t.parent_id === "number" ? { parentIds: [t.parent_id] } : {}),
      count: r.count,
    });
  }
  return { total: j.total_results, rows };
}

/**
 * The 3-month (or shorter) run holding the largest share of the counts, wrapping the year. Edge
 * months with less than 15% of the run are trimmed, so a window never carries a month that adds
 * nothing. Undefined when no run reaches the share or there are no counts.
 */
export function seasonWindow(counts: number[], minShare = SEASON_SHARE, maxLen = MAX_WINDOW): { months: number[]; share: number } | undefined {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length !== 12 || total <= 0) return undefined;
  let best: { start: number; sum: number } | undefined;
  for (let start = 0; start < 12; start++) {
    let sum = 0;
    for (let i = 0; i < maxLen; i++) sum += counts[(start + i) % 12]!;
    if (!best || sum > best.sum) best = { start, sum };
  }
  if (!best || best.sum / total < minShare) return undefined;
  let idx = Array.from({ length: maxLen }, (_, i) => (best!.start + i) % 12);
  const sumOf = (ix: number[]) => ix.reduce((a, i) => a + counts[i]!, 0);
  for (;;) {
    if (idx.length < 2) break;
    const sum = sumOf(idx);
    const trimmed = counts[idx[0]!]! < EDGE_TRIM * sum ? idx.slice(1) : counts[idx[idx.length - 1]!]! < EDGE_TRIM * sum ? idx.slice(0, -1) : undefined;
    // Trim only while the shorter run still reaches the share.
    if (!trimmed || sumOf(trimmed) / total < minShare) break;
    idx = trimmed;
  }
  const sum = idx.reduce((a, i) => a + counts[i]!, 0);
  return { months: orderMonths(idx.map((i) => i + 1)), share: sum / total };
}

/**
 * Candidates from twelve month-restricted species_counts pages (index 0 is January).
 *
 * A page lists the top species of that month and stops at `perPage`. A species a page does not
 * list had at most as many observations as the page's last row, so the table fills those months
 * with half of that cut-off; a page that is not full lists everything and its gaps are zeros.
 */
export function monthlyTable(pages: SpeciesPage[], perPage: number): Map<number, { row: SpeciesRow; m: number[] }> {
  const table = new Map<number, { row: SpeciesRow; m: (number | null)[] }>();
  const cut = pages.map((p) => (p.rows.length >= perPage ? Math.min(...p.rows.map((r) => r.count)) : 0));
  pages.forEach((p, mi) => {
    for (const r of p.rows) {
      let e = table.get(r.taxonId);
      if (!e) {
        e = { row: r, m: new Array<number | null>(12).fill(null) };
        table.set(r.taxonId, e);
      }
      e.m[mi] = r.count;
    }
  });
  const out = new Map<number, { row: SpeciesRow; m: number[] }>();
  for (const [id, e] of table) out.set(id, { row: e.row, m: e.m.map((v, mi) => v ?? Math.floor(cut[mi]! / 2)) });
  return out;
}

/** A candidate before its mention is known: the taxa above it are what iNaturalist's genus names are looked up by. */
export interface Candidate extends Highlight {
  parentIds?: number[];
}

/**
 * The seasonal species of one kind at one place that are worth reading the place's text for:
 * recognisable, a short season and at least half the usual minimum count (a species the text
 * mentions needs fewer). Best first by count times concentration, `POOL_PER_KIND` at most.
 */
export function seasonalPool(pages: SpeciesPage[], kind: Kind, perPage: number): Candidate[] {
  const out: Candidate[] = [];
  for (const { row, m } of monthlyTable(pages, perPage).values()) {
    if (row.rankLevel > 10 || row.globalCount < MIN_GLOBAL_OBSERVATIONS) continue;
    const total = m.reduce((a, b) => a + b, 0);
    if (total < MIN_COUNT[kind] * MENTIONED_MIN_FACTOR) continue;
    const w = seasonWindow(m);
    if (!w) continue;
    out.push({ t: row.taxonId, n: row.name, c: row.common ?? "", i: row.iconic, k: kind, m, total, months: w.months, share: Number(w.share.toFixed(3)), ...(row.parentIds?.length ? { parentIds: row.parentIds } : {}) });
  }
  return out.sort((a, b) => b.total * b.share - a.total * a.share || a.t - b.t).slice(0, POOL_PER_KIND);
}

/** What is stored for a kind: the mentioned species first (ten at most), then the others that reach the usual minimum, `KEEP_PER_KIND` in all. */
export function selectStored(pool: Candidate[], kind: Kind): Candidate[] {
  const byScore = (a: Candidate, b: Candidate) => b.total * b.share - a.total * a.share || a.t - b.t;
  const mentioned = pool.filter((h) => h.w).sort(byScore).slice(0, 10);
  const rest = pool.filter((h) => !h.w && h.total >= MIN_COUNT[kind]).sort(byScore).slice(0, KEEP_PER_KIND - mentioned.length);
  return [...mentioned, ...rest];
}

/** The seasonal species of one kind at one place with no text to read: the pool at the usual minimum, `KEEP_PER_KIND` at most. */
export function seasonalCandidates(pages: SpeciesPage[], kind: Kind, perPage: number): Highlight[] {
  return selectStored(seasonalPool(pages, kind, perPage), kind);
}

// Uniqueness across the checked cities

export interface Tally {
  /** Cities checked. */
  cities: number;
  /** Cities where each taxon is a stored highlight. */
  byTaxon: Map<number, number>;
}

export function tallyHighlights(perCity: Iterable<{ t: number }[]>): Tally {
  const byTaxon = new Map<number, number>();
  let cities = 0;
  for (const list of perCity) {
    cities++;
    for (const h of list) byTaxon.set(h.t, (byTaxon.get(h.t) ?? 0) + 1);
  }
  return { cities, byTaxon };
}

/** True when a species is a highlight in more than 15% of the checked cities, once 40 are checked. */
export function isCommon(h: Highlight, tally: Tally): boolean {
  return tally.cities >= COMMON_AFTER_CITIES && (tally.byTaxon.get(h.t) ?? 0) / tally.cities > COMMON_SHARE;
}

/** Local count x concentration x an inverse-frequency factor, ln(1 + cities checked / cities where it is a highlight). */
export function highlightScore(h: Highlight, tally: Tally): number {
  const n = Math.max(1, tally.byTaxon.get(h.t) ?? 1);
  return h.total * h.share * Math.log(1 + Math.max(1, tally.cities) / n);
}

/** A word that ends this many different iNaturalist genus names is an everyday word, not the name of a genus. */
export const GENERIC_NAME_TAXA = 6;

/**
 * Words too ordinary to name a genus: the last word of a genus common name is generic when it ends
 * that many of iNaturalist's genus names ("flower", "tree", "plant"), counted over the names cached so far.
 */
export function genericGenusNames(genusCommonNames: Iterable<string>, genusAlternatives: (c: string) => string[]): Set<string> {
  const df = new Map<string, Set<string>>();
  for (const c of genusCommonNames) {
    for (const a of genusAlternatives(c)) {
      const head = a.split(" ").pop()!;
      df.set(head, (df.get(head) ?? new Set()).add(a));
    }
  }
  return new Set([...df].filter(([, names]) => names.size >= GENERIC_NAME_TAXA).map(([w]) => w));
}

/** The shortest single-word name believed to be a genus or species name in a text. */
export const MIN_NAME_LETTERS = 5;

/**
 * Whether a mention is worth believing. A mention through the genus fails when the name is a
 * generic word or a short single word ("map", "flag", "tree"). A mention of the species by a
 * one-word common name fails when that name is short (an ordinary word such as "stars").
 */
export function credibleMention(h: Highlight, genericNames: ReadonlySet<string>): boolean {
  if (h.w === 2) {
    if (!h.gc) return false;
    const words = h.gc.split(" ");
    return !genericNames.has(words[words.length - 1]!) && (words.length > 1 || h.gc.length >= MIN_NAME_LETTERS);
  }
  if (h.w === 1 && h.c && !h.c.includes(" ") && h.c.length < MIN_NAME_LETTERS + 1) return false;
  return true;
}

const unmention = (h: Highlight): Highlight => {
  const { w: _w, g: _g, gc: _gc, b: _b, ...rest } = h;
  return rest;
};

/**
 * Species of one genus that the place's text mentions through the genus, with overlapping
 * seasons, become one highlight with their counts added (several cherry species are one cherry
 * season). The strongest species stands for the group.
 */
export function aggregateByGenus(list: Highlight[]): Highlight[] {
  const out: Highlight[] = [];
  const groups = new Map<string, Highlight[]>();
  for (const h of list) {
    if (h.w === 2 && h.g) groups.set(`${h.k}|${h.g}`, [...(groups.get(`${h.k}|${h.g}`) ?? []), h]);
    else out.push(h);
  }
  for (const members of groups.values()) {
    const rest = [...members].sort((a, b) => b.total * b.share - a.total * a.share || a.t - b.t);
    while (rest.length) {
      const rep = rest.shift()!;
      const cluster = [rep, ...rest.filter((x) => x.months.some((mo) => rep.months.includes(mo)))];
      for (const x of cluster.slice(1)) rest.splice(rest.indexOf(x), 1);
      const m = rep.m.map((_, i) => cluster.reduce((a, x) => a + x.m[i]!, 0));
      const w = cluster.length > 1 ? seasonWindow(m) : undefined;
      if (!w) {
        out.push(...cluster.length > 1 ? [rep, ...cluster.slice(1)] : [rep]);
        continue;
      }
      out.push({ ...rep, m, total: m.reduce((a, b) => a + b, 0), months: w.months, share: Number(w.share.toFixed(3)), agg: { ids: cluster.map((x) => x.t), species: cluster.length }, ...(cluster.some((x) => x.b) ? { b: 1 as const } : {}) });
    }
  }
  return out;
}

/**
 * A city's highlights worth showing, at most three. Species the city's own text mentions come
 * first (ahead of every unmentioned one, and among themselves by score times 20); the rest fill the remaining places only when strongly
 * seasonal and shared by few cities, unless no text was found for the city. Species found to be
 * everywhere are dropped. Plants and animals are scored against their own kind: iNaturalist holds
 * many times more animal observations, so raw scores left no plant in the list. Each score is
 * divided by the best of its kind in the city.
 */
export function rankHighlights(list: Highlight[], tally: Tally, textFound = true, genericNames: ReadonlySet<string> = new Set()): Highlight[] {
  const live = aggregateByGenus(list.filter((h) => !isCommon(h, tally)).map((h) => (credibleMention(h, genericNames) ? h : unmention(h))));
  const eligible = live.filter((h) => {
    if (h.w || !textFound) return true;
    const cityShare = tally.cities >= COMMON_AFTER_CITIES ? (tally.byTaxon.get(h.t) ?? 0) / tally.cities : 0;
    return h.share >= UNMENTIONED_MIN_SHARE && cityShare <= UNMENTIONED_MAX_CITY_SHARE;
  });
  const scored = eligible.map((h) => ({ h, s: highlightScore(h, tally) }));
  const best: Record<Kind, number> = { plant: 0, animal: 0 };
  for (const x of scored) best[x.h.k] = Math.max(best[x.h.k], x.s);
  return scored
    .map((x) => ({ ...x, f: (best[x.h.k] > 0 ? x.s / best[x.h.k] : 0) * (x.h.w ? MENTION_BOOST : 1) }))
    .sort((a, b) => Number(!!b.h.w) - Number(!!a.h.w) || b.f - a.f || b.s - a.s || a.h.t - b.h.t)
    .slice(0, MAX_EVENTS_PER_CITY)
    .map((x) => x.h);
}

// Events

const GROUP_TAGS: Record<string, string> = {
  Plantae: "bloom",
  Aves: "birds",
  Mammalia: "mammals",
  Insecta: "insects",
  Reptilia: "reptiles",
  Amphibia: "amphibians",
  Actinopterygii: "fish",
  Mollusca: "marine-life",
};

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const kebab = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const displayName = (h: Highlight) => cap(h.c || h.n || `Taxon ${h.t}`);

/** "X in bloom" for plants, "X migration" for a bird absent outside its window, else "X season". */
export function highlightTitle(h: Highlight): string {
  // Several species of one genus: titled with the genus name the place's text uses ("Cherry blossom" where the text says so).
  const name = h.agg && h.gc ? cap(h.gc) : displayName(h);
  if (h.k === "plant") return h.agg && h.b ? `${name} blossom` : `${name} in bloom`;
  if (h.i === "Aves" && h.share >= ABSENT_SHARE) return `${name} migration`;
  return `${name} season`;
}

export function highlightTags(h: Highlight): string[] {
  const tags = [GROUP_TAGS[h.i] ?? (h.k === "plant" ? "bloom" : "wildlife")];
  if (h.k === "animal") tags.push("wildlife");
  const name = kebab(h.agg && h.gc ? h.gc : h.c || h.n || "");
  if (name && !tags.includes(name)) tags.push(name);
  return tags;
}

const short = (m: number) => cap(MONTH_NAMES[m - 1]!).slice(0, 3);

/** The iNaturalist observations search that matches a highlight: the species, the radius, the peak months. */
export function observationsSearchUrl(h: Highlight, lat: number, lng: number): string {
  const q = new URLSearchParams({ taxon_id: (h.agg?.ids ?? [h.t]).join(","), lat: lat.toFixed(4), lng: lng.toFixed(4), radius: String(RADIUS_KM), month: h.months.join(",") });
  // Plants count cultivated and unverified observations too (see inaturalist.ts); animals only verifiable ones.
  if (h.k === "plant") q.set("quality_grade", "any");
  else q.set("verifiable", "true");
  return `https://www.inaturalist.org/observations?${q}`;
}

export function highlightEvent(h: Highlight, city: City): StoredEvent {
  const first = h.months[0]!;
  const last = h.months[h.months.length - 1]!;
  const when = h.months.length > 1 ? `${short(first)} to ${short(last)}` : short(first);
  return {
    id: `inat-${h.t}-${city.id}`,
    title: highlightTitle(h),
    kind: "nature",
    cityIds: [city.id],
    month: first,
    ...(h.months.length > 1 ? { months: h.months } : {}),
    recurring: true,
    tags: highlightTags(h),
    note: `${Math.round(h.share * 100)}% of ${h.total} iNaturalist observations${h.agg ? ` of ${h.agg.species} species of one genus` : ""} within ${RADIUS_KM} km fall in ${when}.`,
    source: "inaturalist",
    sourceUrl: observationsSearchUrl(h, city.lat, city.lng),
    feed: "inaturalist",
  };
}
