import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities } from "../lib/cities";
import { GMAIL_SCOPE } from "../lib/gmail/google";
import { runBridgesJob } from "../lib/bridgesJob";
import gmail, { setGmailDeps } from "./gmail";

const TOKEN = "test-token";
const app = new Hono();
app.route("/api/gmail", gmail);
const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  app.request(`https://meridian.test/api/gmail${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let TMP: string;
beforeAll(() => loadCities());
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-gmail-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
});
afterEach(() => {
  setGmailDeps();
  rmSync(TMP, { recursive: true, force: true });
  for (const k of ["DATA_DIR", "MERIDIAN_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_TOKEN_KEY", "GOOGLE_REDIRECT_URI"]) delete process.env[k];
});

const configure = () => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  process.env.GMAIL_TOKEN_KEY = "k".repeat(40);
};

describe("/api/gmail", () => {
  it("is owner-only, including the callback", async () => {
    for (const [m, p] of [["GET", "/status"], ["POST", "/connect"], ["GET", "/callback?code=a&state=b"], ["POST", "/disconnect"], ["POST", "/sync"]] as const) {
      expect((await call(m, p, undefined, null)).status, `${m} ${p}`).toBe(401);
    }
  });
  it("explains what to set when unconfigured, and the upload path is untouched", async () => {
    const s = (await (await call("GET", "/status")).json()) as { configured: boolean; missing: string[]; redirectUri: string };
    expect(s).toMatchObject({ configured: false, missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_TOKEN_KEY"], redirectUri: "https://meridian.test/api/gmail/callback" });
    const c = await call("POST", "/connect");
    expect(c.status).toBe(400);
    expect(((await c.json()) as { message: string }).message).toContain("GOOGLE_CLIENT_ID");
  });
  it("connect returns Google's consent URL; the redirect URI can be set explicitly", async () => {
    configure();
    process.env.GOOGLE_REDIRECT_URI = "https://app.example/api/gmail/callback";
    const { url } = (await (await call("POST", "/connect")).json()) as { url: string };
    const u = new URL(url);
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example/api/gmail/callback");
    expect(u.searchParams.get("scope")).toBe(GMAIL_SCOPE);
  });
  it("callback redirects to the inbox, with an error flag when the state is unknown or Google reported a problem", async () => {
    configure();
    const bad = await call("GET", "/callback?code=x&state=forged");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("/#/inbox?gmail=error");
    const denied = await call("GET", "/callback?error=access_denied&state=s");
    expect(denied.headers.get("location")).toBe("/#/inbox?gmail=error");
  });
  it("sync without a connection is a clear 400; the daily bridges job reports skips and never throws", async () => {
    configure();
    expect((await call("POST", "/sync")).status).toBe(400);
    expect(await runBridgesJob()).toEqual({ notion: { skipped: "no NOTION_TOKEN" }, gmail: { skipped: "not connected" } });
  });
});
