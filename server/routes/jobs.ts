// /api/jobs: the daily job run for hosts with an external cron (ADR 0016). Token-gated.
//
//   GET|POST /api/jobs/daily           run today's daily jobs once (a second call the same UTC day is a no-op)
//   GET|POST /api/jobs/daily?force=1   run them again regardless
//   GET      /api/jobs                 registered jobs and the last run
//
// Vercel Cron calls GET with "Authorization: Bearer $CRON_SECRET" (set CRON_SECRET to the
// same value as MERIDIAN_TOKEN). A long-running Node server doesn't need this route: its
// own scheduler does the same work (server/lib/scheduler.ts).

import { Hono, type Context } from "hono";
import { requireToken } from "../middleware/auth.js";
import { dailyJobsState, listDailyJobs, registerDailyJob, runDailyJobs } from "../lib/dailyJobs.js";
import { executeReplay } from "../lib/replayService.js";
import { runWatches } from "../lib/watches.js";

// Built-in daily job: the watch run (spec-journal §10).
registerDailyJob({
  name: "watches",
  run: async ({ now }) => {
    const r = await runWatches({ now: () => now, replay: executeReplay });
    return { watches: r.watches, evaluated: r.evaluated, alerts: r.alerts.length, skipped: r.skipped, errors: r.errors.length };
  },
});

const jobs = new Hono();
jobs.use("*", requireToken);

jobs.get("/", async (c) => c.json({ jobs: listDailyJobs(), ...(await dailyJobsState()) }));

const runDaily = async (c: Context) => {
  try {
    return c.json(await runDailyJobs({ force: c.req.query("force") === "1" }));
  } catch (err) {
    console.error("[jobs] daily run failed:", err);
    return c.json({ error: "run_failed", message: "Could not run the daily jobs." }, 500);
  }
};
jobs.get("/daily", runDaily);
jobs.post("/daily", runDaily);

export default jobs;
