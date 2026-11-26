// Live events (ADR 0021). Replaces the hand-kept data/events.json.
//
// What the owner means by events: local festivities, eclipses, the seasonal highlights of each
// place (read from its Wikivoyage and Wikipedia text by Claude), climate and tourism seasons, and the sky. Each is a source,
// fetched or computed at run time; no event list and no species list lives in the codebase.
//
//   festivities           Wikidata    recurring local festivals, not film, music, arts or pride   7 days
//   national-festivities  Wikidata    country-wide festivals on a capital and big airport cities  7 days
//   eclipses              Wikidata    solar eclipses, and total lunar eclipses                    7 days
//   highlights            Claude      rolling seasonal highlights read from Wikivoyage and Wikipedia text, 120 days per city   rolling
//   aurora                NOAA SWPC   northern lights season (computed) and live Kp alerts        3 hours
//   tourism-seasons       computed    peak and shoulder seasons from measured visitor nights      at read
//   climate-seasons       computed    rainy, dry and snow seasons from monthly climate normals    at read
//
// The result is cached in the document store (events-live.json) with one status line per
// source. A source that fails keeps its previous events, so a transient error never empties
// the list. getLiveEvents() never throws and never blocks on a stale copy; it blocks (once,
// single-flight) only when there is nothing stored yet.

import type { City, MeridianEvent } from "../../src/types.js";
import { getCities } from "./cities.js";
import { createJsonStore } from "./jsonStore.js";
import { cityIndexFor, DAY_MS, realSleep, type Fetch, type FetchResponse, type LiveEventsFile, type PlaceDeps, type SourceContext, type SourceDef, type SourceResult, type SourceStatus, type StoredEvent } from "./events/common.js";
import { auroraSource } from "./events/aurora.js";
import { COMPUTED, computedStatus, type ComputedSource } from "./events/computed.js";
import { DEFAULT_MAX_CALLS, highlightsSource } from "./events/claudeHighlights.js";
import { defaultPlaceDeps } from "./events/places.js";
import { eclipsesSource, festivitiesSource, nationalFestivitiesSource } from "./events/wikidata.js";

export {
  bindingsOf,
  buildCityIndex,
  cityIndexFor,
  countryKey,
  monthOf,
  parsePoint,
  runSparql,
  tagOf,
  USER_AGENT,
  WIKIDATA_ENDPOINT,
  type CityIndex,
  type Fetch,
  type FetchResponse,
  type LiveEventsFile,
  type SourceStatus,
  type StoredEvent,
} from "./events/common.js";

export const SOURCE_LABEL = "Wikidata (CC0), Wikivoyage and Wikipedia (CC BY-SA), NOAA SWPC";

const PAUSE_BETWEEN_QUERIES_MS = 1000;
const FILE_CACHE_MS = 60_000;
/** After an attempt (successful or not) no new refresh is started for this long. */
const RETRY_AFTER_ATTEMPT_MS = 60 * 60 * 1000;
/** A source that has never landed is retried after this (another request or instance may be fetching it now). */
const RETRY_MISSING_MS = 2 * 60 * 1000;
const COMPUTED_CACHE_MS = 60 * 60 * 1000;

const emptyFile = (): LiveEventsFile => ({ version: 1, sources: [], events: [] });
const store = createJsonStore<LiveEventsFile>("events-live.json", emptyFile);

/** Order matters: when two sources carry the same item, the earlier one wins. */
export const SOURCES: SourceDef[] = [festivitiesSource, nationalFestivitiesSource, eclipsesSource, highlightsSource, auroraSource];

const sourceRank = (id: string) => {
  const i = SOURCES.findIndex((s) => s.id === id);
  return i === -1 ? SOURCES.length : i;
};

// Refresh

export interface RefreshOptions {
  fetch?: Fetch;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between sources in one lane. */
  pauseMs?: number;
  /** Test seam: replaces the loaded city list. */
  cities?: City[];
  /**
   * Time this run may take, in ms. Sources not started by then wait for the next run; each
   * finished source is already saved. Default 45 s on Vercel (functions stop at 60 s), none elsewhere.
   */
  budgetMs?: number;
  /** Sources run at once. Wikidata allows a few parallel queries per client; default 2. */
  concurrency?: number;
  /** Run only the sources that are due (never landed, or older than their own interval). Default: all of them. */
  onlyDue?: boolean;
  /** With onlyDue: no source counts as fresh for longer than this many days, whatever its own interval. */
  maxAgeDays?: number;
  /** Test seam: where the owner's places and the cities by attention come from. */
  places?: PlaceDeps;
  /** Claude calls the highlights source may make in one refresh. Default 8 on Vercel, 40 elsewhere. */
  maxChecks?: number;
  /** Pause between requests to Wikimedia and the like, ms. Default 1000. */
  hostPauseMs?: number;
  /** Test seam: the computed sources. Default: the real ones, except under Vitest where there are none. */
  computed?: ComputedSource[];
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

/**
 * Puts one source's outcome into the file: its events replace that source's earlier ones, its
 * working state (if any) replaces its earlier state, and when two sources carry the same item the
 * one earlier in SOURCES wins. Events from a feed no source produces any more are dropped.
 */
export function applySource(file: LiveEventsFile, status: SourceStatus, events: StoredEvent[], state?: unknown): void {
  const known = new Set(SOURCES.map((x) => x.id));
  const merged = [...file.events.filter((e) => e.feed !== status.id && known.has(e.feed)), ...events].sort((a, b) => sourceRank(a.feed) - sourceRank(b.feed));
  file.events = dedupeAndSort(merged);
  file.sources = [...file.sources.filter((x) => x.id !== status.id && known.has(x.id)), status].sort((a, b) => sourceRank(a.id) - sourceRank(b.id));
  for (const x of file.sources) x.count = file.events.filter((e) => e.feed === x.id).length;
  if (file.state) file.state = Object.fromEntries(Object.entries(file.state).filter(([id]) => known.has(id)));
  if (state !== undefined) file.state = { ...file.state, [status.id]: state };
  if (status.ok && status.fetchedAt && (!file.fetchedAt || status.fetchedAt > file.fetchedAt)) file.fetchedAt = status.fetchedAt;
}

/**
 * True when a source's last run succeeded and said work is left (`detail.pending`, the rolling
 * highlights source with cities still to read). Such a source is retried on the short backoff
 * and runs whenever a refresh of the due sources starts, so ordinary use keeps it filling.
 */
export function hasPendingWork(id: string, file: LiveEventsFile): boolean {
  const s = file.sources.find((x) => x.id === id);
  const pending = s?.detail?.["pending"];
  return s?.ok === true && typeof pending === "number" && pending > 0;
}

/** When a source's last fetch is old enough to repeat. `maxAgeDays` caps the interval. */
function sourceDue(src: SourceDef, file: LiveEventsFile, now: Date, maxAgeDays?: number): boolean {
  if (hasPendingWork(src.id, file)) return true;
  const landed = file.sources.find((x) => x.id === src.id && x.fetchedAt);
  if (landed && (landed.rules ?? 0) !== (src.rules ?? 0)) return true;
  const at = Date.parse(file.sources.find((x) => x.id === src.id && x.fetchedAt)?.fetchedAt ?? "");
  if (!Number.isFinite(at)) return true;
  const interval = maxAgeDays === undefined ? src.intervalMs : Math.min(src.intervalMs, maxAgeDays * DAY_MS);
  return now.getTime() - at > interval;
}

/** Sources never fetched first, then the oldest, so a run cut short still moves the oldest forward. */
function sourceOrder(prev: LiveEventsFile): SourceDef[] {
  const at = (id: string) => prev.sources.find((x) => x.id === id && x.ok)?.fetchedAt ?? "";
  return [...SOURCES].sort((a, b) => at(a.id).localeCompare(at(b.id)) || sourceRank(a.id) - sourceRank(b.id));
}

/**
 * Runs the sources, two at a time by default, and saves each one as it finishes (a rolling
 * source saves after each unit of work), so a run that is stopped (a serverless time limit)
 * keeps what it got. A source that fails, or returns nothing where it had events before, keeps
 * its previous events and fetchedAt and records the error. Sources left when the budget runs out
 * are not started. Throws only when the store cannot be written.
 */
export async function refreshLiveEvents(opts: RefreshOptions = {}): Promise<LiveEventsFile> {
  if (networkOff(opts.fetch !== undefined)) throw new Error("live events fetching is disabled (LIVE_EVENTS=off or a test run)");
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? (process.env.VERCEL ? 45_000 : undefined);
  // No source starts after `softDeadline`; one already running may use 10 s more (functions stop at 60 s).
  const softDeadline = budgetMs === undefined ? undefined : Date.now() + budgetMs;
  const base = {
    fetch: opts.fetch ?? ((url: string, init?: Parameters<Fetch>[1]) => fetch(url, init) as Promise<FetchResponse>),
    sleep: opts.sleep ?? realSleep,
    ...(softDeadline !== undefined ? { deadline: softDeadline + 10_000, softDeadline } : {}),
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

  const queue = sourceOrder(prev).filter((s) => !opts.onlyDue || sourceDue(s, prev, now, opts.maxAgeDays));
  const runOne = async (src: SourceDef): Promise<void> => {
    const before = prev.sources.find((x) => x.id === src.id);
    const beforeEvents = prev.events.filter((e) => e.feed === src.id);
    // What the source last saved on its own (a rolling source saves as it goes).
    let saved: SourceResult | undefined;
    const okStatus = (r: SourceResult): SourceStatus => ({
      id: src.id,
      ok: true,
      count: r.events.length,
      ...(r.unmatched !== undefined ? { unmatched: r.unmatched } : {}),
      ...(r.unplaced ? { unplaced: r.unplaced } : {}),
      ...(r.detail ? { detail: r.detail } : {}),
      fetchedAt: nowIso,
      ...(src.rules ? { rules: src.rules } : {}),
    });
    const ctx: SourceContext = {
      ...base,
      now,
      cities,
      index: cityIndexFor(cities),
      prev,
      places: opts.places ?? defaultPlaceDeps,
      maxChecks: opts.maxChecks ?? DEFAULT_MAX_CALLS,
      hostPauseMs: opts.hostPauseMs ?? 1000,
      async checkpoint(r) {
        saved = r;
        await store.update((f) => applySource(f, okStatus(r), r.events, r.state));
        memo = undefined;
      },
    };
    let status: SourceStatus;
    let events: StoredEvent[];
    let state: unknown;
    try {
      if (cities.length === 0) throw new Error("cities are not loaded");
      const r = await src.run(ctx);
      if (r.events.length === 0 && beforeEvents.length > 0 && !src.mayBeEmpty) throw new Error("source returned no events; kept the previous ones");
      events = r.events;
      state = r.state;
      status = okStatus(r);
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.warn(`[events] ${src.id} failed: ${error}`);
      events = saved?.events ?? beforeEvents;
      state = saved?.state;
      status = { id: src.id, ok: false, count: events.length, error, ...(saved?.detail ?? before?.detail ? { detail: saved?.detail ?? before?.detail } : {}), ...(before?.fetchedAt ? { fetchedAt: before.fetchedAt } : {}) };
    }
    await store.update((f) => applySource(f, status, events, state));
    memo = undefined;
  };

  const lanes = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, queue.length)) }, async () => {
    let first = true;
    for (let src = queue.shift(); src; src = queue.shift()) {
      if (softDeadline !== undefined && Date.now() > softDeadline) {
        queue.length = 0;
        break;
      }
      if (!first && pauseMs > 0) await base.sleep(pauseMs);
      first = false;
      await runOne(src);
    }
  });
  await Promise.all(lanes);

  const file = await readFileSafe();
  memo = undefined;
  return file;
}

// Reading

let memo: { key: string; at: number; file: LiveEventsFile } | undefined;
let inflight: Promise<LiveEventsFile> | undefined;
let computedMemo: { at: number; sources: ComputedSource[]; events: StoredEvent[]; statuses: SourceStatus[] } | undefined;

/** Test seam: forget the in-memory copy and any refresh in flight. */
export function resetLiveEventsForTests(): void {
  memo = undefined;
  inflight = undefined;
  computedMemo = undefined;
}

/** Test seam: wait for any refresh in flight to finish its writes (its errors are ignored). */
export async function settleLiveEventsForTests(): Promise<void> {
  await inflight?.catch(() => undefined);
}

async function readCached(): Promise<LiveEventsFile> {
  const key = store.path();
  if (memo && memo.key === key && Date.now() - memo.at < FILE_CACHE_MS) return memo.file;
  const file = await readFileSafe();
  memo = { key, at: Date.now(), file };
  return file;
}

function computedSourcesFor(opts: { computed?: ComputedSource[] }): ComputedSource[] {
  return opts.computed ?? (process.env.VITEST !== undefined ? [] : COMPUTED);
}

/** Events computed from Meridian's own data (tourism and climate seasons), kept for an hour. */
function computedEvents(sources: ComputedSource[]): { events: StoredEvent[]; statuses: SourceStatus[] } {
  if (computedMemo && computedMemo.sources === sources && Date.now() - computedMemo.at < COMPUTED_CACHE_MS) return computedMemo;
  const events: StoredEvent[] = [];
  const statuses: SourceStatus[] = [];
  const at = new Date().toISOString();
  for (const src of sources) {
    try {
      const r = src.compute();
      events.push(...r.events);
      statuses.push(computedStatus(src, r.events, r.detail, at));
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.warn(`[events] ${src.id} failed: ${error}`);
      statuses.push({ id: src.id, ok: false, count: 0, error });
    }
  }
  computedMemo = { at: Date.now(), sources, events, statuses };
  return computedMemo;
}

function startRefresh(opts: RefreshOptions): Promise<LiveEventsFile> {
  opts = { ...opts, onlyDue: true };
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
    (x.months === undefined || (Array.isArray(x.months) && x.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12))) &&
    Array.isArray(x.cityIds) && x.cityIds.every((c) => typeof c === "string") &&
    Array.isArray(x.tags) && x.tags.every((t) => typeof t === "string") &&
    (x.date === undefined || typeof x.date === "string") &&
    typeof x.feed === "string" &&
    // A copy stored by an earlier version can hold feeds no source produces now (film festivals, sports, jma, inaturalist).
    SOURCES.some((s) => s.id === x.feed)
  );
}

/**
 * Stale when a source has never landed or is older than its own interval (`maxAgeDays` caps
 * it). After an attempt, waits an hour before trying again, or two minutes while some source
 * was never reached (a run cut short by a time limit), so the next request picks it up
 * instead of a week later.
 */
export function isStale(file: LiveEventsFile, now: Date, maxAgeDays?: number): boolean {
  const landed = (id: string) => file.sources.find((x) => x.id === id && x.fetchedAt)?.fetchedAt;
  // Never landed and never failed (a run was cut short before reaching it), or work is left over.
  const rulesChanged = (src: SourceDef) => {
    const s = file.sources.find((x) => x.id === src.id && x.fetchedAt);
    return !!s && (s.rules ?? 0) !== (src.rules ?? 0);
  };
  const missing = SOURCES.some((src) => (!landed(src.id) && !file.sources.some((x) => x.id === src.id && x.error)) || hasPendingWork(src.id, file) || rulesChanged(src));
  const old = SOURCES.some((src) => sourceDue(src, file, now, maxAgeDays));
  if (!missing && !old) return false;
  // `old` includes sources that failed and never landed: those wait the hour like any failure.
  const attempt = file.attemptedAt ? Date.parse(file.attemptedAt) : NaN;
  const wait = missing ? RETRY_MISSING_MS : RETRY_AFTER_ATTEMPT_MS;
  return !(Number.isFinite(attempt) && now.getTime() - attempt < wait);
}

/**
 * Keeps a background promise running after the answer is sent. On Vercel this is the request
 * context's waitUntil (what @vercel/functions wraps); elsewhere the process keeps running anyway.
 */
function keepAlive(p: Promise<unknown>): void {
  try {
    const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
      Symbol.for("@vercel/request-context")
    ]?.get?.();
    ctx?.waitUntil?.(p.catch(() => undefined));
  } catch {
    // No request context: nothing to extend.
  }
}

export interface LiveEventsStatus {
  fetchedAt: string | null;
  attemptedAt: string | null;
  total: number;
  sources: SourceStatus[];
}

/** Sources, counts and errors of the stored copy and the computed sources. Reads only; never starts a refresh. */
export async function liveEventsStatus(opts: { computed?: ComputedSource[] } = {}): Promise<LiveEventsStatus> {
  const f = await readCached();
  const c = computedEvents(computedSourcesFor(opts));
  const stored = f.events.filter(validEvent);
  const known = new Set(SOURCES.map((s) => s.id));
  return { fetchedAt: f.fetchedAt ?? null, attemptedAt: f.attemptedAt ?? null, total: stored.length + c.events.length, sources: [...f.sources.filter((x) => known.has(x.id)), ...c.statuses] };
}

/**
 * The live events. Serves the stored copy; when a source is due a refresh of the due sources
 * starts (one refresh at a time, shared by concurrent callers) and the stale copy is served
 * meanwhile. An empty store waits up to `waitMs` (8 s) and then serves what has been saved so
 * far. Events computed from Meridian's own data are added. Never throws: on failure it returns
 * what it has, or [].
 */
export async function getLiveEvents(opts: { maxAgeDays?: number; waitMs?: number } & RefreshOptions = {}): Promise<MeridianEvent[]> {
  try {
    const now = opts.now ?? new Date();
    let file = await readCached();
    if (isStale(file, now, opts.maxAgeDays) && !networkOff(opts.fetch !== undefined)) {
      const run = startRefresh(opts);
      if (file.events.length === 0) {
        // Wait a little for the first sources; the rest keep filling the store after this answer.
        const waitMs = opts.waitMs ?? 8000;
        const timer = new Promise<"late">((r) => setTimeout(() => r("late"), waitMs).unref?.());
        try {
          const out = await Promise.race([run, timer]);
          if (out === "late") {
            run.catch((err) => console.error("[events] refresh failed:", err instanceof Error ? err.message : String(err)));
            keepAlive(run);
            memo = undefined;
            file = await readCached();
          } else file = out;
        } catch (err) {
          console.error("[events] refresh failed:", err instanceof Error ? err.message : String(err));
        }
      } else {
        run.catch((err) => console.error("[events] background refresh failed:", err instanceof Error ? err.message : String(err)));
        keepAlive(run);
      }
    }
    const stored = file.events.filter(validEvent);
    const computed = computedEvents(computedSourcesFor(opts)).events;
    return [...stored, ...computed].map(({ feed: _feed, ...e }) => e);
  } catch (err) {
    console.error("[events] could not load events:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
