import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireToken } from "../middleware/auth.js";
import { GoogleError } from "../lib/gmail/google.js";
import { GmailSetupError, beginConnect, completeConnect, disconnect, getGmailStatus, syncGmail, type GmailDeps } from "../lib/gmail/service.js";

// In-app Gmail import (ADR 0017). Owner-only, including the OAuth callback: Google sends the
// browser back with the session cookie, and the single-use `state` ties the callback to a
// sign-in started here (its PKCE verifier never leaves the server).
const gmail = new Hono();
gmail.use("*", requireToken);

let testDeps: GmailDeps = {};
/** Test seam: mocked Google HTTP. */
export function setGmailDeps(d: GmailDeps = {}): void {
  testDeps = d;
}

/** GOOGLE_REDIRECT_URI when set (needed behind a proxy that hides the public address), else this request's origin. */
function redirectUri(c: Context): string {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || `${new URL(c.req.url).origin}/api/gmail/callback`;
}

function fail(c: Context, err: unknown) {
  if (err instanceof GmailSetupError) return c.json({ error: err.status === 409 ? "reconnect" : "not_configured", message: err.message }, err.status);
  if (err instanceof GoogleError) return c.json({ error: "google_error", message: err.message }, 502);
  console.error("[gmail] failed:", err instanceof Error ? err.message : err);
  return c.json({ error: "gmail_failed", message: "The Gmail request failed." }, 500);
}

gmail.get("/status", async (c) => c.json(await getGmailStatus(redirectUri(c))));

gmail.post("/connect", async (c) => {
  try {
    return c.json({ url: await beginConnect(redirectUri(c), testDeps) });
  } catch (err) {
    return fail(c, err);
  }
});

const callbackQuery = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(200) });
gmail.get("/callback", async (c) => {
  // Where the browser lands afterwards; the Inbox shows the connection.
  const done = (ok: boolean) => c.redirect(`/#/inbox${ok ? "" : "?gmail=error"}`);
  const q = callbackQuery.safeParse({ code: c.req.query("code"), state: c.req.query("state") });
  if (!q.success) return done(false); // the user declined, or Google sent an error
  try {
    await completeConnect(q.data.code, q.data.state, testDeps);
    return done(true);
  } catch (err) {
    console.error("[gmail] connect failed:", err instanceof Error ? err.message : err);
    return done(false);
  }
});

gmail.post("/disconnect", async (c) => {
  await disconnect(testDeps);
  return c.json({ ok: true });
});

const syncBody = z.object({ fromYear: z.number().int().min(2000).max(2100).optional() });
gmail.post("/sync", async (c) => {
  const p = syncBody.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "Invalid request", issues: p.error.issues }, 400);
  try {
    return c.json(await syncGmail({ ...testDeps, fromYear: p.data.fromYear }));
  } catch (err) {
    return fail(c, err);
  }
});

export default gmail;
