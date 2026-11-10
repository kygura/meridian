import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_ID, issueSession, sessionTtlMs, signingKey, verifySession } from "./session";
import { IMAGE_HOSTS, MAP_DATA_HOSTS, contentSecurityPolicy, originOf, securityHeaders } from "./securityHeaders";

beforeEach(() => {
  process.env.MERIDIAN_TOKEN = "the-password";
});
afterEach(() => {
  delete process.env.MERIDIAN_TOKEN;
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_TTL_DAYS;
});

describe("session tokens", () => {
  it("round-trips a session carrying a user id, a session id and an expiry", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const { token, session } = issueSession(OWNER_ID, now)!;
    expect(session).toMatchObject({ v: 1, uid: "owner", iat: now / 1000, exp: now / 1000 + 30 * 86400 });
    expect(session.sid).toMatch(/^[\w-]{20,}$/);
    expect(verifySession(token, now + 1000)).toEqual(session);
    expect(issueSession(OWNER_ID, now)!.session.sid).not.toBe(session.sid);
  });

  it("never contains the password or the signing key", () => {
    const { token } = issueSession()!;
    const decoded = token
      .split(".")
      .map((p) => Buffer.from(p, "base64url").toString("latin1"))
      .join("|");
    expect(token).not.toContain("the-password");
    expect(decoded).not.toContain("the-password");
    expect(decoded).not.toContain(signingKey()!.toString("latin1"));
  });

  it("rejects expiry, tampering, a different key, and junk", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const { token } = issueSession(OWNER_ID, now)!;
    expect(verifySession(token, now + sessionTtlMs())).toBeNull();
    expect(verifySession(token, now + sessionTtlMs() - 1000)).not.toBeNull();

    const [v, body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, uid: "owner", sid: "x", iat: 0, exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(`${v}.${forged}.${mac}`, now)).toBeNull();
    expect(verifySession(`${v}.${body}.${mac.slice(0, -1)}`, now)).toBeNull();
    expect(verifySession(`v2.${body}.${mac}`, now)).toBeNull();
    // Every other spelling of the last signature character is refused, including the ones
    // that decode to the same bytes (its low two bits are padding).
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (const ch of alphabet) {
      if (ch !== mac.at(-1)) expect(verifySession(`${v}.${body}.${mac.slice(0, -1)}${ch}`, now), ch).toBeNull();
    }
    for (const junk of [undefined, null, "", "a.b", "a.b.c.d", "x".repeat(5000)]) expect(verifySession(junk, now)).toBeNull();

    process.env.MERIDIAN_TOKEN = "another-password";
    expect(verifySession(token, now)).toBeNull();
  });

  it("derives the key from the password unless SESSION_SECRET is set; with neither there are no sessions", () => {
    const derived = signingKey()!;
    expect(derived).toHaveLength(32);
    expect(derived.equals(Buffer.from("the-password"))).toBe(false);
    process.env.SESSION_SECRET = "a-separate-secret";
    const separate = signingKey()!;
    expect(separate.equals(derived)).toBe(false);
    process.env.MERIDIAN_TOKEN = "changed";
    expect(signingKey()!.equals(separate)).toBe(true);

    delete process.env.SESSION_SECRET;
    delete process.env.MERIDIAN_TOKEN;
    expect(signingKey()).toBeNull();
    expect(issueSession()).toBeNull();
  });

  it("reads SESSION_TTL_DAYS within bounds", () => {
    process.env.SESSION_TTL_DAYS = "7";
    expect(sessionTtlMs()).toBe(7 * 86400_000);
    for (const bad of ["0", "-3", "9999", "soon"]) {
      process.env.SESSION_TTL_DAYS = bad;
      expect(sessionTtlMs()).toBe(30 * 86400_000);
    }
  });
});

describe("security headers", () => {
  it("allow only what the frontend loads", () => {
    const csp = contentSecurityPolicy();
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `))!;
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toBe("script-src 'self'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("style-src")).toContain("https://fonts.googleapis.com");
    expect(directive("font-src")).toContain("https://fonts.gstatic.com");
    expect(directive("worker-src")).toContain("blob:");
    for (const host of MAP_DATA_HOSTS) expect(directive("connect-src")).toContain(host);
    for (const host of IMAGE_HOSTS) expect(directive("img-src")).toContain(host);
    expect(csp).not.toContain("unsafe-eval");
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });

  it("adds the API origin to connect-src when the frontend calls another origin", () => {
    expect(contentSecurityPolicy({ apiOrigin: originOf("https://api.example.com/base/") })).toContain("https://api.example.com");
    expect(originOf("not a url")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });

  it("carries nosniff, a referrer policy and frame denial; HSTS in production", () => {
    const h = securityHeaders();
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ production: true })["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
  });
});
