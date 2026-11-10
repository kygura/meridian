// The whole app, as deployed: gates, sign-in, CSRF, CORS, rate limits and headers (ADR 0009).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import app from "./app";
import { GATED_PREFIXES } from "./middleware/auth";
import { resetRateLimits } from "./middleware/rateLimit";
import { LOCKOUT, resetAuthMemory } from "./lib/authStore";
import { SESSION_COOKIE, issueSession } from "./lib/session";

const TOKEN = "correct horse battery staple";
const ORIGIN = "http://localhost:5173";
let TMP = "";

const ENV_KEYS = [
  "MERIDIAN_TOKEN",
  "SESSION_SECRET",
  "SESSION_TTL_DAYS",
  "CRON_SECRET",
  "ANTHROPIC_API_KEY",
  "DUFFEL_API_KEY",
  "SERPAPI_KEY",
  "RATE_LIMIT",
  "NODE_ENV",
  "MERIDIAN_ALLOWED_ORIGINS",
  "TRUST_PROXY",
  "DATABASE_URL",
];
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  TMP = mkdtempSync(join(tmpdir(), "meridian-security-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  resetAuthMemory();
  resetRateLimits();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.DATA_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});

/** "name=value" from a Set-Cookie header. */
function cookiePair(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function login(password = TOKEN, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/auth/login", json({ password }, headers));
}

async function sessionCookie(): Promise<string> {
  const res = await login();
  expect(res.status).toBe(200);
  return cookiePair(res);
}

// One representative request per gated area. Sub-paths matter as much as the prefix itself.
const GATED_REQUESTS: Array<[string, string]> = [
  ...GATED_PREFIXES.flatMap((p): Array<[string, string]> => [
    ["GET", p],
    ["GET", `${p}/anything`],
    ["POST", p],
    ["DELETE", `${p}/anything`],
  ]),
  ["GET", "/api/bookings"],
  ["GET", "/api/bookings/bk_1"],
  ["POST", "/api/bookings"],
  ["DELETE", "/api/bookings/bk_1"],
  ["POST", "/api/shortlist"],
  ["DELETE", "/api/shortlist/lisbon"],
];

describe("gated routes", () => {
  it.each(GATED_REQUESTS)("%s %s is 401 without a session", async (method, path) => {
    const res = await app.request(path, { method, headers: { Origin: ORIGIN } });
    expect(res.status, `${method} ${path}`).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it.each(GATED_REQUESTS)("%s %s fails closed when no password is configured", async (method, path) => {
    delete process.env.MERIDIAN_TOKEN;
    const res = await app.request(path, { method, headers: { Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "journal_locked", reason: "token_not_configured" });
  });

  it.each(GATED_REQUESTS)("%s %s is 401 with a forged or foreign-key cookie", async (method, path) => {
    const real = issueSession()!.token;
    // Change the first character of the signature (the last one has spare bits; see session.test.ts).
    const cut = real.lastIndexOf(".") + 1;
    const tampered = `${real.slice(0, cut)}${real[cut] === "A" ? "B" : "A"}${real.slice(cut + 1)}`;
    process.env.SESSION_SECRET = "another-secret";
    const foreign = issueSession()!.token;
    delete process.env.SESSION_SECRET;
    for (const value of [tampered, foreign, "v1.e30.AAAA", "garbage"]) {
      const res = await app.request(path, { method, headers: { Origin: ORIGIN, Cookie: `${SESSION_COOKIE}=${value}` } });
      expect(res.status, value).toBe(401);
    }
  });

  it("opens every gated read to the session cookie and to the Bearer token", async () => {
    const cookie = await sessionCookie();
    for (const path of ["/api/journal", "/api/watches", "/api/trips", "/api/bookings", "/api/import/queue"]) {
      expect((await app.request(path, { headers: { Cookie: cookie } })).status, `cookie ${path}`).toBe(200);
      expect((await app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, `bearer ${path}`).toBe(200);
    }
  });

  it("leaves public reads open", async () => {
    for (const path of ["/api/health", "/api/shortlist", "/api/agent/models", "/api/cities?limit=1", "/api/auth/session"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it("a wrong Bearer token is not rescued by a valid cookie", async () => {
    const cookie = await sessionCookie();
    const res = await app.request("/api/journal", { headers: { Cookie: cookie, Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});

describe("sign-in", () => {
  it("sets an HttpOnly, SameSite=Lax, host-only cookie and reports the session", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ signedIn: true, user: { id: "owner" } });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86400_000);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^meridian_session=v1\./);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).not.toContain(TOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const who = await app.request("/api/auth/session", { headers: { Cookie: cookiePair(res) } });
    expect(await who.json()).toMatchObject({ configured: true, signedIn: true, user: { id: "owner" } });
  });

  it("marks the cookie Secure with the __Host- prefix in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await login(TOKEN, { Origin: "http://localhost", Host: "localhost" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-meridian_session=v1\./);
    expect(setCookie).toMatch(/Secure/i);
    expect((await app.request("/api/journal", { headers: { Cookie: cookiePair(res) } })).status).toBe(200);
  });

  it("rejects a wrong password, a missing one, and reports an unconfigured server", async () => {
    const wrong = await login("nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized", attemptsLeft: LOCKOUT.maxFailures - 1 });
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await app.request("/api/auth/login", json({}))).status).toBe(400);

    delete process.env.MERIDIAN_TOKEN;
    const off = await login();
    expect(off.status).toBe(401);
    expect(await off.json()).toEqual({ error: "journal_locked", reason: "token_not_configured" });
    expect(await (await app.request("/api/auth/session")).json()).toEqual({ configured: false, signedIn: false });
  });

  it("locks a client out after repeated wrong passwords, with Retry-After, even for the right one", async () => {
    for (let i = 0; i < LOCKOUT.maxFailures - 1; i++) expect((await login("nope")).status).toBe(401);
    const last = await login("nope");
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(await last.json()).toMatchObject({ error: "locked_out" });

    const right = await login();
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();

    // The lockout is kept in the document store, so it survives a restart of the process.
    resetAuthMemory();
    expect((await login()).status).toBe(429);

    // Automation is not locked out with the browser.
    expect((await app.request("/api/journal", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("lifts the lockout when it runs out, and a correct password clears the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < LOCKOUT.maxFailures; i++) await login("nope");
    expect((await login()).status).toBe(429);
    vi.setSystemTime(new Date(Date.parse("2026-01-01T00:00:00Z") + LOCKOUT.lockMs + 1000));
    expect((await login()).status).toBe(200);
    // Count cleared: a fresh run of near-misses does not lock immediately.
    for (let i = 0; i < LOCKOUT.maxFailures - 1; i++) expect((await login("nope")).status).toBe(401);
    expect((await login()).status).toBe(200);
  });

  it("counts clients separately when a trusted proxy reports their address", async () => {
    process.env.TRUST_PROXY = "1";
    for (let i = 0; i < LOCKOUT.maxFailures; i++) await login("nope", { "X-Forwarded-For": "203.0.113.9" });
    expect((await login(TOKEN, { "X-Forwarded-For": "203.0.113.9" })).status).toBe(429);
    expect((await login(TOKEN, { "X-Forwarded-For": "198.51.100.7" })).status).toBe(200);
    // A spoofed left-most entry does not help: the right-most hop is the one the proxy added.
    expect((await login(TOKEN, { "X-Forwarded-For": "198.51.100.7, 203.0.113.9" })).status).toBe(429);
  });

  it("pauses password sign-in for everyone after many failures overall", async () => {
    process.env.TRUST_PROXY = "1";
    for (let i = 0; i < LOCKOUT.maxFailuresOverall; i++) await login("nope", { "X-Forwarded-For": `10.0.0.${i}` });
    const res = await login(TOKEN, { "X-Forwarded-For": "192.0.2.200" });
    expect(res.status).toBe(429);
  });

  it("expires a session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    process.env.SESSION_TTL_DAYS = "1";
    const cookie = await sessionCookie();
    expect((await app.request("/api/journal", { headers: { Cookie: cookie } })).status).toBe(200);
    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));
    expect((await app.request("/api/journal", { headers: { Cookie: cookie } })).status).toBe(401);
    expect(await (await app.request("/api/auth/session", { headers: { Cookie: cookie } })).json()).toMatchObject({ signedIn: false });
  });

  it("renews an active session past half its life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const cookie = await sessionCookie();
    const early = await app.request("/api/journal", { headers: { Cookie: cookie } });
    expect(early.headers.get("set-cookie")).toBeNull();
    vi.setSystemTime(new Date("2026-01-20T00:00:00Z"));
    const late = await app.request("/api/journal", { headers: { Cookie: cookie } });
    expect(late.status).toBe(200);
    expect(late.headers.get("set-cookie")).toMatch(/^meridian_session=v1\..*Max-Age=2592000/);
  });

  it("signing out revokes the session on the server, not just in the browser", async () => {
    const cookie = await sessionCookie();
    const out = await app.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/meridian_session=;.*Max-Age=0/);
    // The old cookie value, replayed:
    expect((await app.request("/api/journal", { headers: { Cookie: cookie } })).status).toBe(401);
    // …also after a restart (the revocation is stored).
    resetAuthMemory();
    expect((await app.request("/api/journal", { headers: { Cookie: cookie } })).status).toBe(401);
    // A new sign-in works.
    expect((await app.request("/api/journal", { headers: { Cookie: await sessionCookie() } })).status).toBe(200);
  });

  it("changing the password ends sessions signed with the derived key; SESSION_SECRET keeps them", async () => {
    const cookie = await sessionCookie();
    process.env.MERIDIAN_TOKEN = "a new password";
    expect((await app.request("/api/journal", { headers: { Cookie: cookie } })).status).toBe(401);

    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.MERIDIAN_TOKEN = TOKEN;
    const stable = await sessionCookie();
    process.env.MERIDIAN_TOKEN = "a new password";
    expect((await app.request("/api/journal", { headers: { Cookie: stable } })).status).toBe(200);
  });
});

describe("automation", () => {
  it("accepts CRON_SECRET for GET /api/watches/run only", async () => {
    process.env.CRON_SECRET = "cron-only-secret";
    const cron = { headers: { Authorization: "Bearer cron-only-secret" } };
    expect((await app.request("/api/watches/run", cron)).status).toBe(200);
    expect((await app.request("/api/watches", cron)).status).toBe(401);
    expect((await app.request("/api/journal", cron)).status).toBe(401);
    expect((await app.request("/api/watches/run", { method: "POST", ...cron })).status).toBe(401);
  });

  it("still runs watches with the token as CRON_SECRET, and by POST with no Origin", async () => {
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    expect((await app.request("/api/watches/run", { headers: bearer })).status).toBe(200);
    expect((await app.request("/api/watches/run", { method: "POST", headers: bearer })).status).toBe(200);
  });

  it("does not let the cookie trigger the state-changing GET", async () => {
    const cookie = await sessionCookie();
    expect((await app.request("/api/watches/run", { headers: { Cookie: cookie } })).status).toBe(403);
    expect((await app.request("/api/watches/run", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } })).status).toBe(200);
  });

  it("slows a client that keeps presenting wrong Bearer tokens", async () => {
    process.env.RATE_LIMIT = "on";
    const bad = { headers: { Authorization: "Bearer guess" } };
    for (let i = 0; i < 20; i++) expect((await app.request("/api/journal", bad)).status).toBe(401);
    const res = await app.request("/api/journal", bad);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // While it waits, even the right token is refused from that address.
    expect((await app.request("/api/journal", { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(429);
  });
});

describe("CSRF and CORS", () => {
  it("refuses a state-changing request from another site, cookie or not", async () => {
    const cookie = await sessionCookie();
    const attempts: Record<string, string>[] = [
      { Cookie: cookie, Origin: "https://evil.example" },
      { Origin: "https://evil.example" },
      { Cookie: cookie, Origin: "null" },
      { Cookie: cookie }, // no Origin at all, but carrying the cookie
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of attempts) {
      const res = await app.request("/api/shortlist", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ error: "bad_origin" });
    }
  });

  it("accepts the same origin, the dev origin, and configured origins", async () => {
    const cookie = await sessionCookie();
    const post = (headers: Record<string, string>) =>
      app.request("http://meridian.example/api/watches/run", { method: "POST", headers: { Cookie: cookie, ...headers } });
    expect((await post({ Origin: "http://meridian.example", Host: "meridian.example" })).status).toBe(200);
    expect((await post({ Origin: "https://meridian.example", Host: "meridian.example" })).status).toBe(200);
    expect((await post({ Origin: ORIGIN })).status).toBe(200);
    expect((await post({ Origin: "http://localhost:5174" })).status).toBe(200); // Vite on its next free port
    expect((await post({ Origin: "http://localhost.evil.example:5173" })).status).toBe(403);
    expect((await post({ Origin: "https://localhost:5173" })).status).toBe(403);
    expect((await post({ Origin: "https://app.example" })).status).toBe(403);
    process.env.MERIDIAN_ALLOWED_ORIGINS = "https://app.example, https://other.example/";
    expect((await post({ Origin: "https://app.example" })).status).toBe(200);
    expect((await post({ Origin: "https://other.example" })).status).toBe(200);
  });

  it("drops the dev origins in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await app.request("/api/shortlist", { method: "POST", headers: { Origin: ORIGIN, Authorization: "" }, body: "{}" });
    // An empty Authorization header still counts as "presented", so CSRF steps aside and auth rejects it.
    expect(res.status).toBe(401);
    const noAuth = await app.request("/api/auth/logout", { method: "POST", headers: { Origin: ORIGIN } });
    expect(noAuth.status).toBe(403);
  });

  it("lets Bearer automation through without an Origin", async () => {
    const res = await app.request("/api/shortlist/nowhere", { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("answers CORS only for allowed origins, with credentials and never a wildcard", async () => {
    const ok = await app.request("/api/health", { headers: { Origin: ORIGIN } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");

    const evil = await app.request("/api/health", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await app.request("/api/journal", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("paid providers", () => {
  const agentPosts = ["/api/agent/chat", "/api/agent/research", "/api/agent/trip-options", "/api/agent/profile", "/api/agent/ticker"];

  it.each(agentPosts)("%s needs the owner once ANTHROPIC_API_KEY is set", async (path) => {
    process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
    const res = await app.request(path, json({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("keeps the keyless demo path open", async () => {
    const res = await app.request("/api/agent/ticker", json({}));
    expect(res.status).toBe(200);
    expect((await app.request("/api/agent/trip-options", json({}))).status).not.toBe(401);
  });

  it("rate-limits the agent per client, with Retry-After, keyless path included", async () => {
    process.env.RATE_LIMIT = "on";
    process.env.TRUST_PROXY = "1";
    const from = (ip: string) => app.request("/api/agent/ticker", json({}, { "X-Forwarded-For": ip }));
    for (let i = 0; i < 20; i++) expect((await from("203.0.113.1")).status).toBe(200);
    const res = await from("203.0.113.1");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "rate_limited", limit: "agent" });
    // Another client is unaffected, and reads of the model list are never counted.
    expect((await from("203.0.113.2")).status).toBe(200);
    expect((await app.request("/api/agent/models", { headers: { "X-Forwarded-For": "203.0.113.1" } })).status).toBe(200);
  });

  it("gates flight search once a flight provider key is set, and rate-limits it always", async () => {
    const search = (headers: Record<string, string> = {}) => app.request("/api/bookings/search", json({}, headers));
    expect((await search()).status).toBe(400); // open (keyless mock); the empty body is just invalid
    process.env.DUFFEL_API_KEY = "duffel_test_not_real";
    expect((await search()).status).toBe(401);
    expect((await search({ Cookie: await sessionCookie() })).status).toBe(400);
    delete process.env.DUFFEL_API_KEY;
    process.env.SERPAPI_KEY = "not-real";
    expect((await search()).status).toBe(401);

    process.env.RATE_LIMIT = "on";
    resetRateLimits();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await search()).status;
    expect(last).toBe(429);
  });

  it("rate-limits the news briefing before it does any work", async () => {
    process.env.RATE_LIMIT = "on";
    let res = await app.request("/api/news/brief?cityId=does-not-exist");
    expect(res.status).toBe(404);
    for (let i = 0; i < 30; i++) res = await app.request("/api/news/brief?cityId=does-not-exist");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("security headers", () => {
  it("are on API responses, errors included", async () => {
    for (const path of ["/api/health", "/api/journal", "/api/nope"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
  });

  it("adds HSTS in production only", async () => {
    expect((await app.request("/api/health")).headers.get("strict-transport-security")).toBeNull();
    process.env.NODE_ENV = "production";
    expect((await app.request("/api/health")).headers.get("strict-transport-security")).toBe("max-age=31536000");
  });
});
