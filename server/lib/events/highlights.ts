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
/** Candidates kept per city and kind. More than the three that are shown: species found to be everywhere are dropped later, and the next ones take their place. */
export const KEEP_PER_KIND = 15;
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
}

export const kindOf = (iconic: string): Kind => (iconic === "Plantae" ? "plant" : "animal");

export function compactHighlight(h: Highlight): StoredHighlight {
  return { t: h.t, c: h.c, ...(h.c ? {} : h.n ? { n: h.n } : {}), i: h.i, m: h.m };
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

/** The seasonal species of one kind at one place: recognisable, enough observations, and a short season. Best first, `KEEP_PER_KIND` at most. */
export function seasonalCandidates(pages: SpeciesPage[], kind: Kind, perPage: number): Highlight[] {
  const out: Highlight[] = [];
  for (const { row, m } of monthlyTable(pages, perPage).values()) {
    if (row.rankLevel > 10 || row.globalCount < MIN_GLOBAL_OBSERVATIONS) continue;
    const total = m.reduce((a, b) => a + b, 0);
    if (total < MIN_COUNT[kind]) continue;
    const w = seasonWindow(m);
    if (!w) continue;
    out.push({ t: row.taxonId, n: row.name, c: row.common ?? "", i: row.iconic, k: kind, m, total, months: w.months, share: Number(w.share.toFixed(3)) });
  }
  return out.sort((a, b) => b.total * b.share - a.total * a.share || a.t - b.t).slice(0, KEEP_PER_KIND);
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

/**
 * A city's highlights worth showing: common species dropped, the rest ranked, at most three.
 * Plants and animals are ranked against their own kind: iNaturalist holds many times more animal
 * observations than flowering-plant ones, so raw scores would leave no plant in the list. Each
 * highlight is scored relative to the best of its kind in the city (1 for the best), so the best
 * plant and the best animal come first and the remaining place goes to the next strongest.
 */
export function rankHighlights(list: Highlight[], tally: Tally): Highlight[] {
  const scored = list.filter((h) => !isCommon(h, tally)).map((h) => ({ h, s: highlightScore(h, tally) }));
  const best: Record<Kind, number> = { plant: 0, animal: 0 };
  for (const x of scored) best[x.h.k] = Math.max(best[x.h.k], x.s);
  return scored
    .map((x) => ({ ...x, rel: best[x.h.k] > 0 ? x.s / best[x.h.k] : 0 }))
    .sort((a, b) => b.rel - a.rel || b.s - a.s || a.h.t - b.h.t)
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
  if (h.k === "plant") return `${displayName(h)} in bloom`;
  if (h.i === "Aves" && h.share >= ABSENT_SHARE) return `${displayName(h)} migration`;
  return `${displayName(h)} season`;
}

export function highlightTags(h: Highlight): string[] {
  const tags = [GROUP_TAGS[h.i] ?? (h.k === "plant" ? "bloom" : "wildlife")];
  if (h.k === "animal") tags.push("wildlife");
  const name = kebab(h.c || h.n || "");
  if (name && !tags.includes(name)) tags.push(name);
  return tags;
}

const short = (m: number) => cap(MONTH_NAMES[m - 1]!).slice(0, 3);

/** The iNaturalist observations search that matches a highlight: the species, the radius, the peak months. */
export function observationsSearchUrl(h: Highlight, lat: number, lng: number): string {
  const q = new URLSearchParams({ taxon_id: String(h.t), lat: lat.toFixed(4), lng: lng.toFixed(4), radius: String(RADIUS_KM), month: h.months.join(",") });
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
    note: `${Math.round(h.share * 100)}% of ${h.total} iNaturalist observations within ${RADIUS_KM} km fall in ${when}.`,
    source: "inaturalist",
    sourceUrl: observationsSearchUrl(h, city.lat, city.lng),
    feed: "inaturalist",
  };
}
