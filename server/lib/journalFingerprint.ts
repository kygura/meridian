// Wires the fingerprint engine into the journal store (spec-journal §5/§6.3):
//  - every create/update computes the fingerprint before persisting
//    (onJourneySaved), within a time budget so a slow/blocked Open-Meteo never
//    holds a save for long — weather that misses the budget stays "pending";
//  - ensureFingerprint() recomputes a stored journey when its inputs changed or
//    a dim is still pending, and persists the result.
// Side-effect free: server/index.ts calls registerJournalFingerprint() at startup.

import type { Journey } from "../../src/types.js";
import { computeFingerprint, computeInputsHash, defaultFingerprintDeps, needsRecompute, type FingerprintDeps } from "./fingerprint.js";
import { crowdProxyForMonth } from "./crowd.js";
import { mutateJourney, onJourneySaved } from "./journal.js";

export const FINGERPRINT_BUDGET_MS = 8_000;

let depsFactory: () => FingerprintDeps = () => defaultFingerprintDeps();
let budgetMs = FINGERPRINT_BUDGET_MS;

/** Test seam: inject fingerprint deps (and optionally a budget); no args restores the real ones. */
export function setFingerprintDepsFactory(factory?: () => FingerprintDeps, budget?: number): void {
  depsFactory = factory ?? (() => defaultFingerprintDeps());
  budgetMs = budget ?? FINGERPRINT_BUDGET_MS;
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((r) => setTimeout(() => r("timeout"), Math.max(0, ms)).unref?.());
}

/**
 * Same deps, bounded by one shared deadline. A weather fetch past the deadline
 * resolves as {ok:false, reason:"timeout"} → pending (the fetch keeps running
 * and fills the on-disk cache for the next recompute). A crowd lookup past the
 * deadline falls back to the cache-only peak index (flagged).
 */
export function withBudget(deps: FingerprintDeps, ms: number): FingerprintDeps {
  const deadline = Date.now() + ms;
  const left = () => deadline - Date.now();
  return {
    ...deps,
    observedWeather: async (cityId, arrive, depart) => {
      const r = await Promise.race([deps.observedWeather(cityId, arrive, depart), timeout(left())]);
      return r === "timeout" ? { ok: false, reason: "timeout" } : r;
    },
    crowd: async (cityId, month, range) => {
      const r = await Promise.race([deps.crowd(cityId, month, range), timeout(left())]);
      return r === "timeout" ? crowdProxyForMonth(cityId, month) : r;
    },
  };
}

export async function fingerprintJourney(journey: Journey): Promise<Journey> {
  return (await computeFingerprint(journey, withBudget(depsFactory(), budgetMs))).journey;
}

/** Recompute + persist when needed. Only persists if the stored inputs still match (no lost edits). */
export async function ensureFingerprint(journey: Journey): Promise<Journey> {
  if (!needsRecompute(journey)) return journey;
  const next = await fingerprintJourney(journey);
  const saved = await mutateJourney(journey.id, (current) =>
    computeInputsHash(current) === next.fingerprint!.inputsHash ? { ...current, stops: next.stops, fingerprint: next.fingerprint } : undefined
  );
  return saved && saved.fingerprint?.inputsHash === next.fingerprint!.inputsHash ? saved : next;
}

let unregister: (() => void) | null = null;

/** Idempotent: registers the onJourneySaved listener once. */
export function registerJournalFingerprint(): () => void {
  if (!unregister) {
    unregister = onJourneySaved(async (journey) => {
      const next = await fingerprintJourney(journey);
      journey.stops = next.stops;
      journey.fingerprint = next.fingerprint;
    });
  }
  return () => {
    unregister?.();
    unregister = null;
  };
}

