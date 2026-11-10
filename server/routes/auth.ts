// /api/auth (ADR 0009): owner sign-in for the browser.
//
//   POST /login    { password }  → sets the session cookie. The password is MERIDIAN_TOKEN.
//   POST /logout                 → revokes the session and clears the cookie.
//   GET  /session                → { configured, signedIn, user, expiresAt }; never 401.
//
// Wrong passwords are counted per client and overall (server/lib/authStore.ts): after
// too many, sign-in answers 429 with Retry-After until the lock runs out. The Bearer
// token for automation is not affected by a lockout.

import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../lib/clientIp.js";
import { clearLoginFailures, lockoutState, recordLoginFailure, revokeSession } from "../lib/authStore.js";
import { OWNER_ID, issueSession, verifySession } from "../lib/session.js";
import { authenticate, clearSessionCookie, readSessionCookie, setSessionCookie, tokenMatches } from "../middleware/auth.js";

const auth = new Hono();

// Session answers are per browser and must never be cached.
auth.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

const loginSchema = z.object({ password: z.string().min(1).max(1024) });

function lockedOut(c: Parameters<typeof clientIp>[0], retryAfterSeconds: number) {
  c.header("Retry-After", String(retryAfterSeconds));
  return c.json(
    { error: "locked_out", retryAfterSeconds, message: "Too many wrong passwords. Try again later." },
    429
  );
}

auth.post("/login", async (c) => {
  const expected = process.env.MERIDIAN_TOKEN;
  if (!expected) return c.json({ error: "journal_locked", reason: "token_not_configured" }, 401);

  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);

  const ip = clientIp(c);
  const before = await lockoutState(ip);
  if (before.locked) return lockedOut(c, before.retryAfterSeconds);

  if (!tokenMatches(parsed.data.password, expected)) {
    const after = await recordLoginFailure(ip);
    if (after.locked) return lockedOut(c, after.retryAfterSeconds);
    return c.json({ error: "unauthorized", attemptsLeft: after.attemptsLeft }, 401);
  }

  const issued = issueSession(OWNER_ID);
  if (!issued) return c.json({ error: "journal_locked", reason: "token_not_configured" }, 401);
  await clearLoginFailures(ip);
  setSessionCookie(c, issued.token, issued.session);
  return c.json({ signedIn: true, user: { id: issued.session.uid }, expiresAt: new Date(issued.session.exp * 1000).toISOString() });
});

auth.post("/logout", async (c) => {
  const session = verifySession(readSessionCookie(c));
  if (session) await revokeSession(session.sid, session.exp * 1000);
  clearSessionCookie(c);
  return c.json({ signedIn: false });
});

auth.get("/session", async (c) => {
  const configured = !!process.env.MERIDIAN_TOKEN;
  const r = await authenticate(c);
  if (!r.ok) return c.json({ configured, signedIn: false });
  const exp = r.identity.session?.exp;
  return c.json({
    configured,
    signedIn: true,
    user: { id: r.identity.userId },
    ...(exp ? { expiresAt: new Date(exp * 1000).toISOString() } : {}),
  });
});

export default auth;
