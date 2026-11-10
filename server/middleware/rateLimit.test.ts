import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRateLimiter, rateLimitEnabled } from "./rateLimit";
import { clientIp } from "../lib/clientIp";

beforeEach(() => {
  process.env.RATE_LIMIT = "on";
});
afterEach(() => {
  delete process.env.RATE_LIMIT;
  delete process.env.TRUST_PROXY;
  delete process.env.VERCEL;
});

describe("createRateLimiter", () => {
  it("allows `limit` requests per window per key, then says how long to wait", () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ name: "t", limit: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => rl.take("a").ok)).toEqual([true, true, true]);
    const over = rl.take("a");
    expect(over).toMatchObject({ ok: false, remaining: 0, retryAfterSeconds: 60 });
    expect(rl.take("b").ok).toBe(true);
    t += 30_000;
    expect(rl.take("a").retryAfterSeconds).toBe(30);
    t += 30_000;
    expect(rl.take("a")).toMatchObject({ ok: true, remaining: 2 });
  });

  it("caps all clients together when a global limit is set", () => {
    const t = 0;
    const rl = createRateLimiter({ name: "t", limit: 2, windowMs: 1000, globalLimit: 3, globalWindowMs: 10_000, now: () => t });
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("b").ok).toBe(true);
    expect(rl.take("c").ok).toBe(true);
    const res = rl.take("d");
    expect(res.ok).toBe(false);
    expect(res.retryAfterSeconds).toBe(10);
  });

  it("blocked() reports without counting", () => {
    const rl = createRateLimiter({ name: "t", limit: 1, windowMs: 1000, now: () => 0 });
    expect(rl.blocked("a").ok).toBe(true);
    expect(rl.blocked("a").ok).toBe(true);
    rl.take("a");
    expect(rl.blocked("a")).toMatchObject({ ok: false, retryAfterSeconds: 1 });
  });

  it("as middleware answers 429 with Retry-After and RateLimit headers", async () => {
    const rl = createRateLimiter({ name: "demo", limit: 1, windowMs: 60_000 });
    const app = new Hono();
    app.use("*", rl.middleware);
    app.get("/", (c) => c.text("ok"));
    const first = await app.request("/");
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-remaining")).toBe("0");
    const second = await app.request("/");
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(await second.json()).toMatchObject({ error: "rate_limited", limit: "demo", retryAfterSeconds: 60 });
  });

  it("is off under Vitest unless switched on, and RATE_LIMIT=off wins anywhere", () => {
    delete process.env.RATE_LIMIT;
    expect(rateLimitEnabled()).toBe(false);
    const rl = createRateLimiter({ name: "t", limit: 1, windowMs: 1000 });
    expect([rl.take("a").ok, rl.take("a").ok, rl.take("a").ok]).toEqual([true, true, true]);
    process.env.RATE_LIMIT = "off";
    expect(rateLimitEnabled()).toBe(false);
    process.env.RATE_LIMIT = "on";
    expect(rateLimitEnabled()).toBe(true);
  });
});

describe("clientIp", () => {
  const ipOf = async (headers: Record<string, string>, socket?: string) => {
    const app = new Hono();
    app.get("/", (c) => c.text(clientIp(c)));
    const env = socket ? { incoming: { socket: { remoteAddress: socket } } } : undefined;
    return (await app.request("/", { headers }, env)).text();
  };

  it("ignores forwarded headers unless a proxy is declared", async () => {
    expect(await ipOf({ "X-Forwarded-For": "1.2.3.4" }, "10.0.0.1")).toBe("10.0.0.1");
    expect(await ipOf({ "X-Forwarded-For": "1.2.3.4" })).toBe("unknown");
  });

  it("takes the entry the trusted proxy added, counting hops from the right", async () => {
    process.env.TRUST_PROXY = "1";
    expect(await ipOf({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4" }, "10.0.0.1")).toBe("1.2.3.4");
    process.env.TRUST_PROXY = "2";
    expect(await ipOf({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4, 172.16.0.1" }, "10.0.0.1")).toBe("1.2.3.4");
    expect(await ipOf({}, "10.0.0.1")).toBe("10.0.0.1");
  });

  it("trusts Vercel's own headers on Vercel", async () => {
    process.env.VERCEL = "1";
    expect(await ipOf({ "X-Real-Ip": "9.9.9.9", "X-Forwarded-For": "1.1.1.1" })).toBe("9.9.9.9");
  });
});
