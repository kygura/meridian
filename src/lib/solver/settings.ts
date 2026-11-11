// What the owner keeps for the solver and the re-plan loop (ADR 0015). Shared by the
// server store and the Solve screen.

import type { Constraints, Preference, ProposedRotation, Weights } from "./types";
import type { StayKind } from "../rotation";

export interface PoolEntry {
  cityId: string;
  kind: StayKind;
  minNights?: number;
  maxNights?: number;
  /** The owner's own all-in monthly figure for this place, EUR; overrides the estimate. */
  budgetEur?: number;
}

export interface ReplanSettings {
  enabled: boolean;
  /** Stays after the current one that are watched (2-3 is typical). */
  watchAhead: number;
  /** Lowest news level that counts: any Watch Flag, a recent incident, or a pattern. */
  newsMinLevel: "any" | "incident" | "systemic";
  /** Flight price change on the next move, percent against the watch's baseline. */
  flightChangePct: number;
  /** Observed PM2.5 above the month's normal by this many µg/m³. */
  pm25Over: number;
  /** Observed mean temperature this far from the month's normal, °C. */
  tempDeltaC: number;
  /** Book-by reminders go out this many days ahead. */
  bookByNoticeDays: number;
  /** A shift must exceed its threshold by this percentage to fire, and fall this far below it to clear. */
  hysteresisPct: number;
  /** Days before the same shift can raise another proposal. */
  cooldownDays: number;
}

export interface SolverSettings {
  pool: PoolEntry[];
  budgetMonthlyEur: number;
  months: number;
  constraints: Constraints;
  preferences: Preference[];
  weights: Weights;
  results: number;
  seed: number;
  replan: ReplanSettings;
  updatedAt?: string;
}

export const DEFAULT_CONSTRAINTS: Constraints = {
  // Used only while no passport is set: on by default, since wrongly on costs some options and
  // wrongly off risks an overstay. With a passport in Settings › Visas, Schengen follows the
  // passport (ADR 0012). Every plan states that past days not in the rotation or journal count as zero.
  schengen: true,
  countryRules: [],
  allowBorderRuns: false,
  taxDays: 183,
  minInternetMbps: null,
  minHealthUhc: null,
  avoidIsHard: true,
};

export const DEFAULT_REPLAN: ReplanSettings = {
  enabled: true,
  watchAhead: 3,
  newsMinLevel: "systemic",
  flightChangePct: 30,
  pm25Over: 25,
  tempDeltaC: 5,
  bookByNoticeDays: 14,
  hysteresisPct: 20,
  cooldownDays: 7,
};

export const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
  pool: [],
  budgetMonthlyEur: 2000,
  months: 12,
  constraints: DEFAULT_CONSTRAINTS,
  preferences: [],
  weights: { fit: 1, cost: 0.8, friction: 0.6, visa: 0.6, risk: 0.6, preferences: 0.8 },
  results: 3,
  seed: 1,
  replan: DEFAULT_REPLAN,
};

/** One measured change that may call for a new plan. */
export interface Shift {
  /** Stable: kind + stay + subject ("news:st-1:rail"). */
  key: string;
  kind: "news" | "flight-price" | "air" | "weather" | "visa" | "book-by";
  stayId: string;
  cityId: string;
  place: string;
  /** What changed, one line. */
  title: string;
  /** How far past its threshold, as a ratio (1 = exactly at it). */
  magnitude: number;
  /** "penalise" lowers the stay's score in the re-solve; "exclude" drops it; "none" = notify only. */
  action: "penalise" | "exclude" | "none";
  evidence: { label: string; source: string; url?: string; value?: string }[];
}

export type ProposalStatus = "open" | "accepted" | "dismissed" | "snoozed" | "superseded";

export interface StayChange {
  kind: "added" | "removed" | "moved" | "unchanged";
  cityId: string;
  name: string;
  before?: { start: string; end: string };
  after?: { start: string; end: string };
}

/** A re-plan the owner can accept, dismiss or snooze. Nothing changes until accepted. */
export interface Proposal {
  id: string;
  createdAt: string;
  status: ProposalStatus;
  snoozedUntil?: string;
  decidedAt?: string;
  /** The shifts that raised it. */
  shifts: Shift[];
  /** Plan B, or null when no legal plan B exists (the proposal then only reports). */
  planB: ProposedRotation | null;
  /** Plan B against the active rotation. */
  diff: {
    stays: StayChange[];
    /** Total score: active vs plan B. */
    scoreBefore: number | null;
    scoreAfter: number | null;
    /** Monthly cost, EUR (place estimates), and Schengen days at the peak. */
    costBefore: number | null;
    costAfter: number | null;
    schengenBefore: number | null;
    schengenAfter: number | null;
    /** Estimated travel cost, USD. */
    travelBefore: number | null;
    travelAfter: number | null;
  } | null;
  /** Why there is no plan B, when there isn't one. */
  note?: string;
}

/** Memory per shift key, for hysteresis and cooldown. */
export interface ShiftMemory {
  active: boolean;
  firstSeen: string;
  lastSeen: string;
  lastMagnitude: number;
  lastProposalAt?: string;
}

export interface SolverDoc {
  version: 1;
  settings: SolverSettings;
  proposals: Proposal[];
  shifts: Record<string, ShiftMemory>;
  lastReplan?: { at: string; shifts: number; proposals: number; notes: string[] };
  /** First fare seen per move (origin-destination-date), the baseline for fare shifts. */
  fareBaselines?: Record<string, number>;
}

/** "90 in 180" → { days: 90, windowDays: 180 }; null while incomplete or unreadable; undefined when blank. */
export function parseDaysInWindow(text: string): { days: number; windowDays: number } | null | undefined {
  if (!text.trim()) return undefined;
  const m = text.match(/^\s*(\d+)\D+(\d+)\s*$/);
  if (!m) return null;
  const days = Number(m[1]);
  const windowDays = Number(m[2]);
  return days > 0 && windowDays >= days ? { days, windowDays } : null;
}
