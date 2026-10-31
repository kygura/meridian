// One-shot hand-off to Plan › Watches.
// - City panel "Watch prices": setWatchPrefill({ cityId }) — the watch is limited to that city.
// - Journey detail "Watch similar": setWatchPrefill({ journeyId, stopIndex }) — the watch
//   matches places like that trip (or that stop).
// The caller then navigates to #/plan/watches; the Watches screen takes the prefill on mount
// (and subscribes while mounted) and opens "Add watch" with it filled in. Taking clears it.

export interface WatchPrefill {
  /** Limit the watch to this city. */
  cityId?: string;
  /** Use this past trip as the template. */
  journeyId?: string;
  /** 0-based stop of journeyId; omitted for the whole trip. */
  stopIndex?: number;
}

let pending: WatchPrefill | null = null;
const listeners = new Set<(p: WatchPrefill | null) => void>();

export function setWatchPrefill(p: WatchPrefill | null): void {
  pending = p;
  for (const l of listeners) l(pending);
}

/** Read without clearing. */
export function peekWatchPrefill(): WatchPrefill | null {
  return pending;
}

/** Read and clear. */
export function takeWatchPrefill(): WatchPrefill | null {
  const p = pending;
  pending = null;
  return p;
}

/** Called with the new value whenever a prefill is set. Returns an unsubscribe function. */
export function onWatchPrefill(cb: (p: WatchPrefill | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
