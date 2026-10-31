import { useSyncExternalStore } from "react";
import { useMeridianStore } from "../store";
import {
  getToken,
  setToken as storeToken,
  clearToken,
  refreshBadges,
  TOKEN_KEY,
} from "../lib/journalApi";

// Journal token state for React. The token itself lives in lib/journalApi
// (localStorage "meridian.token", with an in-memory fallback). This module adds
// change notification so gated screens refetch the moment it changes.

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === null) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** Subscribe to token changes outside React. Returns an unsubscribe function. */
export function onJournalTokenChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Save a token that has already been verified, unlock, and refresh the nav badges. */
export function applyJournalToken(token: string): boolean {
  const persisted = storeToken(token);
  useMeridianStore.getState().setJournalLocked(false);
  emit();
  void refreshBadges();
  return persisted;
}

/** Forget the token and clear journal data held in memory. */
export function clearJournalToken(): void {
  clearToken();
  const s = useMeridianStore.getState();
  s.setJournalLocked(false);
  s.setJourneys(null);
  s.setImportPending(0);
  s.setAlerts([]);
  s.setWatches([]);
  emit();
}

export interface JournalTokenState {
  token: string | null;
  /** A token is saved and the server has not rejected it. Gate journal UI on this. */
  unlocked: boolean;
  /** "token_not_configured" when the server has no token set at all. */
  lockReason: "token_not_configured" | null;
  setToken: (token: string) => boolean;
  clear: () => void;
}

/**
 * Journal token for gated screens. Re-renders on unlock, lock and 401s. Refetch with
 *   const { token, unlocked } = useJournalToken();
 *   useEffect(() => { if (unlocked) load(); }, [token, unlocked]);
 */
export function useJournalToken(): JournalTokenState {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const locked = useMeridianStore((s) => s.journalLocked);
  const lockReason = useMeridianStore((s) => s.journalLockReason);
  return {
    token,
    unlocked: !!token && !locked,
    lockReason,
    setToken: applyJournalToken,
    clear: clearJournalToken,
  };
}
