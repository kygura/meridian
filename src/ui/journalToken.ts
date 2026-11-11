import { useSyncExternalStore } from "react";
import { useMeridianStore } from "../store";
import { getToken, TOKEN_KEY } from "../lib/journalApi";
import { checkSession, isSignedIn, onSessionChange, sessionEnded, signIn, signOut, syncSessionFromStorage } from "../lib/session";

// Owner session state for React (ADR 0009). The session itself is an HttpOnly cookie
// the browser keeps; lib/session tracks whether this browser is signed in. This module
// adds change notification so gated screens refetch the moment that changes. The names
// say "token" because screens were written against the old bearer token; no token is
// stored in the browser any more.

function subscribe(cb: () => void): () => void {
  const off = onSessionChange(cb);
  // Another tab signed in or out.
  const onStorage = (e: StorageEvent) => {
    if (e.key === TOKEN_KEY || e.key === null) syncSessionFromStorage();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    off();
    window.removeEventListener("storage", onStorage);
  };
}

if (typeof window !== "undefined") {
  // Bookings and the shortlist are owner-only: load them whenever a session starts (the nav badges follow the hook).
  onSessionChange(() => {
    if (isSignedIn()) {
      void useMeridianStore.getState().fetchBookings();
      void useMeridianStore.getState().fetchShortlist();
    }
  });
  // Confirm the cookie with the server once per page load.
  void checkSession();
}

/** Subscribe to sign-in / sign-out outside React. Returns an unsubscribe function. */
export function onJournalTokenChange(cb: () => void): () => void {
  return onSessionChange(cb);
}

/** Sign in with the owner password. Rejects with the errors of lib/session. */
export function signInOwner(password: string): Promise<void> {
  return signIn(password);
}

/** Sign out and clear the personal data held in memory. */
export function clearJournalToken(): void {
  const s = useMeridianStore.getState();
  s.setJourneys(null);
  s.setImportPending(0);
  s.setAlerts([]);
  s.setWatches([]);
  s.setBookings([]);
  s.setShortlist([]);
  void signOut();
}

export interface JournalTokenState {
  /** Changes with every sign-in; null when signed out. An effect dependency, not a credential. */
  token: string | null;
  /** Signed in and the server has not answered 401. Gate personal-data UI on this. */
  unlocked: boolean;
  /** "token_not_configured" when the server has no password set at all. */
  lockReason: "token_not_configured" | null;
  /** The server ended the session (it expired, or was signed out elsewhere). */
  sessionEnded: boolean;
  signIn: (password: string) => Promise<void>;
  /** Sign out. */
  clear: () => void;
}

/**
 * Owner session for gated screens. Re-renders on sign-in, sign-out and 401s. Refetch with
 *   const { token, unlocked } = useJournalToken();
 *   useEffect(() => { if (unlocked) load(); }, [token, unlocked]);
 */
export function useJournalToken(): JournalTokenState {
  const token = useSyncExternalStore(subscribe, getToken, () => null);
  const ended = useSyncExternalStore(subscribe, sessionEnded, () => false);
  const locked = useMeridianStore((s) => s.journalLocked);
  const lockReason = useMeridianStore((s) => s.journalLockReason);
  return {
    token,
    unlocked: !!token && !locked,
    lockReason,
    sessionEnded: ended,
    signIn: signInOwner,
    clear: clearJournalToken,
  };
}
