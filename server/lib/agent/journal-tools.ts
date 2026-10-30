// Agent journal tools (spec-journal §9, extends ADR 0003). Same contract as tools.ts:
// zod params, never throw (return {error}), identical on the real and mock paths.
//
// The journal is personal data and the agent route is public, so every tool is built
// per request via createJournalTools({ unlocked }); locked → { error: "journal_locked" }.
// draft_journey only ever creates ImportCandidates (source "manual"); the user confirms
// in the review inbox, the agent cannot.

import { createHash } from "crypto";
import { z } from "zod";
import type { FingerprintDim, Fingerprint, Journey, PlaceResult, ReplayQuery, ReplayResponse, ReplayResult } from "../../../src/types.js";
import { getCityById } from "../cities.js";
import { getJourney, listJourneys } from "../journal.js";
import { ensureFingerprint } from "../journalFingerprint.js";
import { addCandidates } from "../imports.js";
import { ReplayError } from "../replay.js";
import { replayQuerySchema } from "../replaySchema.js";
import { executeReplay } from "../replayService.js";
import { monthOf } from "../stayDates.js";

export const JOURNAL_LOCKED = { error: "journal_locked", message: "Unlock the journal (send the Meridian token) to use journal tools." } as const;

const month = z.number().int().min(1).max(12);
const rating = z.number().int().min(1).max(5);
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
function fail(tool: string, err: unknown): { error: string } {
  console.error(`[agent/journal-tools] ${tool} error:`, errMsg(err));
  return { error: err instanceof ReplayError ? err.code : `${tool}_failed` };
}
const invalid = (e: z.ZodError) => ({ error: "invalid_params", issues: e.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) });

// ── search_journal ───────────────────────────────────────────────────

export const searchJournalParams = z.object({
  text: z.string().trim().min(1).max(200).optional(),
  cityId: z.string().min(1).max(200).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  month: month.optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  minRating: rating.optional(),
});
export type SearchJournalParams = z.infer<typeof searchJournalParams>;

export interface JourneySummary {
  id: string;
  title: string;
  status: Journey["status"];
  startDate: string;
  endDate: string;
  cityIds: string[];
  rating?: number;
  tags: string[];
  fingerprint?: Partial<Pick<Fingerprint, "month" | "tempC" | "comfort" | "precipMm" | "dailySpendEur" | "crowdProxy" | "durationNights">>;
}

const SEARCH_LIMIT = 10;

function brief(f: Fingerprint | undefined): JourneySummary["fingerprint"] {
  if (!f) return undefined;
  const out: NonNullable<JourneySummary["fingerprint"]> = { month: f.month, durationNights: f.durationNights };
  for (const k of ["tempC", "comfort", "precipMm", "dailySpendEur", "crowdProxy"] as const) if (typeof f[k] === "number") out[k] = f[k];
  return out;
}

function summarize(j: Journey): JourneySummary {
  const s: JourneySummary = {
    id: j.id,
    title: j.title,
    status: j.status,
    startDate: j.startDate,
    endDate: j.endDate,
    cityIds: [...new Set(j.stops.map((x) => x.cityId))],
    tags: j.tags,
  };
  if (j.rating) s.rating = j.rating;
  const fp = brief(j.fingerprint);
  if (fp) s.fingerprint = fp;
  return s;
}

/** Does any stop's stay touch calendar `m` (any year)? */
function touchesMonth(j: Journey, m: number): boolean {
  return j.stops.some((s) => {
    for (let d = s.arrive; d <= s.depart; d = nextDay(d)) if (monthOf(d) === m) return true;
    return false;
  });
}
function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function matchesJourney(j: Journey, p: SearchJournalParams): boolean {
  const cities = j.stops.map((s) => getCityById(s.cityId));
  if (p.cityId && !j.stops.some((s) => s.cityId === p.cityId)) return false;
  if (p.country) {
    const c = fold(p.country);
    if (!cities.some((x) => x && fold(x.country).includes(c))) return false;
  }
  if (p.year !== undefined && (j.startDate.slice(0, 4) > String(p.year) || j.endDate.slice(0, 4) < String(p.year))) return false;
  if (p.month !== undefined && !touchesMonth(j, p.month)) return false;
  if (p.tags?.length && !p.tags.every((t) => j.tags.some((jt) => fold(jt) === fold(t)))) return false;
  if (p.minRating !== undefined && (j.rating ?? 0) < p.minRating) return false;
  if (p.text) {
    const t = fold(p.text);
    const hay = [j.title, j.notes ?? "", ...j.tags, ...cities.flatMap((x) => (x ? [x.name, x.country] : []))].map(fold).join("\n");
    if (!hay.includes(t)) return false;
  }
  return true;
}

// ── get_fingerprint ──────────────────────────────────────────────────

export const getFingerprintParams = z.object({
  journeyId: z.string().min(1).max(200),
  stopIndex: z.number().int().min(0).optional(),
});

// ── find_similar_windows ─────────────────────────────────────────────

const DEFAULT_WEIGHTS = { climate: 1, spend: 0.5, crowd: 0.5, flight: 0.5 };
const AGENT_LIMIT = 8;

/** ReplayQuery-like, flattened for LLM tool calls; {journeyId, bend, months} is the convenience form. */
export const findSimilarWindowsParams = z.object({
  journeyId: z.string().min(1).max(200).optional(),
  stopIndex: z.number().int().min(0).optional(),
  /** Alternative to journeyId: a partial fingerprint or an explicit template. */
  template: replayQuerySchema.shape.template.optional(),
  bend: replayQuerySchema.shape.bend.optional(),
  weights: replayQuerySchema.shape.weights.optional(),
  months: z.array(month).max(12).optional(),
  regions: z.array(z.string().min(1).max(50)).max(20).optional(),
  excludeVisited: z.boolean().optional(),
  maxFlightHours: z.number().positive().max(48).optional(),
  fromCityId: z.string().min(1).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  cityIds: z.array(z.string().min(1)).max(500).optional(),
  limit: z.number().int().min(1).max(AGENT_LIMIT).optional(),
});
export type FindSimilarWindowsParams = z.infer<typeof findSimilarWindowsParams>;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A replay result as an Open Place (reuses PlaceResult; replayMatch carries the breakdown). */
export function resultToPlace(r: ReplayResult): PlaceResult | undefined {
  const city = getCityById(r.cityId);
  if (!city) return undefined;
  const price = r.price?.priceEur !== undefined ? ` · flight ~€${Math.round(r.price.priceEur)}${r.price.source === "mock" ? " (mock estimate)" : ""}` : "";
  return {
    cityId: city.id,
    name: city.name,
    country: city.country,
    iata: city.iata,
    lat: city.lat,
    lng: city.lng,
    population: city.population,
    score: Math.round(r.match),
    summaryLine: `${MONTH_NAMES[r.month - 1]} · ${Math.round(r.match)}% match${price}`,
    replayMatch: { match: r.match, month: r.month, dims: r.dims, scoredOn: r.scoredOn as FingerprintDim[] },
  };
}

export interface FindSimilarWindowsResult {
  results: ReplayResult[];
  /** The same results as Open Places (each with replayMatch). */
  places: PlaceResult[];
  universeSize: number;
  templateClimate?: ReplayResponse["templateClimate"];
  template: ReplayResponse["template"];
}

// ── draft_journey ────────────────────────────────────────────────────

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const place = { cityId: z.string().min(1).max(200).optional(), cityHint: z.string().trim().min(1).max(200).optional() };

export const draftJourneyParams = z.object({
  title: z.string().trim().min(1).max(300),
  stops: z
    .array(z.object({ ...place, arrive: isoDay, depart: isoDay }).refine((s) => s.cityId || s.cityHint, "cityId or cityHint required"))
    .min(1)
    .max(30),
  segments: z
    .array(
      z.object({
        mode: z.enum(["flight", "train", "bus", "car", "ferry", "other"]).default("flight"),
        fromCityId: z.string().min(1).max(200).optional(),
        fromCityHint: z.string().trim().min(1).max(200).optional(),
        toCityId: z.string().min(1).max(200).optional(),
        toCityHint: z.string().trim().min(1).max(200).optional(),
        departAt: isoDay,
      })
    )
    .max(60)
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type DraftJourneyParams = z.infer<typeof draftJourneyParams>;

const refOf = (obj: unknown) => "agent:" + createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);

// ── tool factory ─────────────────────────────────────────────────────

export function createJournalTools(ctx: { unlocked: boolean }) {
  const locked = () => ({ ...JOURNAL_LOCKED });

  async function searchJournal(raw: SearchJournalParams): Promise<{ journeys: JourneySummary[]; total: number } | { error: string; [k: string]: unknown }> {
    if (!ctx.unlocked) return locked();
    const p = searchJournalParams.safeParse(raw ?? {});
    if (!p.success) return invalid(p.error);
    try {
      const hits = (await listJourneys()).filter((j) => matchesJourney(j, p.data)); // newest first
      return { journeys: hits.slice(0, SEARCH_LIMIT).map(summarize), total: hits.length };
    } catch (err) {
      return fail("search_journal", err);
    }
  }

  async function getFingerprint(raw: z.infer<typeof getFingerprintParams>) {
    if (!ctx.unlocked) return locked();
    const p = getFingerprintParams.safeParse(raw);
    if (!p.success) return invalid(p.error);
    try {
      let j = await getJourney(p.data.journeyId);
      if (!j) return { error: "journey_not_found" };
      j = await ensureFingerprint(j);
      if (p.data.stopIndex === undefined) return { journeyId: j.id, fingerprint: j.fingerprint ?? null };
      const stop = j.stops[p.data.stopIndex];
      if (!stop) return { error: "stop_not_found" };
      return { journeyId: j.id, stopIndex: p.data.stopIndex, cityId: stop.cityId, fingerprint: stop.fingerprint ?? null, observed: stop.observed ?? null };
    } catch (err) {
      return fail("get_fingerprint", err);
    }
  }

  async function findSimilarWindows(raw: FindSimilarWindowsParams): Promise<FindSimilarWindowsResult | { error: string; [k: string]: unknown }> {
    if (!ctx.unlocked) return locked();
    const p = findSimilarWindowsParams.safeParse(raw ?? {});
    if (!p.success) return invalid(p.error);
    const q = p.data;
    const template = q.template ?? (q.journeyId ? { journeyId: q.journeyId, stopIndex: q.stopIndex } : undefined);
    if (!template) return { error: "invalid_params", issues: ["template or journeyId required"] };
    const constraints = {
      months: q.months,
      regions: q.regions,
      excludeVisited: q.excludeVisited,
      maxFlightHours: q.maxFlightHours,
      fromCityId: q.fromCityId,
      tags: q.tags,
      cityIds: q.cityIds,
    };
    const query = replayQuerySchema.safeParse({
      template,
      bend: q.bend ?? {},
      weights: q.weights ?? DEFAULT_WEIGHTS,
      constraints: Object.fromEntries(Object.entries(constraints).filter(([, v]) => v !== undefined)),
      limit: q.limit ?? 5,
    });
    if (!query.success) return invalid(query.error);
    try {
      const res = await executeReplay(query.data as ReplayQuery);
      return {
        results: res.results,
        places: res.results.map(resultToPlace).filter((x): x is PlaceResult => !!x),
        universeSize: res.universeSize,
        templateClimate: res.templateClimate,
        template: res.template,
      };
    } catch (err) {
      return fail("find_similar_windows", err);
    }
  }

  async function draftJourney(raw: DraftJourneyParams) {
    if (!ctx.unlocked) return locked();
    const p = draftJourneyParams.safeParse(raw);
    if (!p.success) return invalid(p.error);
    try {
      for (const s of p.data.stops) if (s.cityId && !getCityById(s.cityId)) return { error: "unknown_city", cityId: s.cityId };
      const mk = (kind: "stop" | "segment", payload: Record<string, unknown>) => ({
        kind,
        payload,
        provenance: { source: "manual", sourceRef: refOf({ kind, payload }), confidence: "medium" },
      });
      const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
      const candidates = [
        ...p.data.stops.map((s) => mk("stop", clean({ cityId: s.cityId, cityHint: s.cityHint, arrive: s.arrive, depart: s.depart }))),
        ...(p.data.segments ?? []).map((s) =>
          mk("segment", clean({ mode: s.mode, fromCityId: s.fromCityId, cityHint: s.fromCityHint, toCityId: s.toCityId, toCityHint: s.toCityHint, departAt: s.departAt }))
        ),
      ];
      const report = await addCandidates(candidates);
      if (report.added + report.duplicates === 0) return { error: "draft_rejected", report };
      // Candidates carry no title/notes field; they are echoed so the user can set them when accepting.
      return { drafted: report.added, duplicates: report.duplicates, report, title: p.data.title, notes: p.data.notes, next: "Review and accept in the journal inbox (#/journal/inbox); the agent cannot confirm journeys." };
    } catch (err) {
      return fail("draft_journey", err);
    }
  }

  return { searchJournal, getFingerprint, findSimilarWindows, draftJourney };
}

// ── mock-path intent (deterministic) ─────────────────────────────────

const MONTH_RE: Array<[RegExp, number]> = [
  [/\bjan(uary)?\b/, 1], [/\bfeb(ruary)?\b/, 2], [/\bmar(ch)?\b/, 3], [/\bapr(il)?\b/, 4], [/\bmay\b/, 5], [/\bjun(e)?\b/, 6],
  [/\bjul(y)?\b/, 7], [/\baug(ust)?\b/, 8], [/\bsep(t(ember)?)?\b/, 9], [/\boct(ober)?\b/, 10], [/\bnov(ember)?\b/, 11], [/\bdec(ember)?\b/, 12],
];
const SEASONS: Array<[RegExp, number[]]> = [
  [/\bspring\b/, [3, 4, 5]], [/\bsummer\b/, [6, 7, 8]], [/\b(autumn|fall)\b/, [9, 10, 11]], [/\bwinter\b/, [12, 1, 2]],
];

export interface JournalIntent {
  cityName?: string;
  /** Month of the past journey being referenced ("last May"). */
  pastMonth?: number;
  bend: { tempC?: number; spendPct?: number; crowd?: number };
  months?: number[];
}

const MONTH_ALT = MONTH_RE.map(([re]) => re.source.replace(/\\b/g, "")).join("|");
/** Wording that points at the user's own past ("last May", "my trip", "when I went"); bare "like" does not. */
const PAST_TRIP_RE = new RegExp(
  `\\b(last|past|previous) (${MONTH_ALT}|month|year|week|summer|winter|spring|autumn|fall|trip|holiday)\\b|` +
    `\\bmy (past |last |previous )?(journal|trips?|journeys?|holiday)\\b|\\b(when|where) i (went|visited|stayed|was)\\b|\\bi (went|visited|stayed)\\b`
);

/**
 * Returns an intent only when the message compares to the user's own past ("like Lisbon last May"):
 * comparison wording AND a past-trip marker. Ordinary "I'd like to see Tokyo" stays on the normal flow.
 */
export function parseJournalIntent(text: string, mentionedCityName?: string): JournalIntent | undefined {
  const t = text.toLowerCase();
  const compares = /\b(like|similar to|same as|reminds me of)\b/.test(t);
  const mentionsJournal = /\bjournal\b|\bmy (past |last |previous )?(trips?|journeys?)\b/.test(t);
  if (!compares || !PAST_TRIP_RE.test(t) || (!mentionedCityName && !mentionsJournal)) return undefined;
  // A month names the past trip only after "last/in/from/of/during" ("last May"), never as the verb "may".
  const pastMonth = MONTH_RE.find(([re]) => new RegExp(`\\b(?:last|in|from|of|during)\\s+(?:${re.source})`).test(t))?.[1];
  const bend: JournalIntent["bend"] = {};
  if (/\b(warmer|hotter|sunnier)\b/.test(t)) bend.tempC = 3;
  else if (/\b(cooler|colder|milder)\b/.test(t)) bend.tempC = -3;
  if (/\b(cheaper|more affordable|less expensive|budget)\b/.test(t)) bend.spendPct = -25;
  if (/\b(fewer crowds|quieter|less crowded|less touristy)\b/.test(t)) bend.crowd = -20;
  const months = SEASONS.find(([re]) => re.test(t))?.[1];
  return { cityName: mentionedCityName, pastMonth, bend, months };
}
