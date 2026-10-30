// Shared replay execution: the real deps wiring (with its test seam) plus
// executeReplay(), used by POST /api/replay, watch runs and the agent's
// find_similar_windows tool so all three go through the same deps factory.

import { readFile } from "fs/promises";
import type { MeridianEvent, ReplayQuery, ReplayResponse } from "../../src/types.js";
import { getDataPath } from "./paths.js";
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
 * data/events.json — tolerant of a missing/corrupt file, array or {events}.
 * Replay matches events by month only and prices a month's next occurrence, so a one-off dated
 * event is kept only when it falls in that next occurrence (a 2028 eclipse must not tag 2027).
 */
export async function loadEvents(now: Date = new Date()): Promise<MeridianEvent[]> {
  try {
    const raw = JSON.parse(await readFile(getDataPath("events.json"), "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { events?: unknown })?.events;
    if (!Array.isArray(list)) return [];
    return (list as MeridianEvent[]).filter(
      (e) => e.recurring || !e.date || representativeDate(e.month, now).slice(0, 7) === e.date.slice(0, 7)
    );
  } catch {
    return [];
  }
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
