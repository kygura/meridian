// Rotation Solver types (ADR 0015). Pure data: the server fills a SolveInput from the
// owner's rotation, place data, the Comfort Index and the risk feeds; the engine
// (engine.ts) returns Proposed Rotations with every score component explained.

import type { FitLevel, RotationPlace, StayKind } from "../rotation";
import type { MonthSpan } from "../../types";

/** How one calendar month reads for a place: the owner's window first, else the Comfort Index. */
export interface MonthReading {
  level: FitLevel;
  source: "personal" | "comfort" | "none";
  /** "Your peak: dry season", "Comfort 72", "No comfort data". */
  why: string;
}

/** Something risky about a place, from a named feed. */
export interface PlaceRisk {
  /** advisory/conflict from data/phenomena.json, hazard (seasonal), issue or flag (the place's news). */
  kind: "advisory" | "conflict" | "hazard" | "issue" | "flag";
  /** 1 watch … 3 avoid. */
  severity: 1 | 2 | 3;
  label: string;
  source: string;
  url?: string;
  /** Months (1-12) a seasonal hazard applies; absent = all months. */
  months?: number[];
  /** True for news: it describes now, so its weight fades over the horizon. */
  current?: boolean;
}

/** A measured or owner-given figure with where it came from. */
export interface Sourced {
  value: number;
  /** "Your budget", "Eurostat price level, country figure, 2024 (estimate)". */
  source: string;
  estimate?: boolean;
}

/** One place the solver may use, with everything it needs to score it. */
export interface Candidate {
  place: RotationPlace;
  kind: StayKind;
  minNights: number;
  maxNights: number;
  /** Twelve readings, January first. */
  months: MonthReading[];
  /** All-in monthly cost in EUR, or null when no source has it. */
  costMonthlyEur: Sourced | null;
  /** Fixed (else mobile) median download, Mbps; null when unmeasured. */
  internetMbps: Sourced | null;
  /** WHO UHC service coverage index, 0-100; null when unmeasured. */
  healthUhc: Sourced | null;
  /** Distance to the sea coast, km; null when not known. */
  coastKm: Sourced | null;
  /** Broad world region (worldRegion.ts). */
  region?: string;
  risks: PlaceRisk[];
  /** Same id = reachable over land (legs.ts). */
  landmass?: number;
  /** In the pool (the solver may place it). Locked stays' places are candidates too, outside the pool. */
  inPool: boolean;
  /** Re-planning: never place it (in addition to locked stays already there). */
  excluded?: string;
  /** Re-planning: points taken off every slot it fills, with why. */
  penalty?: { points: number; reason: string };
}

/** A stay that must stay exactly where it is. */
export interface FixedStay {
  id: string;
  cityId: string;
  start: string;
  end: string;
  kind: StayKind;
  /** "locked", "booked", "current". */
  why: string;
}

/** Past or committed presence, for the Schengen look-back and tax-year days. */
export interface PriorPresence {
  country: string;
  start: string;
  /** Exclusive. */
  end: string;
}

export interface CountryRule {
  country: string;
  /** Longest stay per entry, in days (both the entry and exit day count). */
  maxDaysPerEntry?: number;
  /** At most `days` days in any rolling `windowDays`. */
  maxDaysIn?: { days: number; windowDays: number };
  /** Where the owner got the rule. */
  note?: string;
}

export interface Constraints {
  /** Enforce 90 days in any 180 inside the Schengen Area (non-EU/EEA/Swiss passports). */
  schengen: boolean;
  countryRules: CountryRule[];
  /** Allow a short trip out and back to restart a per-entry limit. */
  allowBorderRuns: boolean;
  /** Days in one country in a calendar year that start a tax-residency question; null = off. */
  taxDays: number | null;
  /** Hard floors where measured; unknown is allowed and flagged. */
  minInternetMbps: number | null;
  minHealthUhc: number | null;
  /** A month the owner marked "avoid" can never be filled by that place. */
  avoidIsHard: boolean;
}

export type Preference =
  | { id: string; kind: "region"; label?: string; region: string; months: MonthSpan; weight: number }
  | { id: string; kind: "coast"; label?: string; maxKm: number; months: MonthSpan; weight: number }
  | { id: string; kind: "long-haul"; label?: string; maxPerQuarter: number; minHours: number; weight: number };

export interface Weights {
  fit: number;
  cost: number;
  friction: number;
  visa: number;
  risk: number;
  preferences: number;
}

export interface SolveInput {
  /** First night, YYYY-MM-DD. */
  start: string;
  /** 12-18. */
  months: number;
  /** Where the owner is when the horizon starts (the first move leaves from here). */
  from: RotationPlace;
  budgetMonthlyEur: number;
  candidates: Candidate[];
  fixed: FixedStay[];
  prior: PriorPresence[];
  constraints: Constraints;
  preferences: Preference[];
  weights: Weights;
  /** How many distinct rotations to return, 3-5. */
  results: number;
  /** Tie-breaking seed: same seed and input, same output. */
  seed: number;
  /** Search breadth; larger is slower and rarely better. Default 96. */
  beamWidth?: number;
}

// ── Results ───────────────────────────────────────────────────────────

export type StayRole = "base" | "pass-through" | "border-run" | "fixed";

export interface Alternative {
  cityId: string;
  name: string;
  /** Total score with this place in the slot instead. */
  total: number;
  /** total − the rotation's total (negative = worse). */
  delta: number;
  /** Biggest component changes, in words. */
  why: string;
}

export interface PlannedStay {
  id: string;
  cityId: string;
  name: string;
  country?: string;
  start: string;
  end: string;
  nights: number;
  kind: StayKind;
  role: StayRole;
  /** Why it is there, when not obvious ("Schengen buffer: …", "Border run: …", "Booked"). */
  notes: string[];
  /** Month by month fit for this stay. */
  months: { ym: string; nights: number; level: FitLevel; why: string }[];
  costMonthlyEur: number | null;
  costSource: string | null;
  alternatives: Alternative[];
}

export interface PlannedMove {
  fromCityId: string;
  toCityId: string;
  date: string;
  km: number;
  hours: number;
  costUsd: number;
  mode: string;
  via?: string;
  longHaul: boolean;
  method: string;
}

export interface Component {
  key: keyof Weights;
  label: string;
  /** 0-100. */
  score: number;
  weight: number;
  /** One line with the figures behind the score. */
  detail: string;
  notes: string[];
}

export interface MonthRow {
  ym: string;
  /** Main place that month (most nights). */
  cityId: string;
  name: string;
  level: FitLevel;
  why: string;
  costEur: number | null;
}

export interface VisaReport {
  schengen: { enabled: boolean; maxUsed: number; marginDays: number | null; peakOn: string | null };
  taxDays: { country: string; year: number; days: number; over: boolean }[];
  countryRules: { country: string; maxUsed: number; limit: string }[];
  /** Rules whose country matches no place in the pool or past presence: never applied. */
  unmatchedRules?: string[];
  notes: string[];
}

export interface ProposedRotation {
  id: string;
  rank: number;
  /** Weighted mean of the components, 0-100. */
  total: number;
  components: Component[];
  stays: PlannedStay[];
  moves: PlannedMove[];
  monthsTable: MonthRow[];
  visa: VisaReport;
  floors: { label: string; met: number; unknown: string[] }[];
  /** Share of nights that differ from the top proposal, 0-1. */
  differsFromBest: number;
  /** Hard-constraint check of this exact plan (always ok for a returned proposal). */
  violations: string[];
}

export interface SolveResult {
  ok: boolean;
  proposals: ProposedRotation[];
  /** When nothing legal exists: what blocked it. */
  error?: string;
  stats: { slots: number; candidates: number; expanded: number; ms: number; beamWidth: number; iterations: number; dropped?: number };
  horizon: { start: string; end: string };
  method: string;
}

/** A plan to evaluate as is (after a swap or a manual edit). */
export interface PlanInput {
  stays: { id: string; cityId: string; start: string; end: string; kind: StayKind; role: StayRole; notes?: string[] }[];
}
