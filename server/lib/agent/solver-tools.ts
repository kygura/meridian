// Agent tool for the Rotation Solver (ADR 0015, extends ADR 0003). Same contract as the
// other tools: zod params, never throw (return {error}). Owner-only, like the journal
// tools: the rotation is personal data. The tool never writes: proposals are shown, and
// only the owner can make one the rotation (in the Solve flow).

import { z } from "zod";
import { getSolverSettings } from "../solverStore.js";
import { runSolve } from "../solverService.js";
import { preferenceLabel } from "../../../src/lib/solver/prefs.js";
import type { ProposedRotation } from "../../../src/lib/solver/types.js";

export const SOLVER_LOCKED = { error: "owner_only", message: "Sign in as the owner to run the rotation solver." } as const;

export const solveRotationParams = z.object({
  /** Override the saved monthly budget, EUR. */
  budgetMonthlyEur: z.number().min(100).max(100_000).optional(),
  months: z.number().int().min(12).max(18).optional(),
  /** Add places (city ids) to the saved pool for this run. */
  addCityIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Leave places out of this run. */
  excludeCityIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  results: z.number().int().min(1).max(5).optional(),
});
export type SolveRotationParams = z.infer<typeof solveRotationParams>;

const invalid = (e: z.ZodError) => ({ error: "invalid_params", issues: e.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) });

/** A proposal in words the model can relay: scores with their reasons, stays, alternatives. */
export function explainProposal(p: ProposedRotation) {
  return {
    option: p.rank,
    total: p.total,
    components: p.components.map((c) => ({ name: c.label, score: Math.round(c.score), weight: c.weight, why: c.detail, notes: c.notes.slice(0, 4) })),
    stays: p.stays.map((s) => ({
      place: s.name,
      cityId: s.cityId,
      from: s.start,
      to: s.end,
      nights: s.nights,
      role: s.role,
      costPerMonthEur: s.costMonthlyEur,
      costSource: s.costSource,
      notes: s.notes,
      alternatives: s.alternatives.map((a) => ({ place: a.name, cityId: a.cityId, scoreChange: a.delta, why: a.why })),
    })),
    moves: p.moves.map((m) => ({ from: m.fromCityId, to: m.toCityId, date: m.date, hours: m.hours, costUsd: m.costUsd, longHaul: m.longHaul })),
    visa: { schengenPeakDays: p.visa.schengen.enabled ? p.visa.schengen.maxUsed : null, taxDays: p.visa.taxDays, notes: p.visa.notes },
    differsFromBest: p.differsFromBest,
  };
}

export function createSolverTools(ctx: { unlocked: boolean }) {
  async function solveRotation(raw: SolveRotationParams) {
    if (!ctx.unlocked) return { ...SOLVER_LOCKED };
    const p = solveRotationParams.safeParse(raw ?? {});
    if (!p.success) return invalid(p.error);
    try {
      const saved = await getSolverSettings();
      const drop = new Set(p.data.excludeCityIds ?? []);
      const pool = [...saved.pool.filter((e) => !drop.has(e.cityId)), ...(p.data.addCityIds ?? []).filter((id) => !drop.has(id) && !saved.pool.some((e) => e.cityId === id)).map((cityId) => ({ cityId, kind: "base" as const }))];
      if (!pool.length) return { error: "empty_pool", message: "The solver's pool is empty. Add places on the Rotation screen (Solve) or pass addCityIds." };
      const settings = {
        ...saved,
        pool,
        budgetMonthlyEur: p.data.budgetMonthlyEur ?? saved.budgetMonthlyEur,
        months: p.data.months ?? saved.months,
        results: Math.max(1, Math.min(5, p.data.results ?? saved.results)),
      };
      const r = await runSolve({ settings, start: p.data.start });
      if ("error" in r && !("proposals" in r)) return { error: "cannot_solve", message: r.error };
      if (!r.ok) return { error: "no_legal_rotation", message: r.error, notes: r.notes };
      return {
        horizon: r.horizon,
        budgetMonthlyEur: settings.budgetMonthlyEur,
        preferences: settings.preferences.map((x) => ({ wish: preferenceLabel(x), weight: x.weight })),
        method: r.method,
        dataNotes: r.notes,
        proposals: r.proposals.map(explainProposal),
        howToAccept: "Nothing has changed. The owner can make an option their rotation on the Rotation screen, under Solve.",
      };
    } catch (err) {
      console.error("[agent/solver-tools] solve_rotation error:", err instanceof Error ? err.message : err);
      return { error: "solve_rotation_failed" };
    }
  }
  return { solveRotation };
}
