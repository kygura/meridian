// Daily jobs: the one hook for work that should happen once a day (ADR 0016).
//
// Register a job from your own module, at import time:
//
//   import { registerDailyJob } from "./dailyJobs.js";
//   registerDailyJob({
//     name: "book-by-reminders",            // unique; registering the same name again replaces it
//     run: async ({ now }) => { ... },      // may return a small JSON summary for the report
//   });
//
// and make sure server/app.ts imports that module (so the job exists on every host).
//
// Who calls runDailyJobs():
// - a long-running Node server (Render, a VPS, `npm start`): the in-process scheduler
//   in scheduler.ts, started by server/index.ts;
// - Vercel: its cron, through GET /api/jobs/daily (server/vercel.ts never starts the
//   scheduler, and scheduler.ts refuses to start when VERCEL is set).
//
// Once a day, whoever asks: the run claims the UTC day in the document store
// (daily-jobs.json) inside a serialized update, so a scheduler tick, a cron call and a
// second instance on the same Postgres cannot all run it. `force` skips the claim.
// Jobs should still be idempotent per day (the watch run is: alert ids and Notice
// dedupe keys are derived from the day), because `force` and manual runs exist.
//
// Jobs run one after another; one throwing is recorded and does not stop the rest.

import { createJsonStore } from "./jsonStore.js";

export interface DailyJobContext {
  now: Date;
}

export interface DailyJob {
  name: string;
  run(ctx: DailyJobContext): Promise<unknown> | unknown;
}

export interface DailyJobResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Whatever the job returned, when it is small plain JSON. */
  result?: unknown;
}

export interface DailyRunReport {
  /** UTC day (YYYY-MM-DD) the run counts for. */
  day: string;
  /** False when today was already claimed and `force` was not set: nothing ran. */
  ran: boolean;
  results: DailyJobResult[];
}

interface DailyJobsFile {
  version: 1;
  lastRunDay?: string;
  lastRun?: { startedAt: string; finishedAt: string; results: DailyJobResult[] };
}
const store = createJsonStore<DailyJobsFile>("daily-jobs.json", () => ({ version: 1 }));

const jobs = new Map<string, DailyJob>();

export function registerDailyJob(job: DailyJob): void {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(job.name)) throw new Error(`daily job name "${job.name}" must be lower-case kebab-case`);
  jobs.set(job.name, job);
}

/** Test seam. */
export function unregisterDailyJob(name: string): void {
  jobs.delete(name);
}

export function listDailyJobs(): string[] {
  return [...jobs.keys()];
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function dailyJobsState(): Promise<{ lastRunDay?: string; lastRun?: DailyJobsFile["lastRun"] }> {
  const f = await store.read();
  return { lastRunDay: f.lastRunDay, lastRun: f.lastRun };
}

function summarize(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json.length <= 2000 ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
}

export async function runDailyJobs(opts: { now?: Date; force?: boolean } = {}): Promise<DailyRunReport> {
  const now = opts.now ?? new Date();
  const day = utcDay(now);
  const claimed = await store.update((f) => {
    if (!opts.force && f.lastRunDay !== undefined && f.lastRunDay >= day) return false;
    f.lastRunDay = day;
    return true;
  });
  if (!claimed) return { day, ran: false, results: [] };

  const results: DailyJobResult[] = [];
  for (const job of [...jobs.values()]) {
    const t0 = Date.now();
    try {
      const result = summarize(await job.run({ now }));
      results.push({ name: job.name, ok: true, ms: Date.now() - t0, ...(result !== undefined ? { result } : {}) });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.error(`[daily] ${job.name} failed: ${error}`);
      results.push({ name: job.name, ok: false, ms: Date.now() - t0, error });
    }
  }
  await store.update((f) => {
    f.lastRun = { startedAt: now.toISOString(), finishedAt: new Date().toISOString(), results };
  });
  return { day, ran: true, results };
}
