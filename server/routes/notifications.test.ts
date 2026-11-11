import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import notifications from "./notifications";
import jobs from "./jobs";
import { notify } from "../lib/notifier";
import { listPushSubscriptions } from "../lib/notify/webPush";
import { registerDailyJob, unregisterDailyJob } from "../lib/dailyJobs";
import { resetAuthMemory } from "../lib/authStore";

const TOKEN = "test-token";
let TMP: string;

const app = new Hono();
app.route("/api/notifications", notifications);
app.route("/api/jobs", jobs);


/** Wrong tokens count toward the store-backed lockout (ADR 0009); clear it between checks. */
function forgetWrongTokens() {
  rmSync(join(TMP, "auth.json"), { force: true });
  resetAuthMemory();
}
function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const CHANNEL_ENV = ["ALERT_WEBHOOK_URL", "NTFY_TOPIC", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "RESEND_API_KEY", "SMTP_URL", "ALERT_EMAIL_TO", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-notifications-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  for (const k of CHANNEL_ENV) delete process.env[k];
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
  for (const k of CHANNEL_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

function setVapid() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  process.env.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  process.env.VAPID_PRIVATE_KEY = privateKey.export({ format: "jwk" }).d!;
  process.env.VAPID_SUBJECT = "mailto:owner@example.com";
}
const SUB = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
};

describe("/api/notifications", () => {
  it("is token-gated on every path", async () => {
    for (const [m, p] of [
      ["GET", "/api/notifications"],
      ["GET", "/api/notifications/channels"],
      ["POST", "/api/notifications/test"],
      ["GET", "/api/notifications/push/key"],
      ["POST", "/api/notifications/push/subscribe"],
      ["GET", "/api/jobs/daily"],
    ] as const) {
      expect((await req(m, p, undefined, null)).status, p).toBe(401);
      expect((await req(m, p, undefined, "wrong")).status, p).toBe(401);
      forgetWrongTokens(); // each route is checked on its own, not after a lockout
    }
  });

  it("lists notices newest first with the unseen count, and marks seen", async () => {
    await notify({ kind: "test", title: "One", body: "", dedupeKey: "a" }, { now: () => new Date("2026-11-01T00:00:00Z") });
    const two = await notify({ kind: "test", title: "Two", body: "", dedupeKey: "b" }, { now: () => new Date("2026-11-02T00:00:00Z") });
    let data = await (await req("GET", "/api/notifications")).json();
    expect(data.notices.map((n: { title: string }) => n.title)).toEqual(["Two", "One"]);
    expect(data.unseen).toBe(2);
    expect((await req("POST", `/api/notifications/${two.notice.id}/seen`)).status).toBe(200);
    expect((await req("POST", "/api/notifications/nope/seen")).status).toBe(404);
    expect((await (await req("GET", "/api/notifications")).json()).unseen).toBe(1);
    expect(await (await req("POST", "/api/notifications/seen")).json()).toEqual({ marked: 1 });
    data = await (await req("GET", "/api/notifications")).json();
    expect(data.unseen).toBe(0);
  });

  it("reports channels without secrets", async () => {
    process.env.NTFY_TOPIC = "very-secret-topic";
    const { channels } = await (await req("GET", "/api/notifications/channels")).json();
    expect(channels.find((c: { id: string }) => c.id === "ntfy")).toEqual({ id: "ntfy", label: "ntfy", configured: true });
    expect(channels.find((c: { id: string }) => c.id === "webhook").configured).toBe(false);
    expect(JSON.stringify(channels)).not.toContain("very-secret-topic");
  });

  it("the test alert is logged, sent through configured channels, and reports each outcome", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/x";
    process.env.NTFY_TOPIC = "t";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => new Response("x", { status: String(u).includes("ntfy") ? 500 : 200 }));
    const res = await req("POST", "/api/notifications/test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deliveries).toMatchObject([
      { channel: "ntfy", ok: false, error: "ntfy responded 500" },
      { channel: "webhook", ok: true },
    ]);
    expect(f).toHaveBeenCalledTimes(2);
    // Each press is its own notice.
    await req("POST", "/api/notifications/test");
    expect((await (await req("GET", "/api/notifications")).json()).notices).toHaveLength(2);
  });

  it("push: 404 without keys; with keys, hands out the public key and stores and removes a subscription", async () => {
    expect((await req("GET", "/api/notifications/push/key")).status).toBe(404);
    expect((await req("POST", "/api/notifications/push/subscribe", SUB)).status).toBe(404);
    setVapid();
    expect(await (await req("GET", "/api/notifications/push/key")).json()).toEqual({ publicKey: process.env.VAPID_PUBLIC_KEY });
    expect((await req("POST", "/api/notifications/push/subscribe", { endpoint: "http://insecure", keys: SUB.keys })).status).toBe(400);
    expect((await req("POST", "/api/notifications/push/subscribe", SUB)).status).toBe(201);
    expect(await listPushSubscriptions()).toHaveLength(1);
    expect(await (await req("POST", "/api/notifications/push/unsubscribe", { endpoint: SUB.endpoint })).json()).toEqual({ ok: true, removed: true });
    expect((await req("POST", "/api/notifications/push/unsubscribe", {})).status).toBe(400);
    expect(await listPushSubscriptions()).toHaveLength(0);
  });
});

describe("/api/jobs", () => {
  it("runs the daily jobs once a day; force runs them again", async () => {
    const run = vi.fn(() => ({ n: 1 }));
    registerDailyJob({ name: "route-test", run });
    try {
      const listed = await (await req("GET", "/api/jobs")).json();
      expect(listed.jobs).toEqual(expect.arrayContaining(["watches", "route-test"]));
      const first = await (await req("GET", "/api/jobs/daily")).json();
      expect(first.ran).toBe(true);
      expect(first.results.find((r: { name: string }) => r.name === "watches")).toMatchObject({ ok: true, result: { watches: 0, alerts: 0 } });
      expect((await (await req("POST", "/api/jobs/daily")).json()).ran).toBe(false);
      expect((await (await req("POST", "/api/jobs/daily?force=1")).json()).ran).toBe(true);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      unregisterDailyJob("route-test");
    }
  });
});
