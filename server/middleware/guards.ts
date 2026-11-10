// Everything that stands between a request and the routes (ADR 0009), installed once
// by server/app.ts before any route is mounted:
//
//   1. security headers on every response
//   2. CORS for the origins allowed to call the API with the session cookie
//   3. CSRF: state-changing requests must come from one of those origins
//   4. owner gates and rate limits for routes that are not gated wholesale by
//      GATED_PREFIXES (bookings, the shortlist, the agent, news, flight search)

import type { Context, Hono, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { isProduction } from "../lib/session.js";
import { originOf, securityHeaders } from "../lib/securityHeaders.js";
import { readSessionCookie, requireOwner, requireOwnerWhen } from "./auth.js";
import { agentLimiter, flightSearchLimiter, newsLimiter } from "./rateLimit.js";

// ── Origins ──────────────────────────────────────────────────────────

/**
 * Outside production, any port on this machine: the Vite dev server proxies /api, so the
 * browser's Origin is the Vite port (5173, or the next free one), not the API's.
 */
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Extra origins allowed to call the API with credentials: MERIDIAN_ALLOWED_ORIGINS, comma-separated. */
export function allowedOrigins(): string[] {
  const configured = (process.env.MERIDIAN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => originOf(s.trim()))
    .filter((s): s is string => !!s);
  return configured;
}

/** Same origin as the request (Origin's host equals the Host header), or on the allow-list. */
export function originAllowed(c: Context, origin: string): boolean {
  const o = originOf(origin);
  if (!o) return false;
  const host = c.req.header("host");
  if (host && new URL(o).host === host.toLowerCase()) return true;
  if (!isProduction() && LOCAL_DEV_ORIGIN.test(o)) return true;
  return allowedOrigins().includes(o);
}

// ── CSRF ─────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The session cookie is sent by the browser on its own, so a state-changing request
 * must prove where it came from. Browsers put an Origin header on every such request;
 * it has to be this site or an allowed origin. Requests that authenticate with an
 * Authorization header are exempt: that header is never attached by a browser unasked.
 */
export const csrfProtection: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  if (c.req.header("Authorization") !== undefined) return next();
  const origin = c.req.header("Origin");
  if (origin !== undefined) {
    if (originAllowed(c, origin)) return next();
    return c.json({ error: "bad_origin", message: "This request came from another site." }, 403);
  }
  // No Origin: not a browser fetch. Refuse if it still claims a browser context or carries the cookie.
  const site = c.req.header("Sec-Fetch-Site");
  if ((site && site !== "same-origin" && site !== "none") || readSessionCookie(c)) {
    return c.json({ error: "bad_origin", message: "This request came from another site." }, 403);
  }
  return next();
};

// ── Paid providers ───────────────────────────────────────────────────

const hasAgentKey = () => !!process.env.ANTHROPIC_API_KEY;
const hasFlightKey = () => !!process.env.DUFFEL_API_KEY || !!process.env.SERPAPI_KEY;

/** Bookings hold passenger details: owner only. Search holds none, and is a free mock without provider keys. */
const bookingsGate: MiddlewareHandler = (c, next) =>
  c.req.path === "/api/bookings/search" ? requireOwnerWhen(hasFlightKey)(c, next) : requireOwner(c, next);

/** Apply a middleware to state-changing requests only. */
const onWrites =
  (mw: MiddlewareHandler): MiddlewareHandler =>
  (c, next) =>
    SAFE_METHODS.has(c.req.method) ? next() : mw(c, next);

export function installGuards(app: Hono): void {
  app.use("*", async (c, next) => {
    await next();
    const headers = securityHeaders({ production: isProduction(), apiOrigin: originOf(process.env.VITE_API_BASE_URL) });
    // App-wide defaults only: a route that set a stricter policy itself (the public share
    // pages: CSP default-src 'none', no-referrer) keeps it.
    for (const [name, value] of Object.entries(headers)) if (!c.res.headers.has(name)) c.header(name, value);
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => (originAllowed(c, origin) ? origin : null),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-Match"],
      maxAge: 600,
    })
  );
  app.use("/api/*", csrfProtection);

  app.use("/api/bookings/search", flightSearchLimiter.middleware);
  app.use("/api/bookings", bookingsGate);
  app.use("/api/bookings/*", bookingsGate);
  // The shortlist is the owner's saved places: personal data, reads included.
  app.use("/api/shortlist", requireOwner);
  app.use("/api/shortlist/*", requireOwner);
  // The agent: rate-limited always; owner only once it spends the Anthropic key.
  // GET /api/agent/models makes no model call and stays open.
  app.use("/api/agent/*", onWrites(agentLimiter.middleware));
  app.use("/api/agent/*", onWrites(requireOwnerWhen(hasAgentKey)));
  app.use("/api/news/brief", newsLimiter.middleware);
  app.use("/api/news/place", newsLimiter.middleware);
}
