// Seasonal nature from iNaturalist observations (ADR 0021). For a place and a phenomenon
// (flowering jacaranda, humpback whales), the observations within 50 km, counted by month of
// the year, show when it happens there. Meridian stores only the twelve monthly counts per
// check, not the observations (the observations are CC BY-NC per observer).
//
// iNaturalist asks for about one request per second and at most 10,000 a day, so the check is
// rolling: each run does a bounded number of place and phenomenon checks, the ones never
// checked or checked longest ago first, and each result is kept for 30 days.

import type { City } from "../../../src/types.js";
import { MONTH_NAMES, countryKey, httpGet, HttpError, DAY_MS, type SourceContext, type SourceDef, type SourceResult, type StoredEvent } from "./common.js";
import { orderMonths } from "../../../src/lib/eventKinds.js";
import { PHENOMENA, type Phenomenon } from "./phenomena.js";

export const INAT_API = "https://api.inaturalist.org/v1";
export const RADIUS_KM = 50;
/** A check is kept this long before it is repeated. */
export const RECHECK_MS = 30 * DAY_MS;
/** Months holding at least this share of the year's observations are peak months. */
export const PEAK_SHARE = 0.15;
/** Checks one refresh runs, at about one request a second. */
export const DEFAULT_MAX_CHECKS = 35;
/** After this many zero-observation checks in a country, its other places are skipped for that phenomenon. */
export const ZERO_SKIP_AFTER = 2;
export const BUSIEST_CITIES = 150;

export interface InatCheck {
  at: string;
  /** Observations per month of the year, January first. */
  counts: number[];
  total: number;
}

export interface InatState {
  taxa: Record<string, { id: number | null; resolvedAt: string }>;
  checks: Record<string, InatCheck>;
  /** `${phenomenon}|${country}` -> zero-observation checks so far, and when the last one ran. */
  zeroCountries: Record<string, { n: number; at: string }>;
}

export const emptyInatState = (): InatState => ({ taxa: {}, checks: {}, zeroCountries: {} });

export function readInatState(raw: unknown): InatState {
  const r = raw as Partial<InatState> | null | undefined;
  if (!r || typeof r !== "object") return emptyInatState();
  return { taxa: r.taxa && typeof r.taxa === "object" ? r.taxa : {}, checks: r.checks && typeof r.checks === "object" ? r.checks : {}, zeroCountries: r.zeroCountries && typeof r.zeroCountries === "object" ? r.zeroCountries : {} };
}

/** Months (1-12) of the run of peak months around the busiest month: the months holding at least 15% of the year's observations. Empty when no month reaches 15%. */
export function peakMonths(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length !== 12 || total <= 0) return [];
  const hot = counts.map((c) => c / total >= PEAK_SHARE);
  const max = Math.max(...counts);
  const top = counts.indexOf(max);
  if (!hot[top]) return [];
  const run = new Set<number>([top]);
  for (let i = (top + 11) % 12; hot[i] && !run.has(i); i = (i + 11) % 12) run.add(i);
  for (let i = (top + 1) % 12; hot[i] && !run.has(i); i = (i + 1) % 12) run.add(i);
  return orderMonths([...run].map((i) => i + 1));
}

/** The monthly counts from a histogram response (interval=month_of_year), or undefined when the body is not one. */
export function parseHistogram(json: unknown): number[] | undefined {
  const m = (json as { results?: { month_of_year?: Record<string, unknown> } } | null)?.results?.month_of_year;
  if (!m || typeof m !== "object") return undefined;
  const counts: number[] = [];
  for (let i = 1; i <= 12; i++) {
    const v = Number(m[String(i)] ?? 0);
    if (!Number.isFinite(v) || v < 0) return undefined;
    counts.push(v);
  }
  return counts;
}

/** The taxon id for a scientific name: the exact name match with the most observations, else the first result. */
export function parseTaxon(json: unknown, name: string): number | null {
  const results = (json as { results?: { id?: number; name?: string; observations_count?: number }[] } | null)?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const exact = results.filter((r) => typeof r.name === "string" && r.name.toLowerCase() === name.toLowerCase());
  const pool = exact.length ? exact : results;
  const best = [...pool].sort((a, b) => (b.observations_count ?? 0) - (a.observations_count ?? 0))[0];
  return typeof best?.id === "number" ? best.id : null;
}

export function histogramUrl(taxonIds: number[], p: Phenomenon, lat: number, lng: number): string {
  const q = new URLSearchParams({ taxon_id: taxonIds.join(","), lat: lat.toFixed(4), lng: lng.toFixed(4), radius: String(RADIUS_KM), interval: "month_of_year", verifiable: "true" });
  if (p.annotation) {
    q.set("term_id", String(p.annotation.termId));
    q.set("term_value_id", String(p.annotation.termValueId));
  }
  return `${INAT_API}/observations/histogram?${q}`;
}

export function observationsUrl(taxonIds: number[], p: Phenomenon, lat: number, lng: number): string {
  const q = new URLSearchParams({ taxon_id: taxonIds.join(","), lat: lat.toFixed(4), lng: lng.toFixed(4), radius: String(RADIUS_KM), verifiable: "true" });
  if (p.annotation) {
    q.set("term_id", String(p.annotation.termId));
    q.set("term_value_id", String(p.annotation.termValueId));
  }
  return `https://www.inaturalist.org/observations?${q}`;
}

export interface CheckTask {
  city: City;
  phenomenon: Phenomenon;
  key: string;
  /** Last check time; "" when never checked. */
  checkedAt: string;
  rank: number;
  order: number;
}

const keyOf = (cityId: string, phenId: string) => `${cityId}|${phenId}`;

/**
 * The checks that are due, never-checked and longest-ago first, then by place rank (the owner's
 * places, then the busiest cities) and phenomenon order. Places outside a phenomenon's latitude
 * band or in a country another source covers are left out, and so are places in a country where
 * the phenomenon has come back empty twice in the last 30 days.
 */
export function dueChecks(cities: City[], state: InatState, now: Date, phenomena: Phenomenon[] = PHENOMENA): { tasks: CheckTask[]; skippedZero: number } {
  const tasks: CheckTask[] = [];
  let skippedZero = 0;
  cities.forEach((city, rank) => {
    phenomena.forEach((phenomenon, order) => {
      if (phenomenon.latBand && (city.lat < phenomenon.latBand[0] || city.lat > phenomenon.latBand[1])) return;
      if (phenomenon.skipCountries?.some((c) => countryKey(c) === countryKey(city.country))) return;
      const key = keyOf(city.id, phenomenon.id);
      const prev = state.checks[key];
      if (prev && now.getTime() - Date.parse(prev.at) < RECHECK_MS) return;
      const zero = state.zeroCountries[`${phenomenon.id}|${countryKey(city.country)}`];
      if (!prev && zero && zero.n >= ZERO_SKIP_AFTER && now.getTime() - Date.parse(zero.at) < RECHECK_MS) {
        skippedZero++;
        return;
      }
      tasks.push({ city, phenomenon, key, checkedAt: prev?.at ?? "", rank, order });
    });
  });
  tasks.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt) || a.rank - b.rank || a.order - b.order);
  return { tasks, skippedZero };
}

/** One event per place and phenomenon whose observations reach the minimum and show a season. */
export function eventsFromChecks(state: InatState, cities: Map<string, City>, phenomena: Phenomenon[] = PHENOMENA): StoredEvent[] {
  const events: StoredEvent[] = [];
  const byId = new Map(phenomena.map((p) => [p.id, p]));
  for (const [key, check] of Object.entries(state.checks)) {
    const [cityId, phenId] = key.split("|");
    const city = cityId ? cities.get(cityId) : undefined;
    const p = phenId ? byId.get(phenId) : undefined;
    if (!city || !p || check.total < p.minObservations) continue;
    const months = peakMonths(check.counts);
    if (!months.length) continue;
    const ids = p.taxonNames.map((n) => state.taxa[n]?.id).filter((x): x is number => typeof x === "number");
    const names = months.map((m) => MONTH_NAMES[m - 1]!.replace(/^./, (c) => c.toUpperCase()).slice(0, 3));
    events.push({
      id: `inat-${p.id}-${city.id}`,
      title: p.title,
      kind: "nature",
      cityIds: [city.id],
      month: months[0]!,
      ...(months.length > 1 ? { months } : {}),
      recurring: true,
      tags: [...p.tags],
      note: `Most observations ${names.length > 1 ? `${names[0]} to ${names[names.length - 1]}` : names[0]}: ${check.total} verifiable iNaturalist observations within ${RADIUS_KM} km.`,
      source: "inaturalist",
      ...(ids.length ? { sourceUrl: observationsUrl(ids, p, city.lat, city.lng) } : {}),
      feed: "inaturalist",
    });
  }
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

export const inaturalistSource: SourceDef = {
  id: "inaturalist",
  // Due often: a run does bounded work, and most runs find nothing due and make no request.
  intervalMs: 60 * 60 * 1000,
  mayBeEmpty: true,
  async run(ctx: SourceContext): Promise<SourceResult> {
    const state = readInatState(ctx.prev.state?.["inaturalist"]);
    const byId = new Map(ctx.cities.map((c) => [c.id, c]));
    const owner = await ctx.places.ownerCityIds().catch(() => [] as string[]);
    const ordered: City[] = [];
    const seen = new Set<string>();
    for (const id of [...owner, ...ctx.places.busiestCityIds(BUSIEST_CITIES)]) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        seen.add(id);
        ordered.push(c);
      }
    }
    const nowIso = ctx.now.toISOString();
    const { tasks, skippedZero: skippedAtStart } = dueChecks(ordered, state, ctx.now);
    let skippedLater = 0;
    let requests = 0;
    let ran = 0;
    let error: unknown;
    const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (requests > 0) await ctx.sleep(ctx.hostPauseMs);
      requests++;
      return fn();
    };
    const save = async () => {
      await ctx.checkpoint({ events: eventsFromChecks(state, byId), state, detail: summary() });
    };
    const summary = (): Record<string, number | string> => ({
      places: ordered.length,
      owners: owner.length,
      phenomena: PHENOMENA.length,
      checked: Object.keys(state.checks).length,
      ranThisRun: ran,
      due: tasks.length,
      skippedZeroCountry: skippedAtStart + skippedLater,
    });

    const resolveTaxa = async (p: Phenomenon): Promise<number[]> => {
      const ids: number[] = [];
      for (const name of p.taxonNames) {
        const cached = state.taxa[name];
        if (cached && ctx.now.getTime() - Date.parse(cached.resolvedAt) < RECHECK_MS) {
          if (cached.id !== null) ids.push(cached.id);
          continue;
        }
        const json = await paced(async () => (await httpGet(`${INAT_API}/taxa?q=${encodeURIComponent(name)}&per_page=5`, ctx, "iNaturalist")).json());
        const id = parseTaxon(json, name);
        state.taxa[name] = { id, resolvedAt: nowIso };
        if (id !== null) ids.push(id);
      }
      return ids;
    };

    try {
      for (const t of tasks) {
        if (ran >= ctx.maxChecks) break;
        const stopAt = ctx.softDeadline ?? ctx.deadline;
        if (stopAt !== undefined && Date.now() > stopAt - 1500) break;
        const zero = state.zeroCountries[`${t.phenomenon.id}|${countryKey(t.city.country)}`];
        if (!t.checkedAt && zero && zero.n >= ZERO_SKIP_AFTER) {
          skippedLater++;
          continue;
        }
        const ids = await resolveTaxa(t.phenomenon);
        let counts: number[] = new Array(12).fill(0);
        if (ids.length) {
          const json = await paced(async () => (await httpGet(histogramUrl(ids, t.phenomenon, t.city.lat, t.city.lng), ctx, "iNaturalist")).json());
          const parsed = parseHistogram(json);
          if (!parsed) throw new Error("iNaturalist answered with an unexpected histogram body");
          counts = parsed;
        }
        const total = counts.reduce((a, b) => a + b, 0);
        state.checks[t.key] = { at: nowIso, counts, total };
        const zk = `${t.phenomenon.id}|${countryKey(t.city.country)}`;
        if (total === 0) state.zeroCountries[zk] = { n: (state.zeroCountries[zk]?.n ?? 0) + 1, at: nowIso };
        else delete state.zeroCountries[zk];
        ran++;
        await save();
      }
    } catch (err) {
      error = err;
    }
    const events = eventsFromChecks(state, byId);
    if (error) {
      await ctx.checkpoint({ events, state, detail: summary() });
      const status = error instanceof HttpError ? ` (${error.status})` : "";
      throw new Error(`iNaturalist stopped after ${ran} checks${status}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
    }
    return { events, state, detail: summary() };
  },
};
