// In-process scheduler for the long-running Node server (ADR 0016). Started by
// server/index.ts only; the Vercel function (server/vercel.ts) never imports it and
// relies on Vercel Cron calling /api/jobs/daily instead.
//
//   DAILY_JOBS_AT=06:17   UTC time of the daily run (default 06:17, the Vercel cron's time)
//   DAILY_JOBS=off        don't schedule (use an external cron against /api/jobs/daily)
//
// It wakes every few minutes and runs the daily jobs when today's time has passed and
// today (UTC) has not been run. That also catches up after a restart or a sleeping
// free-tier instance: the first wake after the time runs it. The once-a-day claim
// itself lives in dailyJobs.ts.

import { dailyJobsState, runDailyJobs, utcDay } from "./dailyJobs.js";

const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 20_000;
export const DEFAULT_DAILY_AT = "06:17";

/** "HH:MM" (UTC) → minutes since midnight; undefined when malformed. */
export function parseDailyAt(raw: string | undefined): number | undefined {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((raw ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** Due when the UTC clock has reached `atMinutes` and today hasn't been run. */
export function isDailyRunDue(now: Date, lastRunDay: string | undefined, atMinutes: number): boolean {
  if (lastRunDay !== undefined && lastRunDay >= utcDay(now)) return false;
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= atMinutes;
}

export interface SchedulerHandle {
  stop(): void;
  /** One wake, for tests. */
  tick(): Promise<void>;
}

/** Returns undefined when scheduling is off (DAILY_JOBS=off, or on Vercel). */
export function startDailyScheduler(
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date; tickMs?: number; firstTickMs?: number; log?: (msg: string) => void } = {}
): SchedulerHandle | undefined {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (env.VERCEL) return undefined;
  if (/^(off|false|0|no)$/i.test(env.DAILY_JOBS?.trim() ?? "")) {
    log("[daily] scheduler off (DAILY_JOBS)");
    return undefined;
  }
  let at = parseDailyAt(env.DAILY_JOBS_AT);
  if (at === undefined) {
    if (env.DAILY_JOBS_AT?.trim()) log(`[daily] DAILY_JOBS_AT "${env.DAILY_JOBS_AT}" is not HH:MM; using ${DEFAULT_DAILY_AT}`);
    at = parseDailyAt(DEFAULT_DAILY_AT)!;
  }
  const now = opts.now ?? (() => new Date());
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { lastRunDay } = await dailyJobsState();
      if (!isDailyRunDue(now(), lastRunDay, at!)) return;
      const report = await runDailyJobs({ now: now() });
      if (report.ran) {
        const failed = report.results.filter((r) => !r.ok).map((r) => r.name);
        log(`[daily] ${report.day}: ran ${report.results.length} job(s)${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
      }
    } catch (err) {
      console.error("[daily] scheduler tick failed:", err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  // unref: the scheduler alone must not keep a finished process alive.
  const first = setTimeout(() => void tick(), opts.firstTickMs ?? FIRST_TICK_MS);
  const interval = setInterval(() => void tick(), opts.tickMs ?? TICK_MS);
  first.unref();
  interval.unref();
  const hh = String(Math.floor(at / 60)).padStart(2, "0");
  const mm = String(at % 60).padStart(2, "0");
  log(`[daily] scheduler on: daily jobs at ${hh}:${mm} UTC`);
  return {
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    },
    tick,
  };
}
