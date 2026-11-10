// Solver settings and re-plan state (ADR 0015): one "solver.json" document in the shared
// store (a file under DATA_DIR, or a Postgres row), so both backends work.
//
// Settings are what the Solve flow and the daily re-plan job solve with: the pool, the
// budget, constraints, preferences, weights and the re-plan thresholds. Proposals and
// the shift memory used for hysteresis live in the same document (replanStore.ts reads
// and writes them through `updateSolverDoc`).

import { z } from "zod";
import { createJsonStore } from "./jsonStore.js";
import { DEFAULT_WEIGHTS } from "../../src/lib/solver/engine.js";
import type { SolverDoc, SolverSettings } from "../../src/lib/solver/settings.js";
import { DEFAULT_REPLAN, DEFAULT_SOLVER_SETTINGS } from "../../src/lib/solver/settings.js";

const month = z.number().int().min(1).max(12);
const monthSpan = z.object({ start: month, end: month });
const weight = z.number().min(0).max(1);

export const poolEntrySchema = z.object({
  cityId: z.string().min(1).max(200),
  kind: z.enum(["base", "pass-through"]).default("base"),
  minNights: z.number().int().min(1).max(400).optional(),
  maxNights: z.number().int().min(1).max(400).optional(),
  /** The owner's own all-in monthly figure for this place, EUR; overrides the estimate. */
  budgetEur: z.number().min(0).max(100_000).optional(),
});

export const constraintsSchema = z.object({
  schengen: z.boolean(),
  countryRules: z
    .array(
      z.object({
        country: z.string().min(1).max(100),
        maxDaysPerEntry: z.number().int().min(1).max(366).optional(),
        maxDaysIn: z.object({ days: z.number().int().min(1).max(366), windowDays: z.number().int().min(7).max(730) }).optional(),
        note: z.string().max(300).optional(),
      })
    )
    .max(30),
  allowBorderRuns: z.boolean(),
  taxDays: z.number().int().min(30).max(366).nullable(),
  minInternetMbps: z.number().min(0).max(10_000).nullable(),
  minHealthUhc: z.number().min(0).max(100).nullable(),
  avoidIsHard: z.boolean(),
});

export const preferenceSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().max(40), kind: z.literal("region"), label: z.string().max(120).optional(), region: z.string().min(1).max(120), months: monthSpan, weight }),
  z.object({ id: z.string().max(40), kind: z.literal("coast"), label: z.string().max(120).optional(), maxKm: z.number().min(0).max(500), months: monthSpan, weight }),
  z.object({ id: z.string().max(40), kind: z.literal("long-haul"), label: z.string().max(120).optional(), maxPerQuarter: z.number().int().min(0).max(12), minHours: z.number().min(1).max(30), weight }),
]);

export const weightsSchema = z.object({ fit: weight, cost: weight, friction: weight, visa: weight, risk: weight, preferences: weight });

export const replanSchema = z.object({
  enabled: z.boolean(),
  /** How many stays after the current one are watched. */
  watchAhead: z.number().int().min(1).max(4),
  newsMinLevel: z.enum(["any", "incident", "systemic"]),
  flightChangePct: z.number().min(5).max(200),
  pm25Over: z.number().min(5).max(500),
  tempDeltaC: z.number().min(1).max(20),
  bookByNoticeDays: z.number().int().min(0).max(120),
  /** A shift must clear its threshold by this share to raise a proposal, and drop below the threshold minus this share to clear. */
  hysteresisPct: z.number().min(0).max(50),
  /** Days before the same shift may raise a new proposal. */
  cooldownDays: z.number().int().min(1).max(60),
});

export const solverSettingsSchema = z.object({
  pool: z.array(poolEntrySchema).max(40),
  budgetMonthlyEur: z.number().min(100).max(100_000),
  months: z.number().int().min(12).max(18),
  constraints: constraintsSchema,
  preferences: z.array(preferenceSchema).max(12),
  weights: weightsSchema,
  results: z.number().int().min(3).max(5),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  replan: replanSchema,
});

export type SolverSettingsInput = z.infer<typeof solverSettingsSchema>;

const store = createJsonStore<SolverDoc>("solver.json", () => ({ version: 1, settings: { ...DEFAULT_SOLVER_SETTINGS }, proposals: [], shifts: {} }));

export async function readSolverDoc(): Promise<SolverDoc> {
  const d = await store.read();
  return {
    ...d,
    settings: { ...DEFAULT_SOLVER_SETTINGS, ...d.settings, weights: { ...DEFAULT_WEIGHTS, ...d.settings?.weights }, replan: { ...DEFAULT_REPLAN, ...d.settings?.replan } },
    proposals: d.proposals ?? [],
    shifts: d.shifts ?? {},
  };
}

export async function getSolverSettings(): Promise<SolverSettings> {
  return (await readSolverDoc()).settings;
}

export function updateSolverDoc<T>(fn: (d: SolverDoc) => T): Promise<T> {
  return store.update((d) => {
    d.settings = { ...DEFAULT_SOLVER_SETTINGS, ...d.settings, replan: { ...DEFAULT_REPLAN, ...d.settings?.replan } };
    d.proposals ??= [];
    d.shifts ??= {};
    return fn(d);
  });
}

export async function putSolverSettings(input: SolverSettingsInput, now = new Date()): Promise<SolverSettings> {
  return updateSolverDoc((d) => {
    d.settings = { ...input, updatedAt: now.toISOString() };
    return d.settings;
  });
}
