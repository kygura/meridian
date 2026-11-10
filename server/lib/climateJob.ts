// Nightly incremental climate backfill (ADR 0014). Once a day, at CLIMATE_JOB_HOUR_UTC, fills the
// next gaps in the climate normals (missing cells first, then the oldest) within a per-run budget
// of weighted Open-Meteo calls, saving each cell to the document store as it lands.
//
//   CLIMATE_JOB=off              disable the job (default: on, except under tests)
//   CLIMATE_JOB_HOUR_UTC=3       hour of day to run
//   CLIMATE_JOB_BUDGET=2500      weighted calls per run (~29 cells); the shared hourly/daily ledger still applies
//   OPEN_METEO_HOURLY_BUDGET / OPEN_METEO_DAILY_BUDGET   our own ceilings under Open-Meteo's free tier

import { getCities, loadCities } from "./cities.js";
import { planBackfill, runBackfill, type BackfillResult } from "./climateBackfill.js";
import { climateCells, climateCoverage, hydrateClimateRuntime, loadSeasonality, saveRuntimeClimateCell } from "./seasonality.js";

let running = false;
let lastRun: { at: string; result: BackfillResult } | undefined;

export function lastClimateJobRun() {
  return lastRun;
}

export function climateJobBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CLIMATE_JOB_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

/** One run: plan the gaps, spend up to the budget, persist each cell as it lands. Never throws. */
export async function runClimateJobOnce(opts: { budget?: number; maxCells?: number; fetchFn?: typeof fetch } = {}): Promise<BackfillResult | undefined> {
  if (running) return undefined;
  running = true;
  try {
    loadCities();
    await hydrateClimateRuntime();
    const plan = planBackfill(getCities(), climateCells(), { seedIds: new Set(Object.keys(loadSeasonality().cities)) });
    const result = await runBackfill({
      plan,
      runBudget: opts.budget ?? climateJobBudget(),
      maxCells: opts.maxCells,
      fetchFn: opts.fetchFn,
      sink: {
        get: (k) => climateCells()[k],
        save: (k, cell) => saveRuntimeClimateCell(k, cell),
      },
    });
    lastRun = { at: new Date().toISOString(), result };
    const cov = climateCoverage();
    console.log(
      `[climate-job] ${result.cellsCompleted} cells done (${result.stoppedBy}), ~${Math.round(result.spent)} weighted calls; ` +
        `${cov.monthly}/${cov.cities} cities monthly, ${cov.weekly} weekly, ${cov.air} with air quality; ${result.remainingGaps} cells still have a gap`
    );
    return result;
  } catch (err) {
    console.warn("[climate-job] run failed:", err instanceof Error ? err.message : String(err));
    return undefined;
  } finally {
    running = false;
  }
}

/** Milliseconds from `now` to the next occurrence of `hourUtc`:00 UTC. */
export function msUntilHourUtc(hourUtc: number, now: Date = new Date()): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Starts the nightly schedule. Returns a stop function. A no-op when disabled. */
export function startClimateJob(env: NodeJS.ProcessEnv = process.env): () => void {
  if (env.CLIMATE_JOB === "off" || env.NODE_ENV === "test" || env.VITEST) return () => undefined;
  const hour = Number.isInteger(Number(env.CLIMATE_JOB_HOUR_UTC)) && env.CLIMATE_JOB_HOUR_UTC !== undefined ? Number(env.CLIMATE_JOB_HOUR_UTC) % 24 : 3;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      await runClimateJobOnce();
      schedule();
    }, msUntilHourUtc(hour));
    timer.unref?.();
  };
  void hydrateClimateRuntime();
  schedule();
  console.log(`[climate-job] nightly backfill scheduled for ${String(hour).padStart(2, "0")}:00 UTC, budget ${climateJobBudget(env)} weighted calls`);
  return () => timer && clearTimeout(timer);
}
