// Bearer-token gate for the personal-data routes (spec-journal D1, ruling R1).
//
// Fail closed: with MERIDIAN_TOKEN unset (or empty) every gated route is 401
// `journal_locked`. The env var is read per request so tests (and a restart-free
// rotation) see the current value. Comparison hashes both sides to fixed-length
// digests and uses timingSafeEqual, so neither content nor length leaks via timing.

import { createHash, timingSafeEqual } from "crypto";
import type { Hono, MiddlewareHandler } from "hono";

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

export const requireToken: MiddlewareHandler = async (c, next) => {
  const expected = process.env.MERIDIAN_TOKEN;
  if (!expected) {
    return c.json({ error: "journal_locked", reason: "token_not_configured" }, 401);
  }
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "");
  if (!match || !tokenMatches(match[1].trim(), expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

/** Route prefixes that hold personal data. /api/bookings stays ungated (ruling R2). */
export const GATED_PREFIXES = ["/api/journal", "/api/replay", "/api/import", "/api/watches", "/api/trips"] as const;

/** Gate each prefix itself and everything under it. Call before mounting routes. */
export function gateRoutes(app: Hono, prefixes: readonly string[] = GATED_PREFIXES): void {
  for (const prefix of prefixes) {
    app.use(prefix, requireToken);
    app.use(`${prefix}/*`, requireToken);
  }
}
