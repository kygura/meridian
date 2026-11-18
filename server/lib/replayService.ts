// Shared replay execution: the real deps wiring (with its test seam) plus
// executeReplay(), used by POST /api/replay, watch runs and the agent's
// find_similar_windows tool so all three go through the same deps factory.

import type { MeridianEvent, ReplayQuery, ReplayResponse } from "../../src/types.js";
import { getLiveEvents } from "./liveEvents.js";
import { toMoney } from "./fx.js";
import { getSettings, listJourneys } from "./journal.js";
import { ensureFingerprint } from "./journalFingerprint.js";
import { defaultReplayDeps, representativeDate, runReplay, type ReplayDeps } from "./replay.js";

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

/**
 * Every live event (see liveEvents.ts), dated ones from every year. Never
 * throws: when nothing is stored and the fetch fails the list is empty, and event
 * markers and tag constraints simply find nothing.
 */
export async function loadAllEvents(): Promise<MeridianEvent[]> {
  return getLiveEvents();
}

/**
 * Events for Replay. Replay matches events by month only and prices a month's next
 * occurrence, so a one-off dated event is kept only when it falls in that next
 * occurrence (a 2028 eclipse must not tag 2027).
 */
export async function loadEvents(now: Date = new Date()): Promise<MeridianEvent[]> {
  return (await loadAllEvents()).filter(
    (e) => e.recurring || !e.date || representativeDate(e.month, now).slice(0, 7) === e.date.slice(0, 7)
  );
}

/** Recompute the template journey's fingerprint if needed, then run the replay. Throws ReplayError. */
export async function executeReplay(query: ReplayQuery): Promise<ReplayResponse> {
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
  return runReplay(query, depsFactory({ journeys, settings, eurOf, events }));
}
