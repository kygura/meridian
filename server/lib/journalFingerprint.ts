// Wires the fingerprint engine into the journal store (spec-journal §5/§6.3):
//  - every create/update schedules a full fingerprint AFTER the save (R8): the
//    save never waits on network. The background job persists via
//    mutateJourney only if the stored inputsHash still matches (no lost edits);
//    whenFingerprintsSettled() lets tests/callers await it;
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

/**
 * Persist only the derived fields (journey + per-stop fingerprint/observed) onto the
 * CURRENT stored journey, and only if its inputs still match. User-owned stop fields
 * that the inputsHash does not cover (lodging name/kind/provenance, stop provenance…)
 * are never replaced by the computation's older snapshot (R8: no lost edits).
 */
function persistDerived(next: Journey): Promise<Journey | undefined> {
  return mutateJourney(next.id, (current) => {
    if (computeInputsHash(current) !== next.fingerprint!.inputsHash || current.stops.length !== next.stops.length) return undefined;
    const stops = current.stops.map(({ observed: _o, fingerprint: _f, ...s }, i) => {
      const { observed, fingerprint } = next.stops[i]!;
      return { ...s, ...(observed ? { observed } : {}), ...(fingerprint ? { fingerprint } : {}) };
    });
    return { ...current, stops, fingerprint: next.fingerprint };
  });
}

/** Recompute + persist when needed. Only persists if the stored inputs still match (no lost edits). */
export async function ensureFingerprint(journey: Journey): Promise<Journey> {
  if (!needsRecompute(journey)) return journey;
  const next = await fingerprintJourney(journey);
  const saved = await persistDerived(next);
  return saved && saved.fingerprint?.inputsHash === next.fingerprint!.inputsHash ? saved : next;
}

const inFlight = new Set<Promise<void>>();

/** Resolves once every scheduled background fingerprint has finished. */
export async function whenFingerprintsSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/** Full fingerprint after the save lands; no time budget (no request is waiting). */
function scheduleFingerprint(journey: Journey): void {
  const snapshot: Journey = structuredClone(journey);
  const job = (async () => {
    // setTimeout(0) runs after the store write was enqueued (same FIFO chain), so
    // our mutateJourney is applied after the save.
    await new Promise((r) => setTimeout(r, 0));
    await persistDerived((await computeFingerprint(snapshot, depsFactory())).journey);
  })()
    .catch((err) => console.error("[journal] background fingerprint failed:", err))
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
}

let unregister: (() => void) | null = null;

/** Idempotent: registers the onJourneySaved listener once. */
export function registerJournalFingerprint(): () => void {
  if (!unregister) unregister = onJourneySaved((journey) => scheduleFingerprint(journey));
  return () => {
    unregister?.();
    unregister = null;
  };
}

