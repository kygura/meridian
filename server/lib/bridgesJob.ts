// The bridges' share of the daily jobs (ADR 0017, ADR 0016). Registered as the daily job
// "bridges", so the one scheduler (in-process on a long-running server, Vercel Cron through
// /api/jobs/daily) runs it with the watches and the re-plan check. server/app.ts imports this
// module so the job exists on every host. Each bridge decides for itself whether it has
// anything to do, and failures stay inside their own entry so one bridge never blocks the other.

import { runGmailDaily, type GmailDeps } from "./gmail/service.js";
import { runNotionDaily, type Deps as NotionDeps } from "./notion/service.js";
import { registerDailyJob } from "./dailyJobs.js";

export async function runBridgesJob(deps: { notion?: NotionDeps; gmail?: GmailDeps } = {}): Promise<{ notion: Record<string, unknown>; gmail: Record<string, unknown> }> {
  const guard = async (f: () => Promise<Record<string, unknown>>) => {
    try {
      return await f();
    } catch (err) {
      return { error: err instanceof Error ? err.message : "failed" };
    }
  };
  const [notion, gmail] = await Promise.all([guard(() => runNotionDaily(deps.notion)), guard(() => runGmailDaily(deps.gmail))]);
  return { notion, gmail };
}

registerDailyJob({ name: "bridges", run: () => runBridgesJob() });
