// The bridges' share of the daily job (ADR 0017). The daily job is the existing
// POST/GET /api/watches/run, called once a day by a cron; it calls this after the watches.
// Each bridge decides for itself whether it has anything to do, and failures stay inside
// their own entry so one bridge never blocks the watches or the other bridge.

import { runGmailDaily, type GmailDeps } from "./gmail/service.js";
import { runNotionDaily, type Deps as NotionDeps } from "./notion/service.js";

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
