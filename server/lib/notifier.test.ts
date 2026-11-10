import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_NOTICES, listNotices, markAllNoticesSeen, markNoticeSeen, notify, noticeId, publicBaseUrl } from "./notifier";
import { CHANNELS, channelStatuses, type Channel, type OutboundNotice } from "./notify/channels";
import { savePushSubscription, listPushSubscriptions } from "./notify/webPush";

let TMP: string;
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-notifier-"));
  process.env.DATA_DIR = TMP;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.restoreAllMocks();
});

const input = (over: Record<string, unknown> = {}) => ({ kind: "test", title: "Hello", body: "World", url: "/#/plan/watches", dedupeKey: "k1", ...over });

function fake(id: string, impl: (n: OutboundNotice) => Promise<void> = async () => undefined, configured = true): Channel & { sent: OutboundNotice[] } {
  const sent: OutboundNotice[] = [];
  return {
    id,
    label: id,
    sent,
    status: () => ({ configured }),
    send: async (n) => {
      sent.push(n);
      await impl(n);
    },
  };
}

describe("notify", () => {
  it("logs the notice with no channel configured, so the in-app list always has it", async () => {
    const r = await notify(input(), { env: {} });
    expect(r).toMatchObject({ deduped: false, deliveries: [] });
    expect(r.notice).toMatchObject({ id: noticeId("k1"), kind: "test", title: "Hello", body: "World", url: "/#/plan/watches", seen: false });
    expect(await listNotices()).toHaveLength(1);
  });

  it("dedupes on dedupeKey: the second call sends nothing and returns the first notice", async () => {
    const ch = fake("a");
    const first = await notify(input(), { channels: [ch], env: {} });
    const second = await notify(input({ title: "Different words" }), { channels: [ch], env: {} });
    expect(second.deduped).toBe(true);
    expect(second.notice.id).toBe(first.notice.id);
    expect(second.notice.title).toBe("Hello");
    expect(ch.sent).toHaveLength(1);
    expect(await listNotices()).toHaveLength(1);
  });

  it("concurrent calls with one key send once", async () => {
    const ch = fake("a");
    const results = await Promise.all(Array.from({ length: 8 }, () => notify(input(), { channels: [ch], env: {} })));
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
    expect(ch.sent).toHaveLength(1);
  });

  it("channels fail independently and the outcome of each is persisted", async () => {
    const good = fake("good");
    const bad = fake("bad", async () => {
      throw new Error("boom");
    });
    const off = fake("off", async () => undefined, false);
    const r = await notify(input(), { channels: [bad, good, off], env: {} });
    expect(r.deliveries.map((d) => [d.channel, d.ok, d.error])).toEqual([
      ["bad", false, "boom"],
      ["good", true, undefined],
    ]);
    expect(good.sent).toHaveLength(1);
    expect(off.sent).toHaveLength(0);
    expect((await listNotices())[0].deliveries.map((d) => d.channel)).toEqual(["bad", "good"]);
  });

  it("a channel that hangs is cut off by its own timeout without holding back the others", async () => {
    const slow: Channel = {
      id: "slow",
      label: "slow",
      status: () => ({ configured: true }),
      send: (_n, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    };
    const good = fake("good");
    const r = await notify(input(), { channels: [slow, good], env: {}, timeoutMs: 30 });
    expect(r.deliveries).toMatchObject([
      { channel: "slow", ok: false, error: "timed out" },
      { channel: "good", ok: true },
    ]);
  });

  it("gives channels an absolute link when the public URL is known, and the app path for push", async () => {
    const ch = fake("a");
    await notify(input(), { channels: [ch], env: { PUBLIC_URL: "https://meridian.example/" } });
    expect(ch.sent[0]).toMatchObject({ url: "https://meridian.example/#/plan/watches", path: "/#/plan/watches" });
    await notify(input({ dedupeKey: "k2" }), { channels: [ch], env: {} });
    expect(ch.sent[1].url).toBeUndefined();
    await notify(input({ dedupeKey: "k3", url: "https://elsewhere.example/x" }), { channels: [ch], env: {} });
    expect(ch.sent[2]).toMatchObject({ url: "https://elsewhere.example/x", path: undefined });
  });

  it("rejects bad input", async () => {
    await expect(notify(input({ title: "" }))).rejects.toThrow();
    await expect(notify(input({ kind: "Not Kebab" }))).rejects.toThrow();
    await expect(notify(input({ url: "javascript:alert(1)" }))).rejects.toThrow();
    await expect(notify(input({ dedupeKey: "" }))).rejects.toThrow();
    expect(await listNotices()).toHaveLength(0);
  });

  it("keeps only the newest MAX_NOTICES", async () => {
    for (let i = 0; i < MAX_NOTICES + 3; i++) {
      await notify(input({ dedupeKey: `k${i}` }), { env: {}, channels: [], now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    }
    const all = await listNotices();
    expect(all).toHaveLength(MAX_NOTICES);
    expect(all[0].dedupeKey).toBe(`k${MAX_NOTICES + 2}`);
    expect(all.at(-1)!.dedupeKey).toBe("k3");
  });
});

describe("the list", () => {
  it("is newest first, filters unseen, marks one and all seen", async () => {
    await notify(input({ dedupeKey: "a" }), { env: {}, now: () => new Date("2026-11-01T00:00:00Z") });
    const b = await notify(input({ dedupeKey: "b" }), { env: {}, now: () => new Date("2026-11-02T00:00:00Z") });
    expect((await listNotices()).map((n) => n.dedupeKey)).toEqual(["b", "a"]);
    expect((await markNoticeSeen(b.notice.id))!.seen).toBe(true);
    expect(await markNoticeSeen("nope")).toBeUndefined();
    expect((await listNotices({ unseen: true })).map((n) => n.dedupeKey)).toEqual(["a"]);
    expect(await markAllNoticesSeen()).toBe(1);
    expect(await listNotices({ unseen: true })).toHaveLength(0);
  });
});

describe("publicBaseUrl", () => {
  it("prefers PUBLIC_URL, then the host's own", () => {
    expect(publicBaseUrl({})).toBeUndefined();
    expect(publicBaseUrl({ RENDER_EXTERNAL_URL: "https://m.onrender.com" })).toBe("https://m.onrender.com");
    expect(publicBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "m.vercel.app" })).toBe("https://m.vercel.app");
    expect(publicBaseUrl({ PUBLIC_URL: "https://a.example//", RENDER_EXTERNAL_URL: "https://b" })).toBe("https://a.example");
  });
});

describe("real channels", () => {
  const notice: OutboundNotice = { id: "nt_1", kind: "test", title: "Title", body: "Body", url: "https://m.example/#/", path: "/#/", data: { alert: { id: "al_1" } } };
  const byId = (id: string) => CHANNELS.find((c) => c.id === id)!;
  const calls: [string, RequestInit][] = [];
  const ok = (async (u: string, i: RequestInit) => {
    calls.push([u, i]);
    return new Response("{}", { status: 200 });
  }) as never as typeof fetch;
  const ctx = (env: NodeJS.ProcessEnv, f: typeof fetch = ok) => ({ env, fetch: f, signal: AbortSignal.timeout(1000) });
  beforeEach(() => {
    calls.length = 0;
  });

  it("nothing is configured by default, and status says what to set without leaking values", async () => {
    const statuses = await channelStatuses({});
    expect(statuses.map((s) => s.id)).toEqual(["push", "email", "telegram", "ntfy", "webhook"]);
    expect(statuses.every((s) => !s.configured && s.detail)).toBe(true);
    const env = { TELEGRAM_BOT_TOKEN: "123:secret", TELEGRAM_CHAT_ID: "42", RESEND_API_KEY: "re_secret", ALERT_EMAIL_TO: "me@example.com", NTFY_TOPIC: "topic-secret", ALERT_WEBHOOK_URL: "https://hooks.example/secret" };
    const on = await channelStatuses(env);
    expect(on.filter((s) => s.configured).map((s) => s.id)).toEqual(["email", "telegram", "ntfy", "webhook"]);
    expect(JSON.stringify(on)).not.toMatch(/secret|me@example/);
  });

  it("webhook posts text plus the notice and the extra data", async () => {
    await byId("webhook").send(notice, ctx({ ALERT_WEBHOOK_URL: "https://hooks.example/x" }));
    expect(calls[0][0]).toBe("https://hooks.example/x");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({
      alert: { id: "al_1" },
      text: "Meridian: Title. Body",
      kind: "test",
      title: "Title",
      body: "Body",
      url: "https://m.example/#/",
    });
  });

  it("ntfy publishes JSON to the server root with the topic, a click link and an optional token", async () => {
    await byId("ntfy").send(notice, ctx({ NTFY_TOPIC: "t", NTFY_SERVER: "https://ntfy.example/", NTFY_TOKEN: "tk" }));
    expect(calls[0][0]).toBe("https://ntfy.example");
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer tk");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ topic: "t", title: "Title", message: "Body", click: "https://m.example/#/" });
    await byId("ntfy").send(notice, ctx({ NTFY_TOPIC: "t" }));
    expect(calls[1][0]).toBe("https://ntfy.sh");
  });

  it("telegram calls sendMessage and never puts the token in an error", async () => {
    await byId("telegram").send(notice, ctx({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }));
    expect(calls[0][0]).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ chat_id: "42", text: "Title\nBody\nhttps://m.example/#/", disable_web_page_preview: true });
    const failing = (async (u: string) => {
      throw new Error(`fetch failed for ${u}`);
    }) as never as typeof fetch;
    const err = await byId("telegram")
      .send(notice, ctx({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }, failing))
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain("123:abc");
    const res = (async () => new Response("{}", { status: 403 })) as never as typeof fetch;
    await expect(byId("telegram").send(notice, ctx({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" }, res))).rejects.toThrow("Telegram responded 403");
  });

  it("email goes through Resend when a key is set", async () => {
    await byId("email").send(notice, ctx({ RESEND_API_KEY: "re_1", ALERT_EMAIL_TO: "a@example.com, b@example.com" }));
    expect(calls[0][0]).toBe("https://api.resend.com/emails");
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer re_1");
    expect(JSON.parse(calls[0][1].body as string)).toEqual({
      from: "Meridian <onboarding@resend.dev>",
      to: ["a@example.com", "b@example.com"],
      subject: "Title",
      text: "Body\n\nhttps://m.example/#/",
    });
  });

  it("email status needs a recipient, and a sender for SMTP when the login isn't an address", async () => {
    const st = (env: NodeJS.ProcessEnv) => byId("email").status(env);
    expect(await st({ RESEND_API_KEY: "k" })).toMatchObject({ configured: false, detail: "Set ALERT_EMAIL_TO" });
    expect(await st({ SMTP_URL: "smtps://apikey:x@smtp.example.com", ALERT_EMAIL_TO: "a@b.c" })).toMatchObject({ configured: false, detail: "Set ALERT_EMAIL_FROM" });
    expect(await st({ SMTP_URL: "smtps://me%40example.com:x@smtp.example.com", ALERT_EMAIL_TO: "a@b.c" })).toEqual({ configured: true, detail: "via SMTP" });
    expect(await st({ SMTP_URL: "http://nope", ALERT_EMAIL_TO: "a@b.c" })).toMatchObject({ configured: false });
  });

  it("push needs keys and a device; a gone subscription is removed, one reachable device counts as delivered", async () => {
    const { generateKeyPairSync } = await import("crypto");
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const env = {
      VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url"),
      VAPID_PRIVATE_KEY: privateKey.export({ format: "jwk" }).d!,
      VAPID_SUBJECT: "mailto:owner@example.com",
    };
    expect(await byId("push").status({})).toMatchObject({ configured: false });
    expect(await byId("push").status(env)).toEqual({ configured: false, detail: "No device subscribed yet" });
    const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
    await savePushSubscription({ endpoint: "https://push.example/gone", keys });
    await savePushSubscription({ endpoint: "https://push.example/live", keys });
    expect(await byId("push").status(env)).toEqual({ configured: true, detail: "2 devices" });
    const f = (async (u: string) => new Response(null, { status: u.endsWith("/gone") ? 410 : 201 })) as never as typeof fetch;
    await byId("push").send(notice, ctx(env, f));
    expect((await listPushSubscriptions()).map((s) => s.endpoint)).toEqual(["https://push.example/live"]);
    const down = (async () => new Response(null, { status: 503 })) as never as typeof fetch;
    await expect(byId("push").send(notice, ctx(env, down))).rejects.toThrow("503");
  });
});
