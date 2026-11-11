// Server-side auth state (ADR 0009), kept in the document store so it survives a
// restart and is shared between serverless instances when DATABASE_URL is set:
//
//   revoked   session ids signed out before they expired
//   failures  failed password attempts, per client and overall, for the login lockout;
//             and, counted apart, wrong "Authorization: Bearer" tokens (the same secret)
//
// Client addresses are stored as a keyed hash, never as the address itself. If the
// store cannot be read or written, the same logic runs on an in-memory copy, so a
// storage outage weakens the lockout to "this process only" instead of removing it.

import { createHmac } from "crypto";
import { createJsonStore } from "./jsonStore.js";
import { signingKey } from "./session.js";

interface FailureEntry {
  count: number;
  /** Start of the counting window, epoch ms. */
  since: number;
  /** Locked until, epoch ms (0 = not locked). */
  lockedUntil: number;
}

interface AuthDoc {
  revoked: Record<string, number>;
  failures: Record<string, FailureEntry>;
}

const emptyDoc = (): AuthDoc => ({ revoked: {}, failures: {} });
const store = createJsonStore<AuthDoc>("auth.json", emptyDoc);
let memory: AuthDoc = emptyDoc();

function normalize(d: Partial<AuthDoc> | null | undefined): AuthDoc {
  const doc = (d ?? {}) as AuthDoc;
  doc.revoked ??= {};
  doc.failures ??= {};
  return doc;
}

async function load(): Promise<AuthDoc> {
  try {
    return normalize(await store.read());
  } catch (err) {
    console.error("[auth] could not read auth state, using memory:", (err as Error).message);
    return memory;
  }
}

async function mutate<R>(fn: (doc: AuthDoc) => R): Promise<R> {
  try {
    return await store.update((d) => fn(normalize(d)));
  } catch (err) {
    console.error("[auth] could not save auth state, using memory:", (err as Error).message);
    return fn(memory);
  }
}

// ── Revoked sessions ─────────────────────────────────────────────────

const REVOKED_CACHE_MS = 30_000;
/** Sessions signed out in this process: effective at once. */
const revokedHere = new Map<string, number>();
let revokedCache: { at: number; ids: Set<string> } | null = null;

/** Sign a session out everywhere. `expMs` is when it would have expired anyway. */
export async function revokeSession(sid: string, expMs: number, nowMs: number = Date.now()): Promise<void> {
  revokedHere.set(sid, expMs);
  revokedCache = null;
  await mutate((doc) => {
    for (const [id, exp] of Object.entries(doc.revoked)) if (exp <= nowMs) delete doc.revoked[id];
    doc.revoked[sid] = expMs;
  });
}

/** Other instances learn of a sign-out within REVOKED_CACHE_MS. */
export async function isRevoked(sid: string, nowMs: number = Date.now()): Promise<boolean> {
  if (revokedHere.has(sid)) return true;
  if (!revokedCache || nowMs - revokedCache.at > REVOKED_CACHE_MS) {
    const doc = await load();
    revokedCache = { at: nowMs, ids: new Set(Object.keys(doc.revoked)) };
  }
  return revokedCache.ids.has(sid);
}

// ── Login lockout ────────────────────────────────────────────────────

export const LOCKOUT = {
  /** Wrong passwords from one client before it is locked out. */
  maxFailures: 5,
  /** Wrong passwords from all clients together before every password login is paused. */
  maxFailuresOverall: 30,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
} as const;

/**
 * Which way in the guesses came: the sign-in form, or an Authorization header. Both test the
 * same secret, so both are counted in the store and capped overall; they are counted apart so
 * a browser lockout does not also stop the owner's automation (and the reverse).
 */
export type LockoutScope = "login" | "bearer";

const OVERALL_KEY: Record<LockoutScope, string> = { login: "*", bearer: "bearer:*" };
const MAX_FAILURE_KEYS = 2000;

/** Keyed hash of the client address; the raw address is never stored. */
function clientKey(ip: string, scope: LockoutScope): string {
  const key = signingKey() ?? Buffer.from("meridian");
  const h = createHmac("sha256", key).update(`login-client:${ip}`).digest("base64url").slice(0, 22);
  return scope === "login" ? h : `bearer:${h}`;
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number;
  /** Attempts this client has left before it is locked out. */
  attemptsLeft: number;
}

function stateOf(doc: AuthDoc, key: string, max: number, nowMs: number): LockoutState {
  const e = doc.failures[key];
  if (!e) return { locked: false, retryAfterSeconds: 0, attemptsLeft: max };
  if (e.lockedUntil > nowMs) {
    return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((e.lockedUntil - nowMs) / 1000)), attemptsLeft: 0 };
  }
  const live = nowMs - e.since < LOCKOUT.windowMs && e.lockedUntil === 0;
  return { locked: false, retryAfterSeconds: 0, attemptsLeft: live ? Math.max(0, max - e.count) : max };
}

function worst(a: LockoutState, b: LockoutState): LockoutState {
  if (a.locked || b.locked) {
    return { locked: true, retryAfterSeconds: Math.max(a.retryAfterSeconds, b.retryAfterSeconds), attemptsLeft: 0 };
  }
  return a;
}

/** Is this client (or password login as a whole) locked out right now? */
export async function lockoutState(ip: string, nowMs: number = Date.now(), scope: LockoutScope = "login"): Promise<LockoutState> {
  const doc = await load();
  return worst(stateOf(doc, clientKey(ip, scope), LOCKOUT.maxFailures, nowMs), stateOf(doc, OVERALL_KEY[scope], LOCKOUT.maxFailuresOverall, nowMs));
}

function bump(doc: AuthDoc, key: string, max: number, nowMs: number): void {
  let e = doc.failures[key];
  // A finished lock or an old window starts a fresh count.
  if (!e || nowMs - e.since >= LOCKOUT.windowMs || (e.lockedUntil !== 0 && e.lockedUntil <= nowMs)) {
    e = { count: 0, since: nowMs, lockedUntil: 0 };
  }
  e.count += 1;
  if (e.count >= max) e.lockedUntil = nowMs + LOCKOUT.lockMs;
  doc.failures[key] = e;
}

/** Count one wrong password. Returns the state after it. */
export async function recordLoginFailure(ip: string, nowMs: number = Date.now(), scope: LockoutScope = "login"): Promise<LockoutState> {
  const key = clientKey(ip, scope);
  const overall = OVERALL_KEY[scope];
  return mutate((doc) => {
    for (const [k, e] of Object.entries(doc.failures)) {
      if (Math.max(e.since + LOCKOUT.windowMs, e.lockedUntil) <= nowMs) delete doc.failures[k];
    }
    const keys = Object.keys(doc.failures);
    if (keys.length >= MAX_FAILURE_KEYS) for (const k of keys.slice(0, keys.length - MAX_FAILURE_KEYS + 1)) if (!Object.values(OVERALL_KEY).includes(k)) delete doc.failures[k];
    bump(doc, key, LOCKOUT.maxFailures, nowMs);
    bump(doc, overall, LOCKOUT.maxFailuresOverall, nowMs);
    return worst(stateOf(doc, key, LOCKOUT.maxFailures, nowMs), stateOf(doc, overall, LOCKOUT.maxFailuresOverall, nowMs));
  });
}

/** A correct password clears this client's count (not the overall one). */
export async function clearLoginFailures(ip: string, scope: LockoutScope = "login"): Promise<void> {
  const key = clientKey(ip, scope);
  const doc = await load();
  if (!doc.failures[key]) return;
  await mutate((d) => {
    delete d.failures[key];
  });
}

/** Test seam: forget in-process state (the store is the test's DATA_DIR). */
export function resetAuthMemory(): void {
  revokedHere.clear();
  revokedCache = null;
  memory = emptyDoc();
}
