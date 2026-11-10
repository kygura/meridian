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
import { visaConstraints } from "../../src/lib/solver/visaRules.js";
import { inSchengen, sameCountry } from "../../src/lib/solver/visa.js";
import { BUFFER_MAX_KM, borderRunOptions, schengenBuffers } from "../../src/lib/visa/engine.js";
import { haversineKm } from "../../src/lib/geo.js";
import { getVisaData } from "./visaData.js";
import { getVisaSettings } from "./visaStore.js";
import { suggestionPlaces } from "./visaService.js";
import { passportCodes } from "../../src/lib/visa/settings.js";
import { SCHENGEN } from "../../src/lib/visa/data.js";

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
      // The rotation (and an earlier stop) wins where both cover the same nights; the stop's
      // other nights still count.
      for (const piece of uncovered(a, b, out)) out.push({ country, ...piece });
    }
  }
  return out;
}

/** The parts of [a, b) that no range in `cover` holds (ISO dates, end exclusive). */
export function uncovered(a: string, b: string, cover: { start: string; end: string }[]): { start: string; end: string }[] {
  let pieces = [{ start: a, end: b }];
  for (const c of cover) {
    pieces = pieces.flatMap((p) => {
      if (c.end <= p.start || p.end <= c.start) return [p];
      const keep: { start: string; end: string }[] = [];
      if (p.start < c.start) keep.push({ start: p.start, end: c.start });
      if (c.end < p.end) keep.push({ start: c.end, end: p.end });
      return keep;
    });
  }
  return pieces.filter((p) => p.start < p.end);
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
  // The visa module (ADR 0012): limits for the owner's passports, and places it adds so a legal
  // plan exists (Schengen buffers, border-run targets). Each added place is named in the notes.
  const prior = await priorPresence(rot.stays, start);
  const visaData = getVisaData();
  const passports = passportCodes(await getVisaSettings().catch(() => null));
  const added = visaData && passports.length ? visaSuggestions(visaData, passports, reqs, s, start) : { reqs: [], notes: [] };
  reqs.push(...added.reqs);
  const data = await buildCandidates(reqs, rot.places, { news: !!req.news, timeoutMs: 4000 });
  const visa = visaConstraints(visaData, passports, [...data.candidates.map((c) => c.place.country ?? ""), ...prior.map((p) => p.country)], start, s.constraints);
  // A fixed stay must stay fixed: if there is no data for its place, solving around it would
  // put other stays over its dates (and score the plan as if its nights did not exist).
  const unknownFixed = fixed.filter((f) => !data.candidates.some((c) => c.place.cityId === f.cityId));
  if (unknownFixed.length) {
    const named = unknownFixed.map((f) => `${stayById.get(f.id)?.place.name ?? f.cityId} (${f.start} to ${f.end})`).join(", ");
    return { error: `Meridian has no data for ${named}, which is booked, locked or where you are, so it cannot plan around it. Pick the place again in the rotation, then solve.` };
  }
  const candidates = data.candidates.map((c) => ({
    ...c,
    ...(c.place.country && visa.excluded.has(c.place.country) ? { excluded: visa.excluded.get(c.place.country)! } : {}),
    ...(exclude.has(c.place.cityId) ? { excluded: exclude.get(c.place.cityId)! } : {}),
    ...(penalise.has(c.place.cityId) ? { penalty: { points: penalise.get(c.place.cityId)!.points, reason: penalise.get(c.place.cityId)!.reason } } : {}),
  }));
  const input: SolveInput = {
    start,
    months,
    from,
    budgetMonthlyEur: s.budgetMonthlyEur,
    candidates,
    fixed,
    prior,
    constraints: visa.constraints,
    preferences: s.preferences,
    weights: s.weights,
    results: s.results,
    seed: s.seed,
  };
  return {
    input,
    notes: [...notes, ...data.notes, ...added.notes, ...visa.notes],
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

export interface AcceptConflict {
  error: "conflict";
  message: string;
}

/**
 * Make a plan the active rotation: its solver-placed stays become planned stays (origin
 * solver), and the unlocked, unbooked stays they replace inside the horizon are deleted.
 * Fixed stays (locked, booked, where you are) are never touched.
 */
export async function acceptPlan(plan: PlanInput, runId: string, now = new Date(), today = todayIso(now)): Promise<AcceptResult | AcceptConflict> {
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
  // Refuse, before changing anything, a plan whose new stays would overlap a stay that stays:
  // one booked, locked or started since the plan was made, or a fixed stay that has grown.
  const removing = new Set(removable.map((s) => s.id));
  const placed = stays.filter((s) => s.role !== "fixed");
  for (const r of rot.stays) {
    if (removing.has(r.id) || effectiveStatus(r, today) === "idea") continue;
    const span = staySpan(r);
    if (!span) continue;
    const hit = placed.find((p) => p.start < span.end && span.start < p.end);
    if (hit) {
      return {
        error: "conflict",
        message: `${r.place.name} (${span.start} to ${span.end}) now overlaps this plan's ${getCityById(hit.cityId)?.name ?? hit.cityId} (${hit.start} to ${hit.end}). It was booked, locked or changed since the plan was made; solve again for a fresh one.`,
      };
    }
  }
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


/**
 * Places the visa module adds to the pool so that a legal plan exists: when the pool has
 * Schengen bases but no base outside Schengen within reach, the two best Schengen buffers; when
 * border runs are allowed and a pool base has a per-entry limit, the nearest place the passports
 * enter on arrival, as a pass-through. Nothing is added that the pool already covers.
 */
export function visaSuggestions(data: NonNullable<ReturnType<typeof getVisaData>>, passports: string[], reqs: CandidateRequest[], s: SolverSettings, start: string): { reqs: CandidateRequest[]; notes: string[] } {
  const out: CandidateRequest[] = [];
  const notes: string[] = [];
  const have = new Set(reqs.map((r) => r.cityId));
  const pool = reqs.filter((r) => r.inPool).map((r) => ({ r, city: getCityById(r.cityId) })).filter((x): x is { r: CandidateRequest; city: NonNullable<ReturnType<typeof getCityById>> } => !!x.city);
  const places = suggestionPlaces();
  const schengenBases = pool.filter((x) => x.r.kind === "base" && inSchengen(x.city.country));
  const freeMove = passports.some((p) => SCHENGEN.freeMovement.includes(p));
  if (schengenBases.length && !freeMove) {
    const lat = schengenBases.reduce((a, x) => a + x.city.lat, 0) / schengenBases.length;
    const lng = schengenBases.reduce((a, x) => a + x.city.lng, 0) / schengenBases.length;
    const outsideNear = pool.some((x) => x.r.kind === "base" && !inSchengen(x.city.country) && haversineKm([lng, lat], [x.city.lng, x.city.lat]) <= BUFFER_MAX_KM);
    if (!outsideNear) {
      for (const b of schengenBuffers(data, passports, { lat, lng }, start, 60, places, 2)) {
        if (have.has(b.place.cityId)) continue;
        have.add(b.place.cityId);
        out.push({ cityId: b.place.cityId, kind: "base", inPool: true });
        notes.push(`Added ${b.place.name} (${b.countryName}) to the pool as a Schengen buffer: ${b.km.toLocaleString("en-US")} km from your Schengen places${b.comfort !== null ? `, comfort ${b.comfort}` : ""}. Remove it from the pool to leave it out.`);
      }
    }
  }
  if (s.constraints.allowBorderRuns) {
    for (const x of pool.filter((p) => p.r.kind === "base" && !inSchengen(p.city.country))) {
      const runs = borderRunOptions(data, passports, { country: x.city.country, lat: x.city.lat, lng: x.city.lng, date: start }, places, 3);
      if (!runs.options.length) continue;
      const covered = [...pool.map((p) => p.city), ...out.map((o) => getCityById(o.cityId)!)].some((c) => c && !sameCountry(c.country, x.city.country) && runs.options.some((o) => sameCountry(o.place.country, c.country)) && haversineKm([x.city.lng, x.city.lat], [c.lng, c.lat]) <= 1500);
      if (covered) continue;
      const o = runs.options[0];
      if (have.has(o.place.cityId)) continue;
      have.add(o.place.cityId);
      out.push({ cityId: o.place.cityId, kind: "pass-through", inPool: true });
      notes.push(`Added ${o.place.name} (${o.countryName}) as a border-run stop for ${x.city.name}: ${o.estimate}.${runs.notes.length ? ` ${runs.notes.join(" ")}` : ""}`);
    }
  }
  return { reqs: out, notes };
}


/** The owner's constraints with the visa module's limits for their passports (ADR 0012), for the re-plan check. */
export async function ownerVisaConstraints(base: SolverSettings["constraints"], countries: string[], start: string) {
  const passports = passportCodes(await getVisaSettings().catch(() => null));
  return visaConstraints(getVisaData(), passports, countries, start, base);
}
