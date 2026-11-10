// Solver service (ADR 0015): reads the owner's rotation and journal, gathers real data for
// the pool, runs the pure engine, and writes an accepted plan back as rotation stays.

import { getCityById, getCities } from "./cities.js";
import { listJourneys } from "./journal.js";
import { deleteStay, putStay, readRotation, stateOf } from "./rotation.js";
import { buildCandidates, type CandidateRequest } from "./solverData.js";
import { addMonthsToDate, evaluatePlan, solve } from "../../src/lib/solver/engine.js";
import {
  effectiveStatus,
  hasDates,
  placeFromCity,
  stayPresence,
  staySpan,
  todayIso,
  type RotationPlace,
  type RotationState,
  type RotationStay,
} from "../../src/lib/rotation.js";
import type { FixedStay, PlanInput, PriorPresence, ProposedRotation, SolveInput, SolveResult } from "../../src/lib/solver/types.js";
import type { SolverSettings } from "../../src/lib/solver/settings.js";
import type { FlightHub } from "../../src/lib/geo.js";

export interface SolveRequest {
  settings: SolverSettings;
  /** Horizon start; default today. */
  start?: string;
  /** Where the owner is at the start, when the rotation does not say. */
  fromCityId?: string;
  /** Stays of a proposal the owner locked in the Solve flow (not saved yet). */
  pins?: { id: string; cityId: string; start: string; end: string; kind: "base" | "pass-through" }[];
  /** Re-planning: places never to place, and places to penalise. */
  exclude?: { cityId: string; reason: string }[];
  penalise?: { cityId: string; points: number; reason: string }[];
  /** Fetch news Issues and Watch Flags for the pool (slower; may be unreachable). */
  news?: boolean;
  /** Treat these rotation stays as fixed as well (e.g. everything booked, when re-planning). */
  alsoFix?: (s: RotationStay, today: string) => boolean;
}

export interface Prepared {
  input: SolveInput;
  notes: string[];
  rotation: RotationState;
  places: { cityId: string; name: string; country?: string; lat: number; lng: number; inPool: boolean }[];
}

let hubCache: FlightHub[] | null = null;
function hubs(): FlightHub[] {
  // Same rule as tripPlan.hubsFromCities (which is browser-side): large airports with a code.
  hubCache ??= getCities()
    .filter((c) => c.hub === "large" && c.iata)
    .map((c) => ({ coord: [c.lng, c.lat] as [number, number], label: c.iata! }));
  return hubCache;
}

/** Committed stays that the solver must keep: locked, booked, or where the owner is on the start day. */
export function fixedFromRotation(stays: RotationStay[], start: string, end: string, today: string, alsoFix?: SolveRequest["alsoFix"]): { fixed: FixedStay[]; notes: string[] } {
  const notes: string[] = [];
  const fixed: FixedStay[] = [];
  for (const s of stays) {
    if (s.status === "idea") continue;
    const span = staySpan(s);
    if (!span || span.end <= start || span.start >= end) continue;
    const st = effectiveStatus(s, today);
    const current = span.start <= start && start < span.end;
    const why = s.locked ? "Locked" : st === "booked" ? "Booked" : current ? "Where you are" : alsoFix?.(s, today) ? "Kept" : null;
    if (!why) continue;
    if (span.approx) notes.push(`${s.place.name} is fixed by its month window (${span.start} to ${span.end}); set dates to fix it exactly.`);
    fixed.push({ id: s.id, cityId: s.place.cityId, start: span.start, end: span.end, kind: s.kind, why });
  }
  return { fixed, notes };
}

/** Where the owner has been, from the rotation's committed stays and the journal's journeys. */
export async function priorPresence(stays: RotationStay[], start: string): Promise<PriorPresence[]> {
  const out: PriorPresence[] = [];
  for (const p of stayPresence(stays)) {
    if (p.tentative || p.start >= start) continue;
    out.push({ country: p.country, start: p.start, end: p.end < start ? p.end : start });
  }
  const cutoff = addMonthsToDate(start, -13);
  let journeys: Awaited<ReturnType<typeof listJourneys>> = [];
  try {
    journeys = await listJourneys();
  } catch {
    journeys = [];
  }
  for (const j of journeys) {
    for (const stop of j.stops) {
      if (!stop.arrive || !stop.depart || stop.depart <= cutoff || stop.arrive >= start) continue;
      const country = getCityById(stop.cityId)?.country;
      if (!country) continue;
      const a = stop.arrive;
      const b = stop.depart < start ? stop.depart : start;
      // The rotation wins where both cover the same nights.
      if (out.some((o) => o.start < b && a < o.end)) continue;
      out.push({ country, start: a, end: b });
    }
  }
  return out;
}

function placeAt(stays: RotationStay[], start: string): RotationPlace | null {
  const committed = stays.filter((s) => s.status !== "idea" && hasDates(s));
  const here = committed.find((s) => s.start! <= start && start < s.end!);
  if (here) return here.place;
  const before = committed.filter((s) => s.end! <= start).sort((a, b) => b.end!.localeCompare(a.end!))[0];
  return before?.place ?? null;
}

function ownCost(s: RotationStay | undefined): CandidateRequest["ownCostEur"] {
  const m = s?.rentMonthly ?? s?.budgetMonthly;
  if (!m || m.currency !== "EUR") return undefined;
  return { value: m.amount, source: s?.rentMonthly ? "Your rent" : "Your budget" };
}

export async function prepareSolve(req: SolveRequest, today = todayIso()): Promise<Prepared | { error: string }> {
  const rot = stateOf(await readRotation());
  const s = req.settings;
  const start = req.start ?? today;
  const months = Math.max(12, Math.min(18, s.months));
  const end = addMonthsToDate(start, months);
  const { fixed, notes } = fixedFromRotation(rot.stays, start, end, today, req.alsoFix);
  for (const p of req.pins ?? []) {
    if (fixed.some((f) => f.start < p.end && p.start < f.end)) {
      notes.push(`Your lock on ${getCityById(p.cityId)?.name ?? p.cityId} overlaps a fixed stay and was left out.`);
      continue;
    }
    fixed.push({ ...p, why: "Locked here" });
  }
  let from = placeAt(rot.stays, start) ?? rot.settings.home ?? null;
  if (req.fromCityId) {
    const c = getCityById(req.fromCityId);
    if (c) from = placeFromCity(c);
  }
  if (!from) return { error: "Say where you'll be when the plan starts: add your current stay or a home airport in the rotation's settings." };
  const stayById = new Map(rot.stays.map((x) => [x.id, x]));
  const exclude = new Map((req.exclude ?? []).map((e) => [e.cityId, e.reason]));
  const penalise = new Map((req.penalise ?? []).map((e) => [e.cityId, e]));
  const reqs: CandidateRequest[] = [
    ...s.pool.map((p) => ({ ...p, inPool: true })),
    ...fixed.filter((f) => !s.pool.some((p) => p.cityId === f.cityId)).map((f) => ({ cityId: f.cityId, kind: f.kind, inPool: false, ownCostEur: ownCost(stayById.get(f.id)) })),
  ];
  const data = await buildCandidates(reqs, rot.places, { news: !!req.news, timeoutMs: 4000 });
  const candidates = data.candidates.map((c) => ({
    ...c,
    ...(exclude.has(c.place.cityId) ? { excluded: exclude.get(c.place.cityId)! } : {}),
    ...(penalise.has(c.place.cityId) ? { penalty: { points: penalise.get(c.place.cityId)!.points, reason: penalise.get(c.place.cityId)!.reason } } : {}),
  }));
  const input: SolveInput = {
    start,
    months,
    from,
    budgetMonthlyEur: s.budgetMonthlyEur,
    candidates,
    fixed: fixed.filter((f) => candidates.some((c) => c.place.cityId === f.cityId)),
    prior: await priorPresence(rot.stays, start),
    constraints: s.constraints,
    preferences: s.preferences,
    weights: s.weights,
    results: s.results,
    seed: s.seed,
  };
  return {
    input,
    notes: [...notes, ...data.notes],
    rotation: rot,
    places: candidates.map((c) => ({ cityId: c.place.cityId, name: c.place.name, country: c.place.country, lat: c.place.lat, lng: c.place.lng, inPool: c.inPool })),
  };
}

export interface SolveResponse extends SolveResult {
  notes: string[];
  places: Prepared["places"];
  input: Pick<SolveInput, "start" | "months" | "from" | "budgetMonthlyEur" | "fixed">;
}

export async function runSolve(req: SolveRequest, today = todayIso()): Promise<SolveResponse | { error: string }> {
  const p = await prepareSolve(req, today);
  if ("error" in p) return p;
  const t0 = performance.now();
  const r = solve(p.input, { hubs: hubs() }, () => performance.now() - t0);
  return { ...r, notes: p.notes, places: p.places, input: { start: p.input.start, months: p.input.months, from: p.input.from, budgetMonthlyEur: p.input.budgetMonthlyEur, fixed: p.input.fixed } };
}

export async function runEvaluate(req: SolveRequest, plan: PlanInput, today = todayIso()): Promise<{ rotation: ProposedRotation; notes: string[] } | { error: string }> {
  const p = await prepareSolve(req, today);
  if ("error" in p) return p;
  const ev = evaluatePlan(p.input, plan, { hubs: hubs() });
  if ("error" in ev) return ev;
  return { rotation: ev, notes: p.notes };
}

/** The active rotation inside a horizon, as a plan the engine can score (gaps left as they are). */
export function activePlan(stays: RotationStay[], start: string, end: string): PlanInput {
  return {
    stays: stays
      .filter((s) => s.status !== "idea" && hasDates(s) && s.end! > start && s.start! < end)
      .sort((a, b) => a.start!.localeCompare(b.start!))
      .map((s) => ({ id: s.id, cityId: s.place.cityId, start: s.start! < start ? start : s.start!, end: s.end! > end ? end : s.end!, kind: s.kind, role: "fixed" as const })),
  };
}

export interface AcceptResult {
  added: RotationStay[];
  removed: { id: string; name: string; start?: string; end?: string }[];
}

/**
 * Make a plan the active rotation: its solver-placed stays become planned stays (origin
 * solver), and the unlocked, unbooked stays they replace inside the horizon are deleted.
 * Fixed stays (locked, booked, where you are) are never touched.
 */
export async function acceptPlan(plan: PlanInput, runId: string, now = new Date(), today = todayIso(now)): Promise<AcceptResult> {
  const rot = stateOf(await readRotation());
  const stays = [...plan.stays].sort((a, b) => a.start.localeCompare(b.start));
  if (!stays.length) return { added: [], removed: [] };
  const start = stays[0].start;
  const end = stays[stays.length - 1].end;
  const keep = new Set(stays.filter((s) => s.role === "fixed").map((s) => s.id));
  const removable = rot.stays.filter((s) => {
    if (keep.has(s.id) || s.locked) return false;
    const st = effectiveStatus(s, today);
    if (st !== "idea" && st !== "planned") return false;
    const span = staySpan(s);
    return !!span && span.start >= start && span.start < end;
  });
  const removed: AcceptResult["removed"] = [];
  for (const s of removable) {
    await deleteStay(s.id, now);
    removed.push({ id: s.id, name: s.place.name, start: s.start, end: s.end });
  }
  const added: RotationStay[] = [];
  let n = 0;
  for (const s of stays) {
    if (s.role === "fixed") continue;
    const city = getCityById(s.cityId);
    if (!city) continue;
    const id = `sv-${runId}-${++n}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
    const r = await putStay(
      id,
      {
        place: placeFromCity(city),
        kind: s.kind,
        status: "planned",
        start: s.start,
        end: s.end,
        notes: s.notes?.length ? s.notes.join(" ") : undefined,
        origin: { kind: "solver", runId },
      } as never,
      undefined,
      now
    );
    if (r.ok) added.push(r.value);
  }
  return { added, removed };
}
