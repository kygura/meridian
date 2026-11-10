// Owner gate for the personal-data routes (spec-journal D1, ruling R1; ADR 0009).
//
// Two ways in:
//   - the session cookie set by POST /api/auth/login (the browser), or
//   - "Authorization: Bearer $MERIDIAN_TOKEN" (automation: the import task, cron).
//     CRON_SECRET, when it differs from the token, is accepted for GET /api/watches/run and GET /api/jobs/daily only.
//
// Fail closed: with MERIDIAN_TOKEN unset (or empty) every gated route is 401
// `journal_locked`. The env var is read per request so tests (and a restart-free
// rotation) see the current value. Comparison hashes both sides to fixed-length
// digests and uses timingSafeEqual, so neither content nor length leaks via timing.
// A request that presents an Authorization header is judged on that header alone:
// a wrong token never falls back to the cookie.

import { createHash, timingSafeEqual } from "crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { clientIp } from "../lib/clientIp.js";
import { isRevoked } from "../lib/authStore.js";
import {
  OWNER_ID,
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  isProduction,
  issueSession,
  sessionCookieName,
  sessionTtlMs,
  verifySession,
  type Session,
} from "../lib/session.js";
import { createRateLimiter, tooManyRequests } from "./rateLimit.js";

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export interface Identity {
  /** Always "owner" today; the field exists so more users can follow. */
  userId: string;
  method: "bearer" | "cron" | "session";
  session?: Session;
}

type AuthFailure = { status: 401; body: { error: string; reason?: string } } | { status: 429; retryAfterSeconds: number };
export type AuthResult = { ok: true; identity: Identity } | ({ ok: false } & AuthFailure);

/** Wrong bearer tokens from one client before it has to wait. The token doubles as the password. */
export const bearerFailureLimiter = createRateLimiter({ name: "auth", limit: 20, windowMs: 15 * 60 * 1000 });

// ── Session cookie ───────────────────────────────────────────────────

/** Secure in production, and whenever the request reached the proxy over HTTPS. */
export function cookieIsSecure(c: Context): boolean {
  return isProduction() || c.req.header("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SECURE_SESSION_COOKIE) ?? getCookie(c, SESSION_COOKIE);
}

/** HttpOnly (scripts cannot read it), SameSite=Lax, host-only, Secure in production. */
export function setSessionCookie(c: Context, token: string, session: Session): void {
  const secure = cookieIsSecure(c);
  setCookie(c, sessionCookieName(secure), token, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge: Math.max(0, session.exp - Math.floor(Date.now() / 1000)),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, SECURE_SESSION_COOKIE, { path: "/", secure: true });
}

// ── Who is asking ────────────────────────────────────────────────────

const IDENTITY = "meridianIdentity";

async function resolve(c: Context): Promise<AuthResult> {
  const expected = process.env.MERIDIAN_TOKEN;
  if (!expected) return { ok: false, status: 401, body: { error: "journal_locked", reason: "token_not_configured" } };

  const header = c.req.header("Authorization");
  if (header !== undefined) {
    const ip = clientIp(c);
    const wait = bearerFailureLimiter.blocked(ip);
    if (!wait.ok) return { ok: false, status: 429, retryAfterSeconds: wait.retryAfterSeconds };
    const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1].trim();
    if (presented) {
      if (tokenMatches(presented, expected)) return { ok: true, identity: { userId: OWNER_ID, method: "bearer" } };
      const cron = process.env.CRON_SECRET;
      if (cron && c.req.method === "GET" && (c.req.path === "/api/watches/run" || c.req.path === "/api/jobs/daily") && tokenMatches(presented, cron)) {
        return { ok: true, identity: { userId: OWNER_ID, method: "cron" } };
      }
    }
    bearerFailureLimiter.take(ip);
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }

  const session = verifySession(readSessionCookie(c));
  if (session && !(await isRevoked(session.sid))) {
    // Sliding expiry: past half its life, an active session gets a fresh cookie.
    const ttl = sessionTtlMs();
    if (session.exp * 1000 - Date.now() < ttl / 2) {
      const renewed = issueSession(session.uid, Date.now(), session.sid);
      if (renewed) setSessionCookie(c, renewed.token, renewed.session);
    }
    return { ok: true, identity: { userId: session.uid, method: "session", session } };
  }
  return { ok: false, status: 401, body: { error: "unauthorized" } };
}

/** Who is asking, resolved once per request. Use on routes that are open but behave differently for the owner. */
export async function authenticate(c: Context): Promise<AuthResult> {
  const cached = c.get(IDENTITY as never) as AuthResult | undefined;
  if (cached) return cached;
  const result = await resolve(c);
  c.set(IDENTITY as never, result as never);
  return result;
}

/** The signed-in owner, or null. Never rejects the request. */
export async function ownerIdentity(c: Context): Promise<Identity | null> {
  const r = await authenticate(c);
  return r.ok ? r.identity : null;
}

function reject(c: Context, r: Extract<AuthResult, { ok: false }>) {
  if (r.status === 429) return tooManyRequests(c, "auth", r.retryAfterSeconds);
  return c.json(r.body, 401);
}

/** 401 unless the request carries the owner's session cookie or the Bearer token. */
export const requireOwner: MiddlewareHandler = async (c, next) => {
  const r = await authenticate(c);
  if (!r.ok) return reject(c, r);
  return next();
};

/** The gate's original name; routes still import it. */
export const requireToken = requireOwner;

/** Gate only while `when()` holds: for routes that spend a provider key when one is set, and are a free mock otherwise. */
export function requireOwnerWhen(when: () => boolean): MiddlewareHandler {
  return async (c, next) => (when() ? requireOwner(c, next) : next());
}

/** Gate everything except safe reads (GET, HEAD, OPTIONS). */
export const requireOwnerForWrites: MiddlewareHandler = async (c, next) =>
  ["GET", "HEAD", "OPTIONS"].includes(c.req.method) ? next() : requireOwner(c, next);

/** Route prefixes that hold personal data. /api/bookings is gated too, apart from the keyless
 *  mock search (see server/middleware/guards.ts; ADR 0009 replaces ruling R2). */
export const GATED_PREFIXES = ["/api/journal", "/api/replay", "/api/import", "/api/watches", "/api/trips"] as const;

/** Gate each prefix itself and everything under it. Call before mounting routes. */
export function gateRoutes(app: Hono, prefixes: readonly string[] = GATED_PREFIXES): void {
  for (const prefix of prefixes) {
    app.use(prefix, requireToken);
    app.use(`${prefix}/*`, requireToken);
  }
}
