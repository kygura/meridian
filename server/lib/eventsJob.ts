// The live events' share of the daily jobs (ADR 0021, ADR 0016). Registered as the daily
// job "events": the one scheduler (in-process on a long-running server, Vercel Cron
// through /api/jobs/daily) refreshes the live events (every source) with the watches and the bridges.
// server/app.ts imports this module so the job exists on every host.

import { registerDailyJob } from "./dailyJobs.js";
import { refreshLiveEvents } from "./liveEvents.js";

export async function runEventsJob(): Promise<{ events: number; sources: { id: string; ok: boolean; count: number; error?: string }[] }> {
  const file = await refreshLiveEvents();
  return {
    events: file.events.length,
    sources: file.sources.map((s) => ({ id: s.id, ok: s.ok, count: s.count, ...(s.error ? { error: s.error } : {}) })),
  };
}

registerDailyJob({ name: "events", run: () => runEventsJob() });
