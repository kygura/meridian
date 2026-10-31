// Calls the shared journal client doesn't wrap yet. Token-gated like every watch route.
import { jfetch } from "../../../lib/journalApi";
import type { Alert } from "../../../types";

export interface WatchRunReport {
  watches: number;
  evaluated: number;
  alerts: Alert[];
  skipped: number;
  errors: unknown[];
}

/** POST /api/watches/run: check every active watch now. */
export function runWatchesNow(): Promise<WatchRunReport> {
  return jfetch<WatchRunReport>("/api/watches/run", { method: "POST" });
}
