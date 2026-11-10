// In-process rate limiter (ADR 0009): fixed windows per client address, plus an
// optional cap across all clients so rotating addresses cannot run up a provider bill.
//
// State lives in this process. On one long-running server (Render, local) that is the
// whole picture; on serverless each warm instance keeps its own counters, so the limits
// there are per instance and reset on a cold start. It needs no store and adds no latency.
//
// Under Vitest the limiter is off unless RATE_LIMIT=on, so route tests can hammer a
// route. RATE_LIMIT=off switches it off anywhere (local load tests).

import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "../lib/clientIp.js";

export interface RateLimitOptions {
  /** Names the bucket in the 429 body and keeps limiters apart. */
  name: string;
  /** Requests allowed per client per window. */
  limit: number;
  windowMs: number;
  /** Requests allowed across all clients per `globalWindowMs` (default: windowMs). */
  globalLimit?: number;
  globalWindowMs?: number;
  now?: () => number;
}

export interface RateLimitVerdict {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller may try again (0 when ok). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Count one request for this key and say whether it is allowed. */
  take(key: string): RateLimitVerdict;
  /** Whether this key is already over its limit, without counting a request. */
  blocked(key: string): RateLimitVerdict;
  middleware: MiddlewareHandler;
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 10_000;
const limiters = new Set<RateLimiter>();

export function rateLimitEnabled(): boolean {
  const flag = process.env.RATE_LIMIT?.trim().toLowerCase();
  if (flag === "off") return false;
  if (process.env.VITEST) return flag === "on";
  return true;
}

function hit(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number, now: number): RateLimitVerdict {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      // Still full of live keys: drop the oldest so memory stays bounded.
      if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value!);
    }
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  const ok = b.count <= limit;
  return {
    ok,
    limit,
    remaining: Math.max(0, limit - b.count),
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const perClient = new Map<string, Bucket>();
  const global = new Map<string, Bucket>();
  const now = opts.now ?? Date.now;

  const take = (key: string): RateLimitVerdict => {
    if (!rateLimitEnabled()) return { ok: true, limit: opts.limit, remaining: opts.limit, retryAfterSeconds: 0 };
    const t = now();
    const mine = hit(perClient, key, opts.limit, opts.windowMs, t);
    if (!mine.ok || opts.globalLimit === undefined) return mine;
    const all = hit(global, "*", opts.globalLimit, opts.globalWindowMs ?? opts.windowMs, t);
    return all.ok ? mine : { ...all, remaining: 0 };
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const v = take(clientIp(c));
    c.header("RateLimit-Limit", String(v.limit));
    c.header("RateLimit-Remaining", String(v.remaining));
    if (!v.ok) return tooManyRequests(c, opts.name, v.retryAfterSeconds);
    return next();
  };

  const blocked = (key: string): RateLimitVerdict => {
    const t = now();
    const b = rateLimitEnabled() ? perClient.get(key) : undefined;
    const over = !!b && b.resetAt > t && b.count >= opts.limit;
    return {
      ok: !over,
      limit: opts.limit,
      remaining: b && b.resetAt > t ? Math.max(0, opts.limit - b.count) : opts.limit,
      retryAfterSeconds: over ? Math.max(1, Math.ceil((b!.resetAt - t) / 1000)) : 0,
    };
  };

  const limiter: RateLimiter = {
    take,
    blocked,
    middleware,
    reset: () => {
      perClient.clear();
      global.clear();
    },
  };
  limiters.add(limiter);
  return limiter;
}

export function tooManyRequests(c: Context, name: string, retryAfterSeconds: number) {
  c.header("Retry-After", String(retryAfterSeconds));
  return c.json(
    { error: "rate_limited", limit: name, retryAfterSeconds, message: "Too many requests. Try again shortly." },
    429
  );
}

/** Test seam: forget every counter. */
export function resetRateLimits(): void {
  for (const l of limiters) l.reset();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Limits for the routes that call a paid or quota-bound provider. One person using the
// app stays far below them; a script does not.
/** Ask, research, trip ideas, profile, ticker: Claude when ANTHROPIC_API_KEY is set. */
export const agentLimiter = createRateLimiter({ name: "agent", limit: 20, windowMs: MINUTE, globalLimit: 600, globalWindowMs: HOUR });
/** City news briefing (Claude Haiku with a key) and the news search behind it. */
export const newsLimiter = createRateLimiter({ name: "news", limit: 30, windowMs: MINUTE, globalLimit: 900, globalWindowMs: HOUR });
/** Flight search: Duffel / SerpAPI when their keys are set. */
export const flightSearchLimiter = createRateLimiter({ name: "flight_search", limit: 20, windowMs: MINUTE, globalLimit: 600, globalWindowMs: HOUR });
/** Seasonality fetched on demand from Open-Meteo for a city missing from the dataset. Counted per fetch, not per request. */
export const seasonalityFetchLimiter = createRateLimiter({ name: "seasonality_fetch", limit: 30, windowMs: MINUTE, globalLimit: 600, globalWindowMs: HOUR });
