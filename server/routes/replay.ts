// POST /api/replay (spec-journal §6). Token-gated (also by gateRoutes in index.ts).
// Body = ReplayQuery (zod-validated) → ReplayResponse. A template journey whose
// fingerprint is missing/stale is recomputed + persisted first, so
// template_not_fingerprinted only means it is still impossible.

import { Hono } from "hono";
import { readFile } from "fs/promises";
import { z } from "zod";
import type { MeridianEvent, ReplayQuery } from "../../src/types.js";
import { requireToken } from "../middleware/auth.js";
import { getDataPath } from "../lib/paths.js";
import { toMoney } from "../lib/fx.js";
import { getSettings, listJourneys } from "../lib/journal.js";
import { ensureFingerprint } from "../lib/journalFingerprint.js";
import { defaultReplayDeps, runReplay, ReplayError, type ReplayDeps } from "../lib/replay.js";

const month = z.number().int().min(1).max(12);

const fingerprintSchema = z
  .object({
    month,
    weekOfYear: z.number().int().min(1).max(53),
    comfort: z.number().min(0).max(100),
    tempC: z.number().min(-60).max(60),
    precipMm: z.number().min(0).max(5000),
    dailySpendEur: z.number().min(0),
    flightCostEurPer1000km: z.number().min(0),
    crowdProxy: z.number().min(0).max(100),
    durationNights: z.number().int().min(0),
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    tags: z.array(z.string().max(50)).max(50),
  })
  .partial();

const weight = z.number().min(0).max(1);

export const replayQuerySchema = z.object({
  template: z.union([
    z.object({ journeyId: z.string().min(1), stopIndex: z.number().int().min(0).optional() }),
    z.object({ fingerprint: fingerprintSchema }),
  ]),
  bend: z
    .object({
      tempC: z.number().min(-10).max(10).optional(),
      spendPct: z.number().min(-50).max(50).optional(),
      crowd: z.number().min(-50).max(50).optional(),
      monthShift: z.number().int().min(-6).max(6).nullable().optional(),
    })
    .default({}),
  weights: z.object({ climate: weight, spend: weight, crowd: weight, flight: weight }),
  constraints: z
    .object({
      months: z.array(month).max(12).optional(),
      regions: z.array(z.string().min(1).max(50)).max(20).optional(),
      excludeVisited: z.boolean().optional(),
      maxFlightHours: z.number().positive().max(48).optional(),
      fromCityId: z.string().min(1).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      cityIds: z.array(z.string().min(1)).max(500).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

type DepsParams = Parameters<typeof defaultReplayDeps>[0];
let depsFactory: (p: DepsParams) => ReplayDeps = defaultReplayDeps;

/** Test seam: replace the real deps wiring (seasonality, flights, …); no arg restores it. */
export function setReplayDepsFactory(f?: (p: DepsParams) => ReplayDeps): void {
  depsFactory = f ?? defaultReplayDeps;
}

/** fx-backed EUR conversion; no rate → undefined (price shown, not scored). */
export async function eurOf(amount: number, currency: string, date: string): Promise<number | undefined> {
  try {
    return (await toMoney(amount, currency, date)).eur;
  } catch {
    return undefined;
  }
}

/** data/events.json (task W) — tolerant of a missing/corrupt file, array or {events}. */
export async function loadEvents(): Promise<MeridianEvent[]> {
  try {
    const raw = JSON.parse(await readFile(getDataPath("events.json"), "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { events?: unknown })?.events;
    return Array.isArray(list) ? (list as MeridianEvent[]) : [];
  } catch {
    return [];
  }
}

const replay = new Hono();
replay.use("*", requireToken);

replay.post("/", async (c) => {
  const parsed = replayQuerySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  const query = parsed.data as ReplayQuery;

  try {
    let journeys = await listJourneys();
    const t = query.template;
    if ("journeyId" in t) {
      const j = journeys.find((x) => x.id === t.journeyId);
      if (j) {
        const fresh = await ensureFingerprint(j);
        journeys = journeys.map((x) => (x.id === fresh.id ? fresh : x));
      }
    }
    const [settings, events] = await Promise.all([getSettings(), loadEvents()]);
    const result = await runReplay(query, depsFactory({ journeys, settings, eurOf, events }));
    return c.json(result);
  } catch (err) {
    if (err instanceof ReplayError) {
      return c.json({ error: err.code, message: err.message }, err.code === "template_not_found" ? 404 : 409);
    }
    console.error("[replay] error:", err);
    return c.json({ error: "replay_failed", message: "Could not run replay." }, 500);
  }
});

export default replay;
