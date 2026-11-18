// Seasonal highlights from iNaturalist (ADR 0021). For a city, the species whose observations
// within 30 km bunch into a short season are found from the data itself: nothing says in advance
// which species or which countries matter. highlights.ts holds the detection and ranking.
//
// A check is 24 requests: GET /v1/observations/species_counts for each month of the year, once
// for plants and once for conspicuous animals. iNaturalist asks for about one request
// a second and at most 10,000 a day, so the source is rolling: each run checks as many cities as
// its time allows, the owner's places first, and a result is kept for 60 days. Meridian stores the
// monthly counts of the few seasonal species per city, not observations (CC BY-NC per observer).

import type { City } from "../../../src/types.js";
import { httpGet, HttpError, DAY_MS, type SourceContext, type SourceDef, type SourceResult, type StoredEvent } from "./common.js";
import { fetchPlaceText, genusAlternatives, mentionOf } from "./placeText.js";
import {
  compactHighlight,
  expandHighlight,
  genericGenusNames,
  highlightEvent,
  parseSpeciesCounts,
  RADIUS_KM,
  rankHighlights,
  seasonalPool,
  selectStored,
  tallyHighlights,
  type Candidate,
  type Highlight,
  type StoredHighlight,
  type Kind,
  type SpeciesPage,
} from "./highlights.js";

export const INAT_API = "https://api.inaturalist.org/v1";
/** A check is kept this long before it is repeated. */
export const RECHECK_MS = 60 * DAY_MS;
/** Cities one refresh may check. Off Vercel a run has no time budget, so this bounds it (about 24 s each, 24 minutes for 60). */
export const DEFAULT_MAX_CHECKS = 60;
/** Rows one month page asks for. */
export const PAGE_SIZE: Record<Kind, number> = { plant: 100, animal: 150 };
/** Requests in one city check: twelve months for each of two kinds, up to 8 lookups of genus names, up to 9 for the place's text. */
export const REQUESTS_PER_CITY = 24 + 8 + 9;
/** A city whose text could not be found is checked again after this. */
export const NO_TEXT_RECHECK_MS = 7 * DAY_MS;
/** Requests in flight at once. With the one-second start spacing this stays at about one request a second. */
const IN_FLIGHT = 2;
/** A request that gets a 429 is retried this many times, after waiting. */
const MAX_RETRIES = 2;
/** Wikimedia's hosts answer 429 often to a shared address, so their requests wait and try again more. */
const WIKI_RETRIES = 4;
const RETRY_CAP_MS = 30_000;
const GENUS_RANKS = new Set(["genus", "subgenus", "section", "subsection", "series", "subseries"]);
const ANIMAL_TAXA = "Aves,Mammalia,Insecta,Reptilia,Amphibia,Actinopterygii,Mollusca";
const STATE_VERSION = 2;

export interface InatCheck {
  at: string;
  /** 0 when no text of the place could be read (mentions were not available); absent or 1 otherwise. */
  t?: 0 | 1;
  /** Seasonal species found at the place, best first (at most 15 per kind). */
  highlights: StoredHighlight[];
}

export interface InatState {
  version: number;
  checks: Record<string, InatCheck>;
  /** iNaturalist's common name for a taxon at or inside genus rank, by taxon id; "" when it has none or is of a higher rank. */
  taxa?: Record<string, string>;
}

export const emptyInatState = (): InatState => ({ version: STATE_VERSION, checks: {} });

/** The stored state, or an empty one when it is missing or was written by the earlier phenomenon-list version. */
export function readInatState(raw: unknown): InatState {
  const r = raw as Partial<InatState> | null | undefined;
  if (!r || typeof r !== "object" || r.version !== STATE_VERSION || !r.checks || typeof r.checks !== "object") return emptyInatState();
  return { version: STATE_VERSION, checks: r.checks, ...(r.taxa && typeof r.taxa === "object" ? { taxa: r.taxa } : {}) };
}

export function speciesCountsUrl(kind: Kind, lat: number, lng: number, month: number): string {
  const q = new URLSearchParams({ lat: lat.toFixed(4), lng: lng.toFixed(4), radius: String(RADIUS_KM), per_page: String(PAGE_SIZE[kind]), month: String(month) });
  // Plants: every grade, so planted trees and gardens count. The spectacles people travel for
  // (cherries, jacaranda, tulips) are cultivated, and iNaturalist grades cultivated observations
  // casual and rarely annotates them as flowering. Animals: verifiable only, which leaves out zoos.
  if (kind === "plant") {
    q.set("iconic_taxa", "Plantae");
    q.set("quality_grade", "any");
  } else {
    q.set("iconic_taxa", ANIMAL_TAXA);
    q.set("verifiable", "true");
  }
  return `${INAT_API}/observations/species_counts?${q}`;
}

export interface CheckTask {
  city: City;
  /** Last check time; "" when never checked. */
  checkedAt: string;
  rank: number;
}

/**
 * The cities due for a check, never-checked first and then the longest ago, each group in the
 * order given (the owner's places, the cities people look at, the other airport cities). A city
 * checked less than 60 days ago is not due.
 */
export function dueChecks(ordered: City[], state: InatState, now: Date): CheckTask[] {
  const tasks: CheckTask[] = [];
  ordered.forEach((city, rank) => {
    const prev = state.checks[city.id];
    if (prev && now.getTime() - Date.parse(prev.at) < (prev.t === 0 ? NO_TEXT_RECHECK_MS : RECHECK_MS)) return;
    tasks.push({ city, checkedAt: prev?.at ?? "", rank });
  });
  return tasks.sort((a, b) => a.checkedAt.localeCompare(b.checkedAt) || a.rank - b.rank);
}

/** The cities in checking order: the owner's, then by attention, then the remaining airport cities by population. */
export function orderCities(cities: City[], owner: string[], attention: string[]): City[] {
  const byId = new Map(cities.map((c) => [c.id, c]));
  const out: City[] = [];
  const seen = new Set<string>();
  const add = (c: City | undefined) => {
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  };
  for (const id of owner) add(byId.get(id));
  for (const id of attention) add(byId.get(id));
  for (const c of cities.filter((x) => x.iata).sort((a, b) => b.population - a.population || a.id.localeCompare(b.id))) add(c);
  return out;
}

/** The events of every checked city: highlights ranked against the tally of all checked cities, three a city at most. */
export function eventsFromChecks(state: InatState, cities: Map<string, City>): StoredEvent[] {
  const entries = Object.entries(state.checks);
  const tally = tallyHighlights(entries.map(([, c]) => c.highlights));
  const generic = genericGenusNames(Object.values(state.taxa ?? {}), genusAlternatives);
  const events: StoredEvent[] = [];
  for (const [cityId, check] of entries) {
    const city = cities.get(cityId);
    if (!city) continue;
    const list = check.highlights.map(expandHighlight).filter((h): h is Highlight => h !== undefined);
    for (const h of rankHighlights(list, tally, check.t !== 0, generic)) events.push(highlightEvent(h, city));
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
    const ordered = orderCities(ctx.cities, owner, ctx.places.attentionCityIds());
    const nowIso = ctx.now.toISOString();
    const tasks = dueChecks(ordered, state, ctx.now);
    let requests = 0;
    let ran = 0;
    let error: unknown;

    // Request starts are spaced `hostPauseMs` apart, at most two in flight.
    let nextStart = 0;
    const slot = async () => {
      const now = Date.now();
      const at = Math.max(now, nextStart);
      nextStart = at + ctx.hostPauseMs;
      if (at > now) await ctx.sleep(at - now);
    };
    // One JSON request, spaced by the pause. A 429 is waited out (Retry-After, 10 s when absent, at most 30 s) and retried before the run gives up.
    const fetchJson = async (url: string, label: string, retries = MAX_RETRIES): Promise<unknown> => {
      for (let attempt = 0; ; attempt++) {
        await slot();
        requests++;
        try {
          return await (await httpGet(url, ctx, label)).json();
        } catch (err) {
          if (!(err instanceof HttpError) || err.status !== 429 || attempt >= retries) throw err;
          const secs = Number(err.retryAfter);
          const wait = Math.min(RETRY_CAP_MS, err.retryAfter !== null && Number.isFinite(secs) && secs >= 0 ? Math.max(secs, 2) * 1000 * (attempt + 1) : 10_000);
          const limit = ctx.deadline ?? ctx.softDeadline;
          if (limit !== undefined && Date.now() + wait > limit - 1500) throw err;
          nextStart = Math.max(nextStart, Date.now() + wait);
        }
      }
    };
    const fetchPage = async (kind: Kind, city: City, month: number): Promise<SpeciesPage> => {
      const page = parseSpeciesCounts(await fetchJson(speciesCountsUrl(kind, city.lat, city.lng, month), "iNaturalist"));
      if (!page) throw new Error("iNaturalist answered with an unexpected species_counts body");
      return page;
    };
    /** iNaturalist's common names for parent taxa not seen before, 30 ids a request; a failed lookup leaves the names empty. */
    const genusNames = async (ids: number[]): Promise<void> => {
      state.taxa ??= {};
      const need = [...new Set(ids)].filter((id) => state.taxa![String(id)] === undefined);
      for (let i = 0; i < need.length; i += 30) {
        const chunk = need.slice(i, i + 30);
        try {
          const json = (await fetchJson(`${INAT_API}/taxa/${chunk.join(",")}?per_page=30&locale=en`, "iNaturalist")) as { results?: { id?: number; rank?: string; preferred_common_name?: string }[] };
          for (const id of chunk) state.taxa[String(id)] = "";
          // Only a genus or a rank inside it names what the place's text might call the plant or animal; a family or a complex does not.
          for (const r of json.results ?? []) if (typeof r.id === "number" && GENUS_RANKS.has(r.rank ?? "")) state.taxa[String(r.id)] = r.preferred_common_name ?? "";
        } catch {
          // Without the genus names only the species' own names and its common name's last word are matched.
        }
      }
    };
    let textFound = false;
    const checkCity = async (city: City): Promise<StoredHighlight[]> => {
      const jobs: { kind: Kind; month: number }[] = (["plant", "animal"] as Kind[]).flatMap((kind) => Array.from({ length: 12 }, (_, i) => ({ kind, month: i + 1 })));
      const pages: Record<Kind, SpeciesPage[]> = { plant: new Array(12), animal: new Array(12) };
      let next = 0;
      let failed: unknown;
      const worker = async () => {
        while (failed === undefined) {
          const job = jobs[next++];
          if (!job) return;
          try {
            pages[job.kind][job.month - 1] = await fetchPage(job.kind, city, job.month);
          } catch (err) {
            failed = err;
          }
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
      if (failed !== undefined) throw failed;
      const pools: Record<Kind, Candidate[]> = { plant: seasonalPool(pages.plant, "plant", PAGE_SIZE.plant), animal: seasonalPool(pages.animal, "animal", PAGE_SIZE.animal) };
      const all = [...pools.plant, ...pools.animal];
      await genusNames(all.flatMap((h) => h.parentIds ?? []));
      const place = await fetchPlaceText(city, (url, label) => fetchJson(url, label, WIKI_RETRIES));
      textFound = place.text.length > 0;
      if (textFound) {
        for (const h of all) {
          const genusCommon = (h.parentIds ?? []).map((id) => state.taxa?.[String(id)] ?? "").filter(Boolean);
          const men = mentionOf(place.text, { n: h.n ?? "", c: h.c, genusCommon });
          if (men.w) {
            h.w = men.w;
            if (men.w === 2) {
              h.g = (h.n ?? "").split(" ")[0] ?? "";
              if (men.gc) h.gc = men.gc;
              if (men.blossom) h.b = 1;
            }
          }
        }
      }
      return [...selectStored(pools.plant, "plant"), ...selectStored(pools.animal, "animal")].map(compactHighlight);
    };

    const summary = (): Record<string, number | string> => ({
      cities: ordered.length,
      owners: owner.length,
      checked: Object.keys(state.checks).length,
      ranThisRun: ran,
      // Cities never checked or last checked 60 or more days ago: while this is above zero the source keeps being retried.
      pending: tasks.length - ran,
      requests,
    });
    const save = async () => ctx.checkpoint({ events: eventsFromChecks(state, byId), state, detail: summary() });

    try {
      for (const t of tasks) {
        if (ran >= ctx.maxChecks) break;
        // Start a city only when its requests can finish before the run's limit.
        const limit = ctx.deadline ?? ctx.softDeadline;
        if (limit !== undefined && Date.now() + REQUESTS_PER_CITY * ctx.hostPauseMs > limit - 1500) break;
        const highlights = await checkCity(t.city);
        state.checks[t.city.id] = { at: nowIso, ...(textFound ? {} : { t: 0 as const }), highlights };
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
      throw new Error(`iNaturalist stopped after ${ran} cities${status}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
    }
    return { events, state, detail: summary() };
  },
};
