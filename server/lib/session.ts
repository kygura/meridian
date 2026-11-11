// Owner sessions (ADR 0009): a signed, self-contained cookie value.
//
//   v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
//
// The payload carries a user id (always "owner" today, so more users can follow
// without changing the format), a session id (what sign-out revokes) and issue / expiry
// times. Nothing secret is in it; the signature is what makes it trustworthy.
//
// The signing key comes from SESSION_SECRET. When that is unset it is derived from
// MERIDIAN_TOKEN with HMAC under a fixed label, so the cookie never contains or reveals
// the password, and changing the password ends every session. Set SESSION_SECRET to
// rotate sessions on their own.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const OWNER_ID = "owner";

export interface Session {
  v: 1;
  /** User id. */
  uid: string;
  /** Session id (random), revoked on sign-out. */
  sid: string;
  /** Issued at / expires at, epoch seconds. */
  iat: number;
  exp: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 30;

/** Session lifetime. SESSION_TTL_DAYS overrides the 30-day default (1 to 365). */
export function sessionTtlMs(): number {
  const n = Number(process.env.SESSION_TTL_DAYS);
  const days = Number.isFinite(n) && n >= 1 && n <= 365 ? n : DEFAULT_TTL_DAYS;
  return days * DAY_MS;
}

/** null when neither SESSION_SECRET nor MERIDIAN_TOKEN is set: no sessions can exist. */
export function signingKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return createHmac("sha256", secret).update("meridian/session-cookie/v1").digest();
  const token = process.env.MERIDIAN_TOKEN;
  if (!token) return null;
  const derived = createHmac("sha256", token).update("meridian/session-secret-from-token/v1").digest();
  return createHmac("sha256", derived).update("meridian/session-cookie/v1").digest();
}

function sign(body: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(`v1.${body}`).digest();
}

export function issueSession(uid: string = OWNER_ID, nowMs: number = Date.now(), sid?: string): { token: string; session: Session } | null {
  const key = signingKey();
  if (!key) return null;
  const iat = Math.floor(nowMs / 1000);
  const session: Session = {
    v: 1,
    uid,
    sid: sid ?? randomBytes(16).toString("base64url"),
    iat,
    exp: iat + Math.floor(sessionTtlMs() / 1000),
  };
  const body = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return { token: `v1.${body}.${sign(body, key).toString("base64url")}`, session };
}

/** The session when the signature is good and it has not expired; otherwise null. Revocation is checked separately. */
export function verifySession(token: string | undefined | null, nowMs: number = Date.now()): Session | null {
  if (!token || token.length > 1024) return null;
  const key = signingKey();
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, mac] = parts;
  let presented: Buffer;
  try {
    presented = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  const expected = sign(body, key);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  // One spelling per signature: base64url ignores the spare bits of the last character,
  // so without this a few altered cookies would decode to the same bytes and pass.
  if (presented.toString("base64url") !== mac) return null;
  let s: Partial<Session>;
  try {
    s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (s.v !== 1 || typeof s.uid !== "string" || !s.uid || typeof s.sid !== "string" || !s.sid) return null;
  if (typeof s.iat !== "number" || typeof s.exp !== "number") return null;
  if (s.exp * 1000 <= nowMs) return null;
  return s as Session;
}

// ── Cookie ───────────────────────────────────────────────────────────

/** Production deployments (Render and Vercel both set NODE_ENV=production). */
export function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL || !!process.env.RENDER;
}

/** The `__Host-` prefix makes the browser refuse the cookie unless it is Secure, host-only and Path=/. */
export const SESSION_COOKIE = "meridian_session";
export const SECURE_SESSION_COOKIE = "__Host-meridian_session";

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}
