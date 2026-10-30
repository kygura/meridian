import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { gateRoutes, requireToken, tokenMatches } from "./auth";

function appWithGates() {
  const app = new Hono();
  gateRoutes(app);
  for (const p of ["/api/journal", "/api/replay", "/api/import", "/api/watches", "/api/bookings"]) {
    app.get(p, (c) => c.json({ ok: true }));
    app.get(`${p}/x`, (c) => c.json({ ok: true }));
  }
  return app;
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

afterEach(() => {
  delete process.env.MERIDIAN_TOKEN;
});

describe("requireToken", () => {
  it("fails closed with journal_locked when MERIDIAN_TOKEN is unset", async () => {
    const res = await appWithGates().request("/api/journal", auth("anything"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "journal_locked", reason: "token_not_configured" });
  });

  it("treats an empty MERIDIAN_TOKEN as unset", async () => {
    process.env.MERIDIAN_TOKEN = "";
    const res = await appWithGates().request("/api/journal", auth(""));
    expect((await res.json()).error).toBe("journal_locked");
  });

  it("401s a missing header, a wrong token, and a non-Bearer scheme", async () => {
    process.env.MERIDIAN_TOKEN = "s3cret";
    const app = appWithGates();
    for (const init of [{}, auth("wrong"), auth("s3cret-longer"), { headers: { Authorization: "Basic s3cret" } }]) {
      const res = await app.request("/api/journal", init);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("passes the right token (read at request time)", async () => {
    const app = appWithGates();
    process.env.MERIDIAN_TOKEN = "s3cret";
    expect((await app.request("/api/journal", auth("s3cret"))).status).toBe(200);
  });

  it("gates each prefix itself and its sub-paths", async () => {
    process.env.MERIDIAN_TOKEN = "s3cret";
    const app = appWithGates();
    for (const p of ["/api/journal", "/api/replay", "/api/import", "/api/watches"]) {
      for (const path of [p, `${p}/x`]) {
        expect((await app.request(path)).status, path).toBe(401);
        expect((await app.request(path, auth("s3cret"))).status, path).toBe(200);
      }
    }
  });

  it("does not gate /api/bookings (ruling R2)", async () => {
    process.env.MERIDIAN_TOKEN = "s3cret";
    const app = appWithGates();
    expect((await app.request("/api/bookings")).status).toBe(200);
    expect((await app.request("/api/bookings/x")).status).toBe(200);
  });

  it("works as plain middleware", async () => {
    process.env.MERIDIAN_TOKEN = "t";
    const app = new Hono();
    app.use("*", requireToken);
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/", auth("t"))).status).toBe(200);
  });
});

describe("tokenMatches", () => {
  it("compares regardless of length without throwing", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
  });
});
