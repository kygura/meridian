import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities } from "../lib/cities";
import notion, { setNotionDeps } from "./notion";

const TOKEN = "test-token";
const app = new Hono();
app.route("/api/notion", notion);
const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
  app.request(`/api/notion${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const CSV = `Window,Location,Season,Start,End,Notes\nLisbon dry,Lisbon,Peak,"May 1, 2026","Sep 30, 2026",invented\n`;
let TMP: string;
beforeAll(() => loadCities());
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-notion-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
});
afterEach(() => {
  setNotionDeps();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
});

describe("/api/notion", () => {
  it("is owner-only", async () => {
    expect((await call("GET", "/status", undefined, null)).status).toBe(401);
    expect((await call("POST", "/apply", { source: { kind: "api" } }, "wrong")).status).toBe(401);
  });
  it("status never reveals the token", async () => {
    process.env.NOTION_TOKEN = "secret_abc";
    const text = await (await call("GET", "/status")).text();
    expect(text).not.toContain("secret_abc");
    expect(JSON.parse(text).tokenSet).toBe(true);
    delete process.env.NOTION_TOKEN;
  });
  it("previews and applies an uploaded export, then says what to set when the API is unconfigured", async () => {
    const source = { kind: "upload", seasonsCsv: CSV };
    const prev = (await (await call("POST", "/preview", { source })).json()) as { plan: { digest: string; summary: { windowsAdded: number } } };
    expect(prev.plan.summary.windowsAdded).toBe(1);
    const applied = await call("POST", "/apply", { source, digest: prev.plan.digest });
    expect(applied.status).toBe(200);
    const stale = await call("POST", "/apply", { source: { kind: "upload", seasonsCsv: CSV + 'x,Lisbon,Avoid,"Jan 1, 2026","Jan 31, 2026",\n' }, digest: prev.plan.digest });
    expect(stale.status).toBe(409);
    const api = await call("POST", "/preview", { source: { kind: "api" } });
    expect(api.status).toBe(400);
    expect(((await api.json()) as { error: string }).error).toBe("not_configured");
  });
  it("validates input", async () => {
    expect((await call("POST", "/preview", { source: { kind: "ftp" } })).status).toBe(400);
    expect((await call("PUT", "/config", { daily: "yes" })).status).toBe(400);
    expect((await call("PUT", "/config", { daily: true })).status).toBe(200);
  });
});
