// /api/solver (ADR 0015): the Rotation Solver and the re-plan Proposals. Owner-only,
// like /api/rotation (ADR 0009).
//
//   GET  /api/solver/settings                 pool, budget, constraints, preferences, weights, re-plan thresholds
//   PUT  /api/solver/settings                 save them
//   POST /api/solver/solve                    { settings?, start?, fromCityId?, pins?, news? } → proposals
//   POST /api/solver/evaluate                 { settings?, start?, plan } → one plan re-scored (after a swap)
//   POST /api/solver/accept                   { plan, runId } → the plan becomes the active rotation
//   GET  /api/solver/proposals                re-plan Proposals, newest first
//   POST /api/solver/proposals/:id/:action    accept | dismiss | snooze { days? }
//   POST /api/solver/replan                   run the re-plan check now

import { Hono } from "hono";
import { z } from "zod";
import { requireToken } from "../middleware/auth.js";
import { isoDateSchema } from "../lib/journalSchemas.js";
import { getSolverSettings, putSolverSettings, solverSettingsSchema } from "../lib/solverStore.js";
import { acceptPlan, runEvaluate, runSolve } from "../lib/solverService.js";

const solver = new Hono();
solver.use("*", requireToken);

const planSchema = z.object({
  stays: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        cityId: z.string().min(1).max(200),
        start: isoDateSchema,
        end: isoDateSchema,
        kind: z.enum(["base", "pass-through"]),
        role: z.enum(["base", "pass-through", "border-run", "fixed"]),
        notes: z.array(z.string().max(600)).max(10).optional(),
      })
    )
    .min(1)
    .max(120),
});

const pinSchema = z.object({ id: z.string().min(1).max(120), cityId: z.string().min(1).max(200), start: isoDateSchema, end: isoDateSchema, kind: z.enum(["base", "pass-through"]) });

const solveSchema = z.object({
  settings: solverSettingsSchema.optional(),
  start: isoDateSchema.optional(),
  fromCityId: z.string().max(200).optional(),
  pins: z.array(pinSchema).max(20).optional(),
  news: z.boolean().optional(),
});

solver.get("/settings", async (c) => c.json({ settings: await getSolverSettings() }));

solver.put("/settings", async (c) => {
  const body = solverSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_settings", details: body.error.issues }, 400);
  return c.json({ settings: await putSolverSettings(body.data) });
});

solver.post("/solve", async (c) => {
  const body = solveSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  const settings = body.data.settings ?? (await getSolverSettings());
  if (!settings.pool.length) return c.json({ error: "empty_pool", message: "Add places to the pool first." }, 400);
  const r = await runSolve({ settings, start: body.data.start, fromCityId: body.data.fromCityId, pins: body.data.pins, news: body.data.news });
  if ("error" in r && !("proposals" in r)) return c.json({ error: "cannot_solve", message: r.error }, 400);
  return c.json(r);
});

solver.post("/evaluate", async (c) => {
  const body = solveSchema.extend({ plan: planSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  const settings = body.data.settings ?? (await getSolverSettings());
  const r = await runEvaluate({ settings, start: body.data.start, fromCityId: body.data.fromCityId, pins: body.data.pins }, body.data.plan);
  if ("error" in r) return c.json({ error: "cannot_evaluate", message: r.error }, 400);
  return c.json(r);
});

solver.post("/accept", async (c) => {
  const body = z.object({ plan: planSchema, runId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  return c.json(await acceptPlan(body.data.plan, body.data.runId));
});

export default solver;
