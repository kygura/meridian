// Rotation Solver (ADR 0015): proposes whole rotations from a pool of places.
//
// Pure and deterministic: the same SolveInput (and seed) gives the same output, with no
// clock, no randomness and no I/O. The server gathers the data; the browser can run
// `evaluatePlan` to re-score an edited plan.
//
// Method. The horizon is cut into half-month slots (1st–15th, 16th–end), further cut at
// the edges of fixed stays (locked, booked, current), so a fixed stay is a run of whole
// slots and keeps its exact dates. A beam search walks the slots in order. Each search
// state is a partial rotation; at every slot it either stays where it is (up to the
// place's maximum nights) or moves to another pool place (once the current stay has its
// minimum). Hard constraints are checked as each slot is added, so an illegal state is
// never kept: Schengen 90/180 and the owner's per-country rules (with day counts that
// include past stays), measured internet and healthcare floors, the owner's "avoid"
// months and excluded places. The beam keeps the best `beamWidth` states per slot by
// the weighted score so far. Distinct proposals come from the final beam, then from
// re-runs that penalise slots already used by accepted proposals; a proposal must differ
// from every accepted one in at least a fifth of its nights.
//
// Every accepted plan is then re-checked and re-scored by `evaluatePlan`, the single
// source of truth: a plan with any violation is dropped, never returned.
//
// Cost: O(I · S · W · P) slot expansions for I runs (at most 3 × results), S slots
// (24–36 for 12–18 months, plus cuts at fixed stays), beam width W (96) and P pool
// places (capped at 40 by the API). That is under 2 million cheap steps; see the
// timing test. Beam search is not exhaustive: it can miss the global best when a
// choice only pays off many slots later. Limits: half-month resolution for solver-placed
// stays; pass-throughs are only inserted as hubs on long moves or for border runs.

import { buildLeg, type LandmassOf } from "../legs";
import type { FlightHub } from "../geo";
import { haversineKm } from "../geo";
import { addDays, nightsByMonth, type FitLevel, type RotationPlace } from "../rotation";
import type { TripNode } from "../../types";
import { applies, meets, preferenceLabel } from "./prefs";
import {
  addRange,
  dayIso,
  dayNum,
  inSchengen,
  nightsByYear,
  countryKey,
  peakUse,
  sameCountry,
  SCHENGEN_RULE,
  SCHENGEN_SOURCE,
  TAX_NOTE,
  usedOn,
  type Ranges,
} from "./visa";
import type {
  Alternative,
  Candidate,
  Component,
  MonthRow,
  PlanInput,
  PlannedMove,
  PlannedStay,
  ProposedRotation,
  SolveInput,
  SolveResult,
  StayRole,
  VisaReport,
  Weights,
} from "./types";

// ── Scoring constants (documented in ADR 0015; each one is shown in the result) ─────

/** Points per fit level. "Unknown" is scored in the middle and flagged. */
export const FIT_POINTS: Record<FitLevel, number> = { great: 100, good: 80, fair: 55, poor: 25, avoid: 0, unknown: 50 };
/** A month costing 1.5 × budget or more scores 0 for cost; at or under budget, 100. */
export const COST_ZERO_AT = 1.5;
/** Unknown cost is scored in the middle and flagged. */
export const COST_UNKNOWN_POINTS = 50;
/** Friction points per move: 1, plus 0.3 per hour, plus 1 per $200 (estimates, legs.ts). */
export const MOVE_BASE = 1;
export const MOVE_PER_HOUR = 0.3;
export const MOVE_PER_USD = 1 / 200;
/** Friction score = 100 − move points per year × this. */
export const FRICTION_SCALE = 1.5;
/** Flights of this many hours or more count as long-haul (unless a preference says otherwise). */
export const LONG_HAUL_HOURS = 6;
/** Below this many spare Schengen days the visa margin score falls, reaching 0 at none. */
export const SCHENGEN_COMFORT_DAYS = 15;
/** Tax days within this many of the threshold lower the visa score. */
export const TAX_COMFORT_DAYS = 30;
/** Risk points per item kind and severity (× severity). News fades: full for 90 days, half to 180, none after. */
export const RISK_POINTS = { advisory: 25, conflict: 25, hazard: 20, issue: 10, flag: 5 } as const;
export const BORDER_RUN_NIGHTS = 2;
/** A hub pass-through is considered on moves this long or longer, if it adds at most 15% distance. */
export const HUB_MIN_HOURS = 7;
export const HUB_MAX_DETOUR = 1.15;
export const DISTINCT_SHARE = 0.2;
export const DEFAULT_BEAM = 96;

/** What the risk score rests on: a curated seed list and the news, not official advisories. */
export const RISK_SCOPE_NOTE =
  "Risk comes from Meridian's curated list of conflicts, advisories and seasonal hazards (partial, with its own as-of date) and from recent news when it could be reached. It is not an official travel advisory: check your government's current advice before you travel.";

/** What the visa score covers, shown with every plan: it is not visa clearance. */
export const VISA_SCOPE_NOTE =
  "Only Schengen 90/180, the tax-day threshold and the country limits you entered are checked. Meridian has no visa database: other countries' entry limits are not checked, so a high visa margin is not visa clearance.";
/** Where past days come from: anything not recorded counts as zero. */
export const SCHENGEN_PRIOR_NOTE =
  "Past Schengen days are counted only from your rotation and the last 13 months of your journal; days not recorded there are assumed to be zero.";

export const DEFAULT_WEIGHTS: Weights = { fit: 1, cost: 0.8, friction: 0.6, visa: 0.6, risk: 0.6, preferences: 0.8 };

export const SOLVER_METHOD =
  "Beam search over half-month slots, keeping the best partial rotations at each step. Hard rules (Schengen 90/180, your country rules, internet and healthcare floors where measured, months you avoid, locked and booked stays) are checked on every step, so nothing illegal is kept. The total is the weighted mean of six scores, each 0–100. Flight times and costs are distance estimates, not fares.";

const COMPONENT_LABEL: Record<keyof Weights, string> = {
  fit: "Fit",
  cost: "Cost",
  friction: "Travel",
  visa: "Visa margin",
  risk: "Risk",
  preferences: "Preferences",
};

// ── Small helpers ──────────────────────────────────────────────────────

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const r1 = (x: number) => Math.round(x * 10) / 10;

/** 32-bit mix, for seeded tie-breaking (no Math.random). */
export function mix(a: number, b: number): number {
  let h = Math.imul(a ^ b, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return h >>> 0;
}

export function hashString(s: string, seed = 0): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return h;
}

/** Same day-of-month `months` later, clamped to the month's last day. */
export function addMonthsToDate(d: string, months: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const k = y * 12 + (m - 1) + months;
  const ny = Math.floor(k / 12);
  const nm = (k % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

// ── Slots ──────────────────────────────────────────────────────────────

export interface Slot {
  start: number;
  /** Exclusive (the move-out day). */
  end: number;
  nights: number;
  /** 1-12 */
  month: number;
  year: number;
  ym: string;
  /** Index into input.fixed, or -1. */
  fixed: number;
  /** Start of the free gap this slot is in, and its end (fixed edge or horizon end). */
  gapStart: number;
  gapEnd: number;
}

export function buildSlots(start: string, end: string, fixed: { start: string; end: string }[]): Slot[] {
  const s0 = dayNum(start);
  const s1 = dayNum(end);
  const cuts = new Set<number>([s0, s1]);
  for (let d = s0; d < s1; d++) {
    const dom = new Date(d * 86_400_000).getUTCDate();
    if (dom === 1 || dom === 16) cuts.add(d);
  }
  for (const f of fixed) {
    const a = dayNum(f.start);
    const b = dayNum(f.end);
    if (a > s0 && a < s1) cuts.add(a);
    if (b > s0 && b < s1) cuts.add(b);
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const fixedOf = (a: number, b: number) => fixed.findIndex((f) => dayNum(f.start) <= a && b <= dayNum(f.end));
  let pieces = edges.slice(0, -1).map((a, i) => ({ start: a, end: edges[i + 1], fixed: fixedOf(a, edges[i + 1]) }));
  // Merge slivers (under 4 nights) left by fixed edges into a free neighbour in the same month.
  const monthOf = (d: number) => dayIso(d).slice(0, 7);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.fixed !== -1 || p.end - p.start >= 4) continue;
      const next = pieces[i + 1];
      const prev = pieces[i - 1];
      if (next && next.fixed === -1 && monthOf(next.start) === monthOf(p.start)) {
        pieces = [...pieces.slice(0, i), { start: p.start, end: next.end, fixed: -1 }, ...pieces.slice(i + 2)];
        merged = true;
        break;
      }
      if (prev && prev.fixed === -1 && monthOf(prev.start) === monthOf(p.start)) {
        pieces = [...pieces.slice(0, i - 1), { start: prev.start, end: p.end, fixed: -1 }, ...pieces.slice(i + 1)];
        merged = true;
        break;
      }
    }
  }
  const slots: Slot[] = pieces.map((p) => {
    const iso = dayIso(p.start);
    return { ...p, nights: p.end - p.start, month: Number(iso.slice(5, 7)), year: Number(iso.slice(0, 4)), ym: iso.slice(0, 7), gapStart: p.start, gapEnd: p.end };
  });
  // Free gaps: runs of free slots between fixed ones (or the horizon's ends).
  for (let i = 0; i < slots.length; ) {
    if (slots[i].fixed !== -1) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < slots.length && slots[j + 1].fixed === -1) j++;
    for (let k = i; k <= j; k++) {
      slots[k].gapStart = slots[i].start;
      slots[k].gapEnd = slots[j].end;
    }
    i = j + 1;
  }
  return slots;
}

// ── Prepared problem ───────────────────────────────────────────────────

export interface SolverEnv {
  hubs?: FlightHub[];
}

interface Leg {
  km: number;
  hours: number;
  costUsd: number;
  mode: string;
  via?: string;
  method: string;
  points: number;
}

interface Prepared {
  input: SolveInput;
  /** Candidates plus the start location as the last entry. */
  cands: Candidate[];
  fromIdx: number;
  byCity: Map<string, number>;
  slots: Slot[];
  start: number;
  end: number;
  totalNights: number;
  horizonMonths: number;
  weights: Weights;
  weightSum: number;
  /** Per slot, per candidate: hard-allowed (static checks). */
  allowed: Uint8Array[];
  /** Per slot, per candidate: weighted additive points (fit, cost, risk, month-scoped prefs). */
  gain: Float64Array[];
  /** Month-scoped preference: nights it applies over the horizon. */
  prefNights: number[];
  prefWeightSum: number;
  /** Per candidate: rule index (into constraints.countryRules) by country, or -1. */
  ruleOf: Int32Array;
  pool: number[];
  passThroughs: number[];
  borderTargets: number[][];
  fixedCand: number[];
  legCache: Map<number, Leg>;
  hubs: FlightHub[];
  landmassOf: LandmassOf;
  /** The entry the owner is in when the horizon starts (from prior presence), for per-entry limits. */
  priorEntry: { country: string; start: number } | null;
  /** Per candidate: countryKey of its country (spellings unified), for the hot path. */
  countryKeys: string[];
}

/**
 * The country the owner is in on the night before `start`, and the day that entry began:
 * prior presence that runs up to the horizon, followed back through earlier contiguous
 * presence in the same country. Null when the owner was nowhere known that night.
 */
export function priorEntryAt(prior: SolveInput["prior"], start: number): { country: string; start: number } | null {
  const ranges = prior.map((p) => ({ country: p.country, a: dayNum(p.start), b: Math.min(dayNum(p.end), start) })).filter((r) => r.b > r.a && r.country);
  const last = ranges.find((r) => r.b === start);
  if (!last) return null;
  let from = last.a;
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of ranges) {
      if (sameCountry(r.country, last.country) && r.a < from && r.b >= from) {
        from = r.a;
        grew = true;
      }
    }
  }
  return { country: last.country, start: from };
}

function nodeOf(c: Candidate): TripNode {
  return { cityId: c.place.cityId, name: c.place.name, iata: c.place.iata, lat: c.place.lat, lng: c.place.lng };
}

function leg(P: Prepared, a: number, b: number): Leg {
  const key = a * 4096 + b;
  const hit = P.legCache.get(key);
  if (hit) return hit;
  const l = buildLeg(0, nodeOf(P.cands[a]), nodeOf(P.cands[b]), P.hubs, undefined, P.landmassOf);
  const v: Leg = {
    km: l.km,
    hours: r1(l.hours),
    costUsd: l.cost,
    mode: l.mode,
    via: l.via,
    method: l.method,
    points: MOVE_BASE + MOVE_PER_HOUR * l.hours + MOVE_PER_USD * l.cost,
  };
  P.legCache.set(key, v);
  return v;
}

/** Friction points per move, scaled to a year of the horizon. */
const frictionFactor = (P: Prepared) => (FRICTION_SCALE * 12) / P.horizonMonths;

function riskPoints(c: Candidate, slot: Slot, start: number): { points: number; items: string[] } {
  let pts = 0;
  const items: string[] = [];
  const age = slot.start - start;
  const fade = age < 90 ? 1 : age < 180 ? 0.5 : 0;
  for (const r of c.risks) {
    if (r.months && !r.months.includes(slot.month)) continue;
    const f = r.current ? fade : 1;
    if (!f) continue;
    const p = RISK_POINTS[r.kind] * r.severity * f;
    pts += p;
    items.push(r.label);
  }
  if (c.penalty) {
    pts += c.penalty.points;
    items.push(c.penalty.reason);
  }
  return { points: Math.min(100, pts), items };
}

function costPoints(c: Candidate, budget: number): number {
  if (!c.costMonthlyEur) return COST_UNKNOWN_POINTS;
  const v = c.costMonthlyEur.value;
  if (v <= budget) return 100;
  return clamp(100 * (1 - (v - budget) / ((COST_ZERO_AT - 1) * budget)));
}

/** Static hard checks of one candidate in one slot; returns the reason it is not allowed. */
function staticBlock(P: Prepared, ci: number, slot: Slot, fixed: boolean): string | null {
  const c = P.cands[ci];
  if (fixed) return null;
  const k = P.input.constraints;
  if (c.excluded) return c.excluded;
  if (k.minInternetMbps !== null && c.internetMbps && c.internetMbps.value < k.minInternetMbps) return `${c.place.name}: internet ${c.internetMbps.value} Mbps, under your floor of ${k.minInternetMbps}`;
  if (k.minHealthUhc !== null && c.healthUhc && c.healthUhc.value < k.minHealthUhc) return `${c.place.name}: healthcare index ${c.healthUhc.value}, under your floor of ${k.minHealthUhc}`;
  if (k.avoidIsHard && c.months[slot.month - 1]?.level === "avoid" && c.months[slot.month - 1]?.source === "personal") return `${c.place.name}: you avoid it in ${slot.ym}`;
  return null;
}

function prepare(input: SolveInput, env: SolverEnv): Prepared | { error: string } {
  const months = Math.max(12, Math.min(18, Math.round(input.months)));
  const endIso = addMonthsToDate(input.start, months);
  const cands: Candidate[] = [
    ...input.candidates,
    {
      place: input.from,
      kind: "pass-through",
      minNights: 1,
      maxNights: 1,
      months: Array.from({ length: 12 }, () => ({ level: "unknown" as const, source: "none" as const, why: "" })),
      costMonthlyEur: null,
      internetMbps: null,
      healthUhc: null,
      coastKm: null,
      risks: [],
      inPool: false,
    },
  ];
  const fromIdx = cands.length - 1;
  const byCity = new Map<string, number>();
  input.candidates.forEach((c, i) => byCity.set(c.place.cityId, i));

  // Fixed stays: clipped to the horizon, sorted, and never overlapping.
  const fixed = input.fixed
    .filter((f) => f.end > input.start && f.start < endIso)
    .map((f) => ({ ...f, start: f.start < input.start ? input.start : f.start, end: f.end > endIso ? endIso : f.end }))
    .sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i].start < fixed[i - 1].end) return { error: `Two fixed stays overlap (${fixed[i - 1].id} and ${fixed[i].id}); fix them before solving.` };
  }
  const fixedCand: number[] = [];
  for (const f of fixed) {
    const ci = byCity.get(f.cityId);
    if (ci === undefined) return { error: `Fixed stay ${f.id} names a place the solver has no data for.` };
    fixedCand.push(ci);
  }
  const slots = buildSlots(input.start, endIso, fixed);
  const start = dayNum(input.start);
  const end = dayNum(endIso);
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const P: Prepared = {
    input: { ...input, months, fixed },
    cands,
    fromIdx,
    byCity,
    slots,
    start,
    end,
    totalNights: end - start,
    horizonMonths: months,
    weights,
    weightSum: 0,
    allowed: [],
    gain: [],
    prefNights: [],
    prefWeightSum: 0,
    ruleOf: new Int32Array(cands.length).fill(-1),
    pool: [],
    passThroughs: [],
    borderTargets: [],
    fixedCand,
    legCache: new Map(),
    hubs: env.hubs ?? [],
    landmassOf: (id: string) => cands[byCity.get(id) ?? -1]?.landmass,
    priorEntry: priorEntryAt(input.prior, start),
    countryKeys: cands.map((c) => countryKey(c.place.country)),
  };
  input.candidates.forEach((c, i) => {
    if (!c.inPool || c.excluded) return;
    if (c.kind === "base") P.pool.push(i);
    else P.passThroughs.push(i);
  });
  cands.forEach((c, i) => {
    P.ruleOf[i] = input.constraints.countryRules.findIndex((r) => sameCountry(r.country, c.place.country));
  });
  // Month-scoped preferences: where they apply over the horizon.
  P.prefNights = input.preferences.map((p) => slots.reduce((a, s) => a + (applies(p, s.month) ? s.nights : 0), 0));
  P.prefWeightSum = input.preferences.reduce((a, p, i) => a + (p.kind === "long-haul" || P.prefNights[i] > 0 ? Math.max(0, p.weight) : 0), 0);
  const prefsActive = P.prefWeightSum > 0;
  const W = { ...weights, preferences: prefsActive ? weights.preferences : 0 };
  P.weights = W;
  P.weightSum = Object.values(W).reduce((a, b) => a + Math.max(0, b), 0) || 1;

  const budget = Math.max(1, input.budgetMonthlyEur);
  for (const slot of slots) {
    const allowed = new Uint8Array(cands.length);
    const gain = new Float64Array(cands.length);
    const share = slot.nights / P.totalNights;
    for (let ci = 0; ci < input.candidates.length; ci++) {
      const c = cands[ci];
      const isFixed = slot.fixed !== -1 && fixedCand[slot.fixed] === ci;
      allowed[ci] = staticBlock(P, ci, slot, isFixed) === null ? 1 : 0;
      const fit = FIT_POINTS[c.months[slot.month - 1]?.level ?? "unknown"];
      const risk = 100 - riskPoints(c, slot, start).points;
      let pref = 0;
      input.preferences.forEach((p, pi) => {
        if (p.kind === "long-haul" || !P.prefNights[pi]) return;
        if (meets(p, c, slot.month)) pref += (Math.max(0, p.weight) / P.prefWeightSum) * 100 * (slot.nights / P.prefNights[pi]);
      });
      gain[ci] = (W.fit * fit + W.cost * costPoints(c, budget) + W.risk * risk) * share + W.preferences * pref;
    }
    P.allowed.push(allowed);
    P.gain.push(gain);
  }
  // Border-run targets: the nearest pool or pass-through places in another country, outside Schengen.
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    const others = [...P.pool, ...P.passThroughs]
      .filter((j) => cands[j].place.country && !sameCountry(cands[j].place.country, c.place.country) && !inSchengen(cands[j].place.country) && P.ruleOf[j] === -1)
      .sort((a, b) => haversineKm([c.place.lng, c.place.lat], [cands[a].place.lng, cands[a].place.lat]) - haversineKm([c.place.lng, c.place.lat], [cands[b].place.lng, cands[b].place.lat]) || a - b);
    P.borderTargets.push(others.slice(0, 3));
  }
  return P;
}

// ── Beam search ─────────────────────────────────────────────────────────

interface Node {
  parent: Node | null;
  c: number;
  slot: number;
  runStart: number;
  runNights: number;
  /** Day the current entry into this country began (per-entry limits). */
  entryStart: number;
  /** Border-run target taken at the start of this slot, or -1. */
  border: number;
  obj: number;
  /** Visa margin score so far (min over checks). */
  vScore: number;
  /** Additive points so far (without the visa term). */
  add: number;
  sch: Ranges;
  rules: Ranges[];
  tax: Map<string, number>;
  lhQ: number;
  lhN: number;
  h: number;
}

function schengenScore(used: number): number {
  const spare = SCHENGEN_RULE.days - used;
  return clamp((100 * spare) / SCHENGEN_COMFORT_DAYS);
}

function taxScore(days: number, threshold: number | null): number {
  if (threshold === null) return 100;
  const spare = threshold - days;
  if (spare <= 0) return 0;
  return clamp((100 * spare) / TAX_COMFORT_DAYS);
}

function initialNode(P: Prepared): Node {
  let sch: Ranges = [];
  const rules: Ranges[] = P.input.constraints.countryRules.map(() => []);
  const tax = new Map<string, number>();
  const look = P.start - SCHENGEN_RULE.windowDays * 2;
  for (const p of P.input.prior) {
    const a = dayNum(p.start);
    const b = Math.min(dayNum(p.end), P.start);
    if (b <= a) continue;
    if (P.input.constraints.schengen && inSchengen(p.country) && b >= look) sch = addRange(sch, a, b);
    const ri = P.input.constraints.countryRules.findIndex((r) => sameCountry(r.country, p.country));
    if (ri !== -1) rules[ri] = addRange(rules[ri], a, b);
    for (const [y, n] of nightsByYear(a, b)) tax.set(`${p.country}|${y}`, (tax.get(`${p.country}|${y}`) ?? 0) + n);
  }
  // An entry already under way when the horizon starts counts its earlier days.
  return { parent: null, c: P.fromIdx, slot: -1, runStart: 0, runNights: 0, entryStart: P.priorEntry?.start ?? P.start, border: -1, obj: 0, vScore: 100, add: 0, sch, rules, tax, lhQ: -1, lhN: 0, h: P.input.seed >>> 0 };
}

const quarterOf = (d: number) => {
  const iso = dayIso(d);
  return Number(iso.slice(0, 4)) * 4 + Math.floor((Number(iso.slice(5, 7)) - 1) / 3);
};

interface Expansion {
  parent: Node;
  c: number;
  border: number;
  obj: number;
  tie: number;
}

/** Does placing `cand` after `n` continue the same entry into its country (prior presence included)? */
function continuesEntry(P: Prepared, n: Node, ci: number): boolean {
  const k = P.countryKeys[ci];
  if (k === "") return false;
  if (n.slot < 0) return P.priorEntry !== null && countryKey(P.priorEntry.country) === k;
  return n.c !== P.fromIdx && P.countryKeys[n.c] === k;
}

/** Can `n` close its current run now (moving elsewhere at slot `si`)? */
function canClose(P: Prepared, n: Node, si: number): boolean {
  if (n.slot < 0 || n.c === P.fromIdx) return true;
  const runSlot = P.slots[n.runStart];
  if (runSlot.fixed !== -1) return true;
  if (n.runNights >= P.cands[n.c].minNights) return true;
  // Squeezed: the run fills its whole free gap, and the gap ends here.
  const prev = P.slots[si - 1];
  return runSlot.start === runSlot.gapStart && prev.end === prev.gapEnd;
}

function expand(P: Prepared, n: Node, si: number, penalty: Float64Array[] | null, out: Expansion[], visaW: number, prefW: number): void {
  const slot = P.slots[si];
  const k = P.input.constraints;
  const tryPlace = (c: number, cont: boolean) => {
    if (!P.allowed[si][c]) return;
    const cand = P.cands[c];
    if (!cont && slot.fixed === -1 && slot.nights > cand.maxNights) return;
    let border = -1;
    // Per-entry and windowed country rules.
    const ri = P.ruleOf[c];
    const sameCountry = continuesEntry(P, n, c);
    const entryStart = sameCountry ? n.entryStart : slot.start;
    if (ri !== -1) {
      const rule = k.countryRules[ri];
      if (rule.maxDaysPerEntry && slot.end - entryStart + 1 > rule.maxDaysPerEntry) {
        const t = P.borderTargets[c].find((j) => P.allowed[si][j]);
        const fixedHere = slot.fixed !== -1;
        if (!cont || !sameCountry || !k.allowBorderRuns || t === undefined || fixedHere) return;
        if (slot.start - entryStart + 1 > rule.maxDaysPerEntry) return;
        if (slot.nights - BORDER_RUN_NIGHTS + 1 > rule.maxDaysPerEntry || slot.nights <= BORDER_RUN_NIGHTS) return;
        border = t;
      }
      if (rule.maxDaysIn) {
        const r = addRange(n.rules[ri], slot.start, slot.end);
        if (usedOn(r, slot.end, rule.maxDaysIn.windowDays) > rule.maxDaysIn.days) return;
      }
    }
    let v = n.vScore;
    if (k.schengen && inSchengen(cand.place.country)) {
      const r = addRange(n.sch, slot.start, slot.end);
      const used = usedOn(r, slot.end, SCHENGEN_RULE.windowDays);
      if (used > SCHENGEN_RULE.days) return;
      v = Math.min(v, schengenScore(used));
    }
    if (k.taxDays !== null && cand.place.country) {
      const key = `${cand.place.country}|${slot.year}`;
      v = Math.min(v, taxScore((n.tax.get(key) ?? 0) + slot.nights, k.taxDays));
    }
    let add = n.add + P.gain[si][c];
    if (!cont && P.cands[n.c].place.cityId !== cand.place.cityId) {
      const l = leg(P, n.c, c);
      add -= P.weights.friction * l.points * frictionFactor(P);
      add -= longHaulCost(P, n, slot.start, l.hours, prefW);
    }
    if (border !== -1) {
      const out1 = leg(P, c, border);
      const back = leg(P, border, c);
      add -= P.weights.friction * (out1.points + back.points) * frictionFactor(P);
    }
    let obj = add + visaW * v;
    if (penalty) obj -= penalty[si][c];
    out.push({ parent: n, c, border, obj, tie: mix(n.h, c + 1) });
  };
  if (slot.fixed !== -1) {
    const fc = P.fixedCand[slot.fixed];
    const cont = n.slot >= 0 && P.slots[n.slot].fixed === slot.fixed;
    if (!cont && !canClose(P, n, si)) return;
    tryPlace(fc, cont);
    return;
  }
  const inFixedRun = n.slot >= 0 && P.slots[n.slot].fixed !== -1;
  // Stay where it is.
  if (n.slot >= 0 && !inFixedRun && n.c !== P.fromIdx && n.runNights + slot.nights <= P.cands[n.c].maxNights) tryPlace(n.c, true);
  // Move.
  if (!canClose(P, n, si)) return;
  for (const c of P.pool) if (c !== n.c || inFixedRun) tryPlace(c, false);
}

function longHaulCost(P: Prepared, n: Node, day: number, hours: number, prefW: number): number {
  let cost = 0;
  const q = quarterOf(day);
  for (const p of P.input.preferences) {
    if (p.kind !== "long-haul" || p.weight <= 0) continue;
    if (hours < p.minHours) continue;
    const count = (n.lhQ === q ? n.lhN : 0) + 1;
    if (count > p.maxPerQuarter) cost += prefW * (p.weight / P.prefWeightSum) * (100 / (2 * Math.max(1, P.horizonMonths / 3)));
  }
  return cost;
}

function materialize(P: Prepared, e: Expansion, si: number): Node {
  const n = e.parent;
  const slot = P.slots[si];
  const cand = P.cands[e.c];
  const k = P.input.constraints;
  const cont = e.c === n.c && n.slot >= 0 && (P.slots[si].fixed === -1 ? P.slots[n.slot].fixed === -1 : P.slots[n.slot].fixed === slot.fixed);
  let sch = n.sch;
  if (k.schengen && inSchengen(cand.place.country)) sch = addRange(sch, slot.start, slot.end);
  let rules = n.rules;
  const ri = P.ruleOf[e.c];
  if (ri !== -1) {
    rules = rules.slice();
    rules[ri] = addRange(rules[ri], slot.start, slot.end);
  }
  const tax = new Map(n.tax);
  if (cand.place.country) {
    const key = `${cand.place.country}|${slot.year}`;
    tax.set(key, (tax.get(key) ?? 0) + slot.nights);
  }
  const sameCountry = continuesEntry(P, n, e.c);
  let entryStart = sameCountry ? n.entryStart : slot.start;
  if (e.border !== -1) entryStart = slot.start + BORDER_RUN_NIGHTS;
  let lhQ = n.lhQ;
  let lhN = n.lhN;
  if (!cont && P.cands[n.c].place.cityId !== cand.place.cityId) {
    const l = leg(P, n.c, e.c);
    const q = quarterOf(slot.start);
    if (l.hours >= LONG_HAUL_HOURS || P.input.preferences.some((p) => p.kind === "long-haul" && l.hours >= p.minHours)) {
      lhN = lhQ === q ? lhN + 1 : 1;
      lhQ = q;
    }
  }
  let v = n.vScore;
  if (k.schengen && inSchengen(cand.place.country)) v = Math.min(v, schengenScore(usedOn(sch, slot.end, SCHENGEN_RULE.windowDays)));
  if (k.taxDays !== null && cand.place.country) v = Math.min(v, taxScore(tax.get(`${cand.place.country}|${slot.year}`) ?? 0, k.taxDays));
  const visaW = P.weights.visa;
  return {
    parent: n,
    c: e.c,
    slot: si,
    runStart: cont ? n.runStart : si,
    runNights: cont ? n.runNights + slot.nights : slot.nights,
    entryStart,
    border: e.border,
    obj: e.obj,
    vScore: v,
    add: e.obj - visaW * v,
    sch,
    rules,
    tax,
    lhQ,
    lhN,
    h: e.tie,
  };
}

function beam(P: Prepared, width: number, penalty: Float64Array[] | null, stats: { expanded: number }): Node[] {
  let layer: Node[] = [initialNode(P)];
  const visaW = P.weights.visa;
  const prefW = P.weights.preferences;
  for (let si = 0; si < P.slots.length; si++) {
    const out: Expansion[] = [];
    for (const n of layer) expand(P, n, si, penalty, out, visaW, prefW);
    stats.expanded += out.length;
    if (!out.length) return [];
    out.sort((a, b) => b.obj - a.obj || a.tie - b.tie || a.c - b.c);
    // Penalty-free obj is restored on materialize only when penalty is null; with a penalty
    // the obj guides the search and the plan is re-scored by evaluatePlan afterwards.
    layer = out.slice(0, width).map((e) => materialize(P, e, si));
  }
  return layer;
}

// ── From a search node to a plan ───────────────────────────────────────

function nodeSlots(n: Node): Node[] {
  const out: Node[] = [];
  for (let x: Node | null = n; x && x.slot >= 0; x = x.parent) out.push(x);
  return out.reverse();
}

function assignment(P: Prepared, n: Node): Int32Array {
  const a = new Int32Array(P.slots.length);
  for (const x of nodeSlots(n)) a[x.slot] = x.c;
  return a;
}

let idCounter = 0;
function planFromNode(P: Prepared, n: Node, tag: string): PlanInput {
  const stays: PlanInput["stays"] = [];
  const chain = nodeSlots(n);
  idCounter = 0;
  const nextId = () => `${tag}-${++idCounter}`;
  for (const x of chain) {
    const slot = P.slots[x.slot];
    const cand = P.cands[x.c];
    const last = stays[stays.length - 1];
    const fixedId = slot.fixed !== -1 ? P.input.fixed[slot.fixed].id : null;
    const sameRun = last && last.cityId === cand.place.cityId && (fixedId ? last.id === fixedId : last.role !== "fixed") && last.end === dayIso(slot.start);
    if (x.border !== -1 && sameRun) {
      const t = P.cands[x.border];
      const ruleCountry = cand.place.country;
      const rule = P.input.constraints.countryRules.find((r) => sameCountry(r.country, ruleCountry));
      last.end = dayIso(slot.start);
      stays.push({
        id: nextId(),
        cityId: t.place.cityId,
        start: dayIso(slot.start),
        end: dayIso(slot.start + BORDER_RUN_NIGHTS),
        kind: "pass-through",
        role: "border-run",
        notes: [`Border run: ${rule?.maxDaysPerEntry ?? "?"} days per entry in ${ruleCountry}, so you leave for ${BORDER_RUN_NIGHTS} nights and come back to restart the count.${rule?.note ? ` (${rule.note})` : ""}`],
      });
      stays.push({ id: nextId(), cityId: cand.place.cityId, start: dayIso(slot.start + BORDER_RUN_NIGHTS), end: dayIso(slot.end), kind: cand.kind, role: "base", notes: [] });
      continue;
    }
    if (sameRun) {
      last.end = dayIso(slot.end);
      continue;
    }
    if (fixedId) {
      const f = P.input.fixed[slot.fixed];
      stays.push({ id: f.id, cityId: cand.place.cityId, start: dayIso(slot.start), end: dayIso(slot.end), kind: f.kind, role: "fixed", notes: [f.why] });
    } else {
      stays.push({ id: nextId(), cityId: cand.place.cityId, start: dayIso(slot.start), end: dayIso(slot.end), kind: cand.kind, role: cand.kind === "pass-through" ? "pass-through" : "base", notes: [] });
    }
  }
  return { stays };
}

/** Insert a pool pass-through as a hub on long moves, when it lies on the way. */
function withHubs(P: Prepared, plan: PlanInput): PlanInput {
  if (!P.passThroughs.length) return plan;
  let cur = plan;
  for (let i = 0; i + 1 < cur.stays.length; i++) {
    const a = cur.stays[i];
    const b = cur.stays[i + 1];
    if (a.role === "border-run" || b.role === "border-run" || a.cityId === b.cityId) continue;
    const ai = P.byCity.get(a.cityId)!;
    const bi = P.byCity.get(b.cityId)!;
    const direct = leg(P, ai, bi);
    if (direct.mode !== "flight" || direct.hours < HUB_MIN_HOURS) continue;
    const A = P.cands[ai].place;
    const B = P.cands[bi].place;
    const d = haversineKm([A.lng, A.lat], [B.lng, B.lat]);
    const options = P.passThroughs
      .filter((p) => p !== ai && p !== bi)
      .map((p) => {
        const H = P.cands[p].place;
        const via = haversineKm([A.lng, A.lat], [H.lng, H.lat]) + haversineKm([H.lng, H.lat], [B.lng, B.lat]);
        return { p, ratio: via / d };
      })
      .filter((o) => o.ratio <= HUB_MAX_DETOUR)
      .sort((x, y) => x.ratio - y.ratio || x.p - y.p);
    for (const { p } of options) {
      const hub = P.cands[p];
      const n = Math.max(2, Math.min(hub.minNights, hub.maxNights));
      const nightsOf = (s: PlanInput["stays"][number]) => dayNum(s.end) - dayNum(s.start);
      const bCand = P.cands[bi];
      const aCand = P.cands[ai];
      let next: PlanInput["stays"] | null = null;
      const l1 = leg(P, ai, p);
      const l2 = leg(P, p, bi);
      const note = `Hub on the way: splits the ${direct.hours} h move from ${A.name} to ${B.name} into ${l1.hours} h and ${l2.hours} h.`;
      const hubStay = (s: string, e: string) => ({ id: `${a.id}-hub`, cityId: hub.place.cityId, start: s, end: e, kind: "pass-through" as const, role: "pass-through" as StayRole, notes: [note] });
      const isLast = i + 1 === cur.stays.length - 1;
      if (b.role !== "fixed" && (nightsOf(b) - n >= bCand.minNights || isLast) && nightsOf(b) - n >= 1) {
        const hs = hubStay(b.start, addDays(b.start, n));
        next = [...cur.stays.slice(0, i + 1), hs, { ...b, start: hs.end }, ...cur.stays.slice(i + 2)];
      } else if (a.role !== "fixed" && nightsOf(a) - n >= aCand.minNights) {
        const hs = hubStay(addDays(a.end, -n), a.end);
        next = [...cur.stays.slice(0, i), { ...a, end: hs.start }, hs, ...cur.stays.slice(i + 1)];
      }
      if (!next) continue;
      const trial = { stays: next };
      if (violations(P, trial).length === 0) {
        cur = trial;
        i++;
        break;
      }
    }
  }
  return cur;
}

// ── Evaluation: the single source of truth ─────────────────────────────

function stayNightsOf(s: { start: string; end: string }) {
  return dayNum(s.end) - dayNum(s.start);
}

/** Hard-constraint violations of a plan, in words. Empty = legal. */
function violations(P: Prepared, plan: PlanInput): string[] {
  const out: string[] = [];
  const k = P.input.constraints;
  const stays = [...plan.stays].sort((a, b) => a.start.localeCompare(b.start));
  if (!stays.length) return ["The plan has no stays."];
  if (dayNum(stays[0].start) !== P.start) out.push(`The plan starts ${stays[0].start}, not ${dayIso(P.start)}.`);
  if (dayNum(stays[stays.length - 1].end) !== P.end) out.push(`The plan ends ${stays[stays.length - 1].end}, not ${dayIso(P.end)}.`);
  for (let i = 0; i < stays.length; i++) {
    const s = stays[i];
    if (stayNightsOf(s) < 1) out.push(`${s.id} has no nights.`);
    if (i > 0 && stays[i - 1].end !== s.start) out.push(stays[i - 1].end < s.start ? `Gap between ${stays[i - 1].end} and ${s.start}.` : `Overlap from ${s.start} to ${stays[i - 1].end}.`);
  }
  for (const f of P.input.fixed) {
    const hit = stays.find((s) => s.id === f.id);
    if (!hit || hit.cityId !== f.cityId || hit.start !== f.start || hit.end !== f.end) out.push(`Fixed stay ${f.id} (${f.cityId}, ${f.start} to ${f.end}) was moved or dropped.`);
  }
  const fixedStarts = new Set(P.input.fixed.map((f) => f.start));
  const fixedEnds = new Set(P.input.fixed.map((f) => f.end));
  let sch: Ranges = [];
  const rules: Ranges[] = k.countryRules.map(() => []);
  const init = initialNode(P);
  sch = init.sch;
  init.rules.forEach((r, i) => (rules[i] = r));
  const entries: { country: string; start: number; end: number }[] = [];
  for (let i = 0; i < stays.length; i++) {
    const s = stays[i];
    const ci = P.byCity.get(s.cityId);
    if (ci === undefined) {
      out.push(`${s.cityId} is not a known candidate.`);
      continue;
    }
    const c = P.cands[ci];
    const isFixed = s.role === "fixed";
    if (!isFixed) {
      if (!c.inPool) out.push(`${c.place.name} is not in the pool.`);
      if (c.excluded) out.push(c.excluded);
      const n = stayNightsOf(s);
      if (s.role !== "border-run") {
        if (n > c.maxNights) out.push(`${c.place.name} is ${n} nights, over its maximum of ${c.maxNights}.`);
        const squeezed = (i === 0 || fixedEnds.has(s.start) || stays[i - 1].role === "border-run" || stays[i - 1].role === "pass-through") && (i === stays.length - 1 || fixedStarts.has(s.end) || stays[i + 1].role === "border-run" || stays[i + 1].role === "pass-through");
        const lastOne = i === stays.length - 1;
        const splitByBorderRun = (i > 0 && stays[i - 1].role === "border-run") || (i + 1 < stays.length && stays[i + 1].role === "border-run");
        if (n < c.minNights && !lastOne && !squeezed && !splitByBorderRun) out.push(`${c.place.name} is ${n} nights, under its minimum of ${c.minNights}.`);
      }
      for (const { month: ym } of nightsByMonth(s.start, s.end)) {
        const why = staticBlock(P, ci, { month: Number(ym.slice(5, 7)), ym } as Slot, false);
        if (why && !c.excluded) {
          out.push(why);
          break;
        }
      }
    }
    const a = dayNum(s.start);
    const b = dayNum(s.end);
    if (k.schengen && inSchengen(c.place.country)) sch = addRange(sch, a, b);
    const ri = P.ruleOf[ci];
    if (ri !== -1) rules[ri] = addRange(rules[ri], a, b);
    const last = entries[entries.length - 1];
    if (last && sameCountry(last.country, c.place.country) && last.end === a) last.end = b;
    // The first stay continues an entry that began before the horizon.
    else if (!last && a === P.start && P.priorEntry && sameCountry(P.priorEntry.country, c.place.country)) entries.push({ country: c.place.country ?? "", start: P.priorEntry.start, end: b });
    else entries.push({ country: c.place.country ?? "", start: a, end: b });
  }
  if (k.schengen) {
    const peak = peakUse(sch, SCHENGEN_RULE.windowDays, P.start, P.end);
    if (peak.used > SCHENGEN_RULE.days && peak.day !== null && peak.day >= P.start) out.push(`Schengen: ${peak.used} days in the 180 to ${dayIso(peak.day)}, over 90.`);
  }
  k.countryRules.forEach((rule, ri) => {
    if (rule.maxDaysIn) {
      const peak = peakUse(rules[ri], rule.maxDaysIn.windowDays, P.start, P.end);
      if (peak.used > rule.maxDaysIn.days && peak.day !== null && peak.day >= P.start) out.push(`${rule.country}: ${peak.used} days in ${rule.maxDaysIn.windowDays}, over ${rule.maxDaysIn.days}.`);
    }
    if (rule.maxDaysPerEntry) {
      for (const e of entries) {
        if (!sameCountry(e.country, rule.country)) continue;
        const days = e.end - e.start + 1;
        if (days > rule.maxDaysPerEntry) out.push(`${rule.country}: one entry of ${days} days from ${dayIso(e.start)}, over ${rule.maxDaysPerEntry}.`);
      }
    }
  });
  return out;
}

function evaluate(P: Prepared, plan: PlanInput, id: string): ProposedRotation {
  const W = P.weights;
  const budget = Math.max(1, P.input.budgetMonthlyEur);
  const stays = [...plan.stays].sort((a, b) => a.start.localeCompare(b.start));
  const viol = violations(P, plan);
  const k = P.input.constraints;

  // Per-night accumulation over months.
  let fitSum = 0;
  let costScoreSum = 0;
  let riskScoreSum = 0;
  let nightsTotal = 0;
  let costKnownNights = 0;
  let costEurNights = 0;
  let overBudgetMonths = 0;
  const unknownFit = new Set<string>();
  const unknownCost = new Set<string>();
  const riskItems = new Map<string, number>();
  const prefMet = P.input.preferences.map(() => 0);
  const prefUnknown = P.input.preferences.map(() => new Set<string>());
  const monthMap = new Map<string, Map<string, number>>();
  const planned: PlannedStay[] = [];
  const floors = [
    { label: k.minInternetMbps !== null ? `Internet at least ${k.minInternetMbps} Mbps` : "Internet (no floor set)", met: 0, unknown: [] as string[] },
    { label: k.minHealthUhc !== null ? `Healthcare index at least ${k.minHealthUhc}` : "Healthcare (no floor set)", met: 0, unknown: [] as string[] },
  ];

  for (const s of stays) {
    const ci = P.byCity.get(s.cityId);
    if (ci === undefined) continue;
    const c = P.cands[ci];
    const months: PlannedStay["months"] = [];
    for (const { month: ym, nights: n } of nightsByMonth(s.start, s.end)) {
      const m = Number(ym.slice(5, 7));
      const d = Math.max(dayNum(s.start), dayNum(`${ym}-01`));
      const read = c.months[m - 1] ?? { level: "unknown" as const, why: "No comfort data", source: "none" as const };
      months.push({ ym, nights: n, level: read.level, why: read.why });
      fitSum += FIT_POINTS[read.level] * n;
      if (read.level === "unknown") unknownFit.add(c.place.name);
      costScoreSum += costPoints(c, budget) * n;
      if (c.costMonthlyEur) {
        costKnownNights += n;
        costEurNights += c.costMonthlyEur.value * n;
      } else unknownCost.add(c.place.name);
      const slotLike = { start: d, month: m } as Slot;
      const risk = riskPoints(c, slotLike, P.start);
      riskScoreSum += (100 - risk.points) * n;
      for (const it of risk.items) riskItems.set(`${c.place.name}: ${it}`, (riskItems.get(`${c.place.name}: ${it}`) ?? 0) + n);
      P.input.preferences.forEach((p, pi) => {
        const r = meets(p, c, m);
        if (r) prefMet[pi] += n;
        if (r === null && p.kind === "coast" && !c.coastKm && applies(p, m)) prefUnknown[pi].add(c.place.name);
      });
      const mm = monthMap.get(ym) ?? new Map<string, number>();
      mm.set(c.place.cityId, (mm.get(c.place.cityId) ?? 0) + n);
      monthMap.set(ym, mm);
      nightsTotal += n;
    }
    if (k.minInternetMbps !== null) {
      if (c.internetMbps) floors[0].met++;
      else floors[0].unknown.push(c.place.name);
    }
    if (k.minHealthUhc !== null) {
      if (c.healthUhc) floors[1].met++;
      else floors[1].unknown.push(c.place.name);
    }
    planned.push({
      id: s.id,
      cityId: c.place.cityId,
      name: c.place.name,
      country: c.place.country,
      start: s.start,
      end: s.end,
      nights: stayNightsOf(s),
      kind: s.kind,
      role: s.role,
      notes: [...(s.notes ?? [])],
      months,
      costMonthlyEur: c.costMonthlyEur?.value ?? null,
      costSource: c.costMonthlyEur?.source ?? null,
      alternatives: [],
    });
  }
  const N = Math.max(1, nightsTotal);

  // Months table and months over budget.
  const monthsTable: MonthRow[] = [...monthMap.entries()].map(([ym, mm]) => {
    const [cityId] = [...mm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const c = P.cands[P.byCity.get(cityId)!];
    const read = c.months[Number(ym.slice(5, 7)) - 1];
    const cost = c.costMonthlyEur?.value ?? null;
    if (cost !== null && cost > budget) overBudgetMonths++;
    return { ym, cityId, name: c.place.name, level: read?.level ?? "unknown", why: read?.why ?? "", costEur: cost };
  });

  // Moves.
  const moves: PlannedMove[] = [];
  let movePoints = 0;
  let prev = P.fromIdx;
  const prefLh = P.input.preferences.filter((p) => p.kind === "long-haul");
  const lhExcess = prefLh.map(() => 0);
  const lhCounts = prefLh.map(() => new Map<number, number>());
  for (const s of stays) {
    const ci = P.byCity.get(s.cityId);
    if (ci === undefined) continue;
    if (P.cands[ci].place.cityId !== P.cands[prev].place.cityId) {
      const l = leg(P, prev, ci);
      const longHaul = l.mode === "flight" && l.hours >= LONG_HAUL_HOURS;
      moves.push({ fromCityId: P.cands[prev].place.cityId, toCityId: P.cands[ci].place.cityId, date: s.start, km: l.km, hours: l.hours, costUsd: l.costUsd, mode: l.mode, via: l.via, longHaul, method: l.method });
      movePoints += l.points;
      const q = quarterOf(dayNum(s.start));
      prefLh.forEach((p, i) => {
        if (p.kind !== "long-haul" || l.mode !== "flight" || l.hours < p.minHours) return;
        const n = (lhCounts[i].get(q) ?? 0) + 1;
        lhCounts[i].set(q, n);
        if (n > p.maxPerQuarter) lhExcess[i]++;
      });
    }
    prev = ci;
  }

  // Visa: Schengen, per-country rules and tax days.
  const init = initialNode(P);
  let sch = init.sch;
  const rules = init.rules.slice();
  const tax = new Map(init.tax);
  for (const s of stays) {
    const ci = P.byCity.get(s.cityId);
    if (ci === undefined) continue;
    const c = P.cands[ci];
    const a = dayNum(s.start);
    const b = dayNum(s.end);
    if (k.schengen && inSchengen(c.place.country)) sch = addRange(sch, a, b);
    if (P.ruleOf[ci] !== -1) rules[P.ruleOf[ci]] = addRange(rules[P.ruleOf[ci]], a, b);
    if (c.place.country) for (const [y, n] of nightsByYear(a, b)) tax.set(`${c.place.country}|${y}`, (tax.get(`${c.place.country}|${y}`) ?? 0) + n);
  }
  const visa: VisaReport = { schengen: { enabled: k.schengen, maxUsed: 0, marginDays: null, peakOn: null }, taxDays: [], countryRules: [], notes: [] };
  let visaScore = 100;
  const visaNotes: string[] = [];
  if (k.schengen) {
    const peak = peakUse(sch, SCHENGEN_RULE.windowDays, P.start, P.end);
    visa.schengen = { enabled: true, maxUsed: peak.used, marginDays: SCHENGEN_RULE.days - peak.used, peakOn: peak.day !== null ? dayIso(peak.day) : null };
    if (peak.used > 0) {
      visaScore = Math.min(visaScore, schengenScore(peak.used));
      visaNotes.push(`Schengen: at most ${peak.used} of 90 days in any 180${peak.day !== null ? ` (on ${dayIso(peak.day)})` : ""}.`);
    }
    visa.notes.push(SCHENGEN_SOURCE);
    visa.notes.push(SCHENGEN_PRIOR_NOTE);
    // Buffers: a stay outside Schengen where a Schengen place would have broken 90/180.
    for (const ps of planned) {
      if (inSchengen(ps.country) || ps.role === "fixed") continue;
      const a = dayNum(ps.start);
      const usedBefore = usedOn(sch, a, SCHENGEN_RULE.windowDays);
      const blocked = P.pool.some((j) => inSchengen(P.cands[j].place.country)) && usedOn(addRange(sch, a, dayNum(ps.end)), dayNum(ps.end), SCHENGEN_RULE.windowDays) > SCHENGEN_RULE.days;
      // Only right after a Schengen stay: that is where leaving the area is the point.
      const prevStay = planned[planned.indexOf(ps) - 1];
      const hadSchengenBefore = !!prevStay && inSchengen(prevStay.country);
      if (blocked && hadSchengenBefore && usedBefore >= SCHENGEN_RULE.days - SCHENGEN_COMFORT_DAYS * 2) {
        ps.notes.push(`Schengen buffer: by ${ps.start} you'd have used ${usedBefore} of 90 days, so this stay is outside the area and lets the count fall.`);
      }
    }
  }
  k.countryRules.forEach((rule, ri) => {
    if (rule.maxDaysIn) {
      const peak = peakUse(rules[ri], rule.maxDaysIn.windowDays, P.start, P.end);
      visa.countryRules.push({ country: rule.country, maxUsed: peak.used, limit: `${rule.maxDaysIn.days} days in ${rule.maxDaysIn.windowDays}` });
    }
    if (rule.maxDaysPerEntry) {
      let longest = 0;
      // An entry under way when the horizon starts: its earlier days count.
      const pe = P.priorEntry && sameCountry(P.priorEntry.country, rule.country) ? P.priorEntry : null;
      let run = pe ? P.start - pe.start + 1 : 0;
      let prevEnd = pe ? dayIso(P.start) : "";
      for (const s of stays) {
        const c = P.cands[P.byCity.get(s.cityId) ?? P.fromIdx];
        if (sameCountry(c.place.country, rule.country)) {
          run = prevEnd === s.start && run ? run + stayNightsOf(s) : stayNightsOf(s) + 1;
          longest = Math.max(longest, run);
        } else run = 0;
        prevEnd = s.end;
      }
      visa.countryRules.push({ country: rule.country, maxUsed: longest, limit: `${rule.maxDaysPerEntry} days per entry` });
    }
  });
  // A rule typed for a country no place here is in (a typo, another spelling) is never applied: say so.
  visa.unmatchedRules = k.countryRules
    .filter((rule) => !P.cands.some((c) => sameCountry(c.place.country, rule.country)) && !P.input.prior.some((p) => sameCountry(p.country, rule.country)))
    .map((rule) => rule.country.trim() || "(no country)");
  for (const name of visa.unmatchedRules) visa.notes.push(`Your rule for "${name}" matches no place in the pool, so it was not applied. Check the spelling.`);
  visa.notes.push(VISA_SCOPE_NOTE);
  if (k.taxDays !== null) {
    const years = new Set<number>();
    for (let d = P.start; d < P.end; d += 300) years.add(new Date(d * 86_400_000).getUTCFullYear());
    years.add(new Date((P.end - 1) * 86_400_000).getUTCFullYear());
    for (const [key, days] of tax) {
      const [country, y] = key.split("|");
      if (!years.has(Number(y))) continue;
      const over = days >= k.taxDays;
      if (days >= k.taxDays - TAX_COMFORT_DAYS) {
        visa.taxDays.push({ country, year: Number(y), days, over });
        visaScore = Math.min(visaScore, taxScore(days, k.taxDays));
        visaNotes.push(`${country} ${y}: ${days} nights${over ? `, at or over ${k.taxDays}` : `, ${k.taxDays - days} under ${k.taxDays}`}.`);
      }
    }
    visa.notes.push(TAX_NOTE);
  }

  // Components.
  const fit = fitSum / N;
  const cost = costScoreSum / N;
  const risk = riskScoreSum / N;
  const friction = clamp(100 - movePoints * frictionFactor(P));
  const quarters = Math.max(1, P.horizonMonths / 3);
  let prefScore = 0;
  const prefNotes: string[] = [];
  P.input.preferences.forEach((p, pi) => {
    const w = Math.max(0, p.weight);
    if (p.kind === "long-haul") {
      const idx = prefLh.indexOf(p);
      const sat = clamp(100 * (1 - lhExcess[idx] / (2 * quarters)));
      prefScore += (w / P.prefWeightSum) * sat;
      prefNotes.push(`${preferenceLabel(p)}: ${lhExcess[idx] ? `${lhExcess[idx]} over the limit` : "met"} (${Math.round(sat)}).`);
      return;
    }
    if (!P.prefNights[pi]) {
      prefNotes.push(`${preferenceLabel(p)}: not in this horizon.`);
      return;
    }
    const sat = (100 * prefMet[pi]) / P.prefNights[pi];
    prefScore += (w / P.prefWeightSum) * sat;
    const unk = [...prefUnknown[pi]];
    prefNotes.push(`${preferenceLabel(p)}: ${Math.round(sat)}% of those nights${unk.length ? `; no coast distance for ${unk.join(", ")}, counted as not met` : ""}.`);
  });
  const avgCost = costKnownNights ? Math.round(costEurNights / costKnownNights / 10) * 10 : null;
  const components: Component[] = [
    {
      key: "fit",
      label: COMPONENT_LABEL.fit,
      score: r1(fit),
      weight: W.fit,
      detail: `Night-weighted month fit: your own windows first, else the Comfort Index (great 100, good 80, fair 55, poor 25, avoid 0).`,
      notes: unknownFit.size ? [`No fit data for ${[...unknownFit].join(", ")}: scored 50.`] : [],
    },
    {
      key: "cost",
      label: COMPONENT_LABEL.cost,
      score: r1(cost),
      weight: W.cost,
      detail: avgCost !== null ? `About €${avgCost.toLocaleString("en-US")} a month on average against your €${budget.toLocaleString("en-US")} budget; ${overBudgetMonths} ${overBudgetMonths === 1 ? "month" : "months"} over.` : "No cost figure for any stay.",
      notes: [
        ...(unknownCost.size ? [`No cost figure for ${[...unknownCost].join(", ")}: scored 50, not counted in the average.`] : []),
        "Place costs are estimates from Eurostat and World Bank price levels (ADR 0013) unless you gave a budget or rent.",
      ],
    },
    {
      key: "friction",
      label: COMPONENT_LABEL.friction,
      score: r1(friction),
      weight: W.friction,
      detail: `${moves.length} ${moves.length === 1 ? "move" : "moves"}, about ${Math.round(moves.reduce((a, m) => a + m.hours, 0))} h travelling and $${moves.reduce((a, m) => a + m.costUsd, 0).toLocaleString("en-US")} (estimates), ${moves.filter((m) => m.longHaul).length} long-haul.`,
      notes: ["Each move costs 1 point, plus 0.3 an hour and 1 per $200, scaled to a year; 100 minus 1.5 × that is the score."],
    },
    {
      key: "visa",
      label: COMPONENT_LABEL.visa,
      score: r1(visaScore),
      weight: W.visa,
      detail: visaNotes.length ? visaNotes.join(" ") : "No day-count limit comes close.",
      notes: [`Full marks with ${SCHENGEN_COMFORT_DAYS}+ spare Schengen days and ${TAX_COMFORT_DAYS}+ nights under the tax threshold.`, VISA_SCOPE_NOTE],
    },
    {
      key: "risk",
      label: COMPONENT_LABEL.risk,
      score: r1(risk),
      weight: W.risk,
      detail: riskItems.size ? `${riskItems.size} ${riskItems.size === 1 ? "risk" : "risks"} on the way.` : "None of these places is on Meridian's advisory and hazard list, and no news issue was found. That list is curated and partial.",
      notes: [...[...riskItems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} (${n} nights)`), RISK_SCOPE_NOTE],
    },
  ];
  if (W.preferences > 0) {
    components.push({ key: "preferences", label: COMPONENT_LABEL.preferences, score: r1(prefScore), weight: W.preferences, detail: `${P.input.preferences.length} weighted ${P.input.preferences.length === 1 ? "preference" : "preferences"}.`, notes: prefNotes });
  }
  const total = r1(components.reduce((a, c) => a + Math.max(0, c.weight) * c.score, 0) / P.weightSum);
  return { id, rank: 0, total, components, stays: planned, moves, monthsTable, visa, floors, differsFromBest: 0, violations: viol };
}

// ── Alternatives ───────────────────────────────────────────────────────

function describeDiff(a: ProposedRotation, b: ProposedRotation): string {
  const diffs = b.components
    .map((c) => ({ label: c.label, d: (c.score - (a.components.find((x) => x.key === c.key)?.score ?? 0)) * c.weight }))
    .filter((x) => Math.abs(x.d) >= 0.5)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 2)
    .map((x) => `${x.label.toLowerCase()} ${x.d > 0 ? "better" : "worse"}`);
  return diffs.length ? diffs.join(", ") : "about the same";
}

function alternativesFor(P: Prepared, plan: PlanInput, base: ProposedRotation, limit = 3): void {
  for (const ps of base.stays) {
    if (ps.role !== "base") continue;
    const alts: Alternative[] = [];
    for (const ci of P.pool) {
      const c = P.cands[ci];
      if (c.place.cityId === ps.cityId) continue;
      const trial: PlanInput = { stays: plan.stays.map((s) => (s.id === ps.id ? { ...s, cityId: c.place.cityId, notes: [] } : s)) };
      if (violations(P, trial).length) continue;
      const ev = evaluate(P, trial, "alt");
      alts.push({ cityId: c.place.cityId, name: c.place.name, total: ev.total, delta: r1(ev.total - base.total), why: describeDiff(base, ev) });
    }
    alts.sort((a, b) => b.total - a.total || a.cityId.localeCompare(b.cityId));
    ps.alternatives = alts.slice(0, limit);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

function shareDiffering(a: Int32Array, b: Int32Array, slots: Slot[], total: number): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += slots[i].nights;
  return n / total;
}

function planShare(a: PlanInput, b: PlanInput, start: number, end: number): number {
  const at = (p: PlanInput, d: string) => p.stays.find((s) => s.start <= d && d < s.end)?.cityId;
  let diff = 0;
  for (let d = start; d < end; d++) if (at(a, dayIso(d)) !== at(b, dayIso(d))) diff++;
  return diff / Math.max(1, end - start);
}

/**
 * Propose `results` distinct rotations, best first, each with its score explained and
 * next-best alternatives for every solver-placed stay.
 */
export function solve(input: SolveInput, env: SolverEnv = {}, clock: () => number = () => 0): SolveResult {
  const t0 = clock();
  const prepared = prepare(input, env);
  const want = Math.max(1, Math.min(5, Math.round(input.results || 3)));
  const width = Math.max(8, Math.min(400, Math.round(input.beamWidth ?? DEFAULT_BEAM)));
  if ("error" in prepared) {
    return { ok: false, proposals: [], error: prepared.error, stats: { slots: 0, candidates: input.candidates.length, expanded: 0, ms: 0, beamWidth: width, iterations: 0 }, horizon: { start: input.start, end: addMonthsToDate(input.start, input.months) }, method: SOLVER_METHOD };
  }
  const P = prepared;
  const stats = { expanded: 0 };
  const accepted: { node: Node; asg: Int32Array }[] = [];
  const penalty: Float64Array[] = P.slots.map(() => new Float64Array(P.cands.length));
  let iterations = 0;
  let firstLayerEmpty = false;
  const maxIter = want * 3;
  while (accepted.length < want && iterations < maxIter) {
    const layer = beam(P, width, iterations ? penalty : null, stats);
    iterations++;
    if (!layer.length) {
      if (iterations === 1) firstLayerEmpty = true;
      break;
    }
    let added = 0;
    for (const n of layer) {
      if (accepted.length >= want) break;
      const asg = assignment(P, n);
      if (accepted.some((a) => shareDiffering(a.asg, asg, P.slots, P.totalNights) < DISTINCT_SHARE)) continue;
      accepted.push({ node: n, asg });
      added++;
    }
    // Push later runs away from what is already accepted.
    const bump = 4 * Math.max(0.1, P.weights.fit);
    for (const a of accepted) for (let s = 0; s < P.slots.length; s++) penalty[s][a.asg[s]] += (bump * P.slots[s].nights) / 15;
    if (!added && iterations > want) break;
  }
  if (!accepted.length) {
    return {
      ok: false,
      proposals: [],
      error: firstLayerEmpty ? explainInfeasible(P) : "No legal rotation found.",
      stats: { slots: P.slots.length, candidates: P.pool.length, expanded: stats.expanded, ms: clock() - t0, beamWidth: width, iterations },
      horizon: { start: dayIso(P.start), end: dayIso(P.end) },
      method: SOLVER_METHOD,
    };
  }
  const tag = (i: number) => `sol-${hashString(String(i), input.seed >>> 0).toString(36)}`;
  const plans = accepted.map((a, i) => withHubs(P, planFromNode(P, a.node, tag(i))));
  const scored = plans.map((plan, i) => ({ plan, ev: evaluate(P, plan, tag(i)) }));
  // Never return an illegal plan, even if the search let one through.
  let proposals = scored.filter((x) => x.ev.violations.length === 0);
  const dropped = scored.length - proposals.length;
  proposals.sort((a, b) => b.ev.total - a.ev.total || hashString(a.ev.id, input.seed) - hashString(b.ev.id, input.seed));
  proposals = proposals.slice(0, want);
  if (!proposals.length) {
    return {
      ok: false,
      proposals: [],
      error: "No legal rotation found.",
      stats: { slots: P.slots.length, candidates: P.pool.length, expanded: stats.expanded, ms: clock() - t0, beamWidth: width, iterations, dropped },
      horizon: { start: dayIso(P.start), end: dayIso(P.end) },
      method: SOLVER_METHOD,
    };
  }
  proposals.forEach((p, i) => {
    p.ev.rank = i + 1;
    p.ev.differsFromBest = i === 0 ? 0 : Math.round(planShare(proposals[0].plan, p.plan, P.start, P.end) * 100) / 100;
    alternativesFor(P, p.plan, p.ev);
  });
  return {
    ok: true,
    proposals: proposals.map((p) => p.ev),
    stats: { slots: P.slots.length, candidates: P.pool.length, expanded: stats.expanded, ms: clock() - t0, beamWidth: width, iterations, dropped },
    horizon: { start: dayIso(P.start), end: dayIso(P.end) },
    method: SOLVER_METHOD,
  };
}

/** Why nothing fits: the first slot with no legal place, in words. */
function explainInfeasible(P: Prepared): string {
  if (!P.pool.length) return "The pool has no base places to choose from.";
  for (const slot of P.slots) {
    if (slot.fixed !== -1) continue;
    const ok = P.pool.some((c) => P.allowed[P.slots.indexOf(slot)][c]);
    if (!ok) {
      const reasons = P.pool.map((c) => staticBlock(P, c, slot, false)).filter(Boolean).slice(0, 3);
      return `Nothing in the pool can be used from ${dayIso(slot.start)}: ${reasons.join("; ")}.`;
    }
  }
  return "No combination of the pool fits every rule: stay lengths, Schengen and country day limits, and fixed stays leave a gap. Add places, loosen a limit, or unlock a stay.";
}

/** Re-score a plan as it is (after a swap or an edit): violations, components, alternatives. */
export function evaluatePlan(input: SolveInput, plan: PlanInput, env: SolverEnv = {}, withAlternatives = true): ProposedRotation | { error: string } {
  const prepared = prepare(input, env);
  if ("error" in prepared) return prepared;
  const ev = evaluate(prepared, plan, "plan");
  if (withAlternatives && !ev.violations.length) alternativesFor(prepared, plan, ev);
  ev.rank = 1;
  return ev;
}

/** The plan a proposal stands for, to pass back to evaluatePlan. */
export function planOf(p: ProposedRotation): PlanInput {
  return { stays: p.stays.map((s) => ({ id: s.id, cityId: s.cityId, start: s.start, end: s.end, kind: s.kind, role: s.role, notes: s.notes })) };
}

/** Test seam. */
export const __internal = { prepare, violations, evaluate };

export type { RotationPlace };
