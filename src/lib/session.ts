// Owner session for the browser (ADR 0009).
//
// Signing in posts the password to /api/auth/login; the server answers with an
// HttpOnly session cookie that the browser attaches to every API call by itself.
// This code never sees the cookie and never stores the password. What it keeps in
// localStorage is one flag, "meridian.session" = "1", so a reload knows to show the
// signed-in screens straight away; the server remains the judge (a 401 signs out).

import { apiCredentials, apiUrl } from "./api";
import { useMeridianStore } from "../store";

/** Not a credential: only says "this browser signed in at some point". */
export const SESSION_FLAG_KEY = "meridian.session";
/** Where older versions kept the bearer token. Removed on first load. */
export const LEGACY_TOKEN_KEY = "meridian.token";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readFlag(): boolean {
  try {
    return storage()?.getItem(SESSION_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) storage()?.setItem(SESSION_FLAG_KEY, "1");
    else storage()?.removeItem(SESSION_FLAG_KEY);
  } catch {
    /* private window: the session still works until the tab closes */
  }
}

let signedIn = readFlag();
/** Bumped on every sign-in so effects keyed on the marker refetch. */
let epoch = 0;
let endedByServer = false;

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to sign-in / sign-out. Returns an unsubscribe function. */
export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isSignedIn(): boolean {
  return signedIn;
}

/**
 * An opaque marker that changes with every sign-in, or null when signed out.
 * It is not a credential and is never sent anywhere; screens use it as an effect dependency.
 */
export function sessionMarker(): string | null {
  return signedIn ? `session-${epoch}` : null;
}

/** True after the server ended the session (expired or signed out elsewhere), until the next sign-in. */
export function sessionEnded(): boolean {
  return endedByServer;
}

function markSignedIn(): void {
  signedIn = true;
  endedByServer = false;
  epoch += 1;
  writeFlag(true);
  useMeridianStore.getState().setJournalLocked(false);
  emit();
}

function markSignedOut(byServer: boolean): void {
  const was = signedIn;
  signedIn = false;
  endedByServer = byServer && was;
  writeFlag(false);
  if (was) emit();
}

/** A gated call answered 401: the session is gone. Called by jfetch and bookingApi. */
export function noteUnauthorized(reason?: "token_not_configured"): void {
  useMeridianStore.getState().setJournalLocked(true, reason ?? null);
  markSignedOut(true);
}

/** Another tab signed in or out (storage event on the flag). */
export function syncSessionFromStorage(): void {
  const now = readFlag();
  if (now === signedIn) return;
  if (now) markSignedIn();
  else markSignedOut(false);
}

// ── Errors ───────────────────────────────────────────────────────────

export class WrongPasswordError extends Error {
  attemptsLeft?: number;
  constructor(attemptsLeft?: number) {
    super("Wrong password");
    this.name = "WrongPasswordError";
    this.attemptsLeft = attemptsLeft;
  }
}

/** 429 from sign-in: too many wrong passwords. */
export class LockedOutError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Too many wrong passwords");
    this.name = "LockedOutError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The server has no MERIDIAN_TOKEN: nobody can sign in. */
export class SignInUnavailableError extends Error {
  constructor() {
    super("Sign-in is not switched on on this server");
    this.name = "SignInUnavailableError";
  }
}

export class SessionNetworkError extends Error {
  constructor() {
    super("Couldn't reach the server");
    this.name = "SessionNetworkError";
  }
}

/** "about 15 minutes", "1 minute", "30 seconds". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  const m = Math.ceil(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

// ── Calls ────────────────────────────────────────────────────────────

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; data: any; retryAfter: number }> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, credentials: apiCredentials });
  } catch {
    throw new SessionNetworkError();
  }
  const data: any = await res.json().catch(() => null);
  return { status: res.status, data, retryAfter: Number(res.headers.get("Retry-After")) || 0 };
}

/** Sign in with the owner password. Resolves once the session cookie is set. */
export async function signIn(password: string): Promise<void> {
  const { status, data, retryAfter } = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (status === 200 && data?.signedIn) return markSignedIn();
  if (status === 429) throw new LockedOutError(data?.retryAfterSeconds ?? retryAfter ?? 60);
  if (status === 401 && data?.reason === "token_not_configured") {
    useMeridianStore.getState().setJournalLocked(true, "token_not_configured");
    throw new SignInUnavailableError();
  }
  if (status === 401) throw new WrongPasswordError(typeof data?.attemptsLeft === "number" ? data.attemptsLeft : undefined);
  throw new SessionNetworkError();
}

/** End the session on the server and in this browser. The local state clears even if the request fails. */
export async function signOut(): Promise<void> {
  // Forget locally first, so nothing fires another gated call while the request is in flight.
  markSignedOut(false);
  useMeridianStore.getState().setJournalLocked(false);
  try {
    await call("/api/auth/logout", { method: "POST" });
  } catch {
    /* offline: the cookie stays until it expires, but this browser no longer acts signed in */
  }
}

let checked: Promise<void> | null = null;

/**
 * Ask the server once per page load whether the cookie is still good, and reconcile the flag.
 * Also clears the bearer token older versions left in localStorage, signing in with it first
 * so an owner who had unlocked this browser is not asked again.
 */
export function checkSession(): Promise<void> {
  checked ??= (async () => {
    let legacy: string | null = null;
    try {
      legacy = storage()?.getItem(LEGACY_TOKEN_KEY) ?? null;
      if (legacy !== null) storage()?.removeItem(LEGACY_TOKEN_KEY);
    } catch {
      /* nothing stored */
    }
    try {
      const { status, data } = await call("/api/auth/session");
      if (status !== 200 || !data) return;
      if (data.configured === false) {
        useMeridianStore.getState().setJournalLocked(true, "token_not_configured");
        markSignedOut(false);
        return;
      }
      if (data.signedIn) {
        if (!signedIn) markSignedIn();
        return;
      }
      if (legacy) {
        try {
          await signIn(legacy);
          return;
        } catch {
          /* the old token no longer works: fall through to signed out */
        }
      }
      markSignedOut(signedIn);
    } catch {
      /* offline: keep what the flag says; the next gated call decides */
    }
  })();
  return checked;
}

/** Test seam. */
export function resetSessionForTests(state: { signedIn?: boolean } = {}): void {
  signedIn = state.signedIn ?? false;
  endedByServer = false;
  epoch = 0;
  checked = null;
  listeners.clear();
}
