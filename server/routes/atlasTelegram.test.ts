import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import atlasTelegram from "./atlasTelegram";
import { listRuns } from "../lib/atlas/service";
import { resetRateLimits } from "../middleware/rateLimit";

const SECRET = "hook-secret";
const CHAT = "4242";
const FIRE_URL = "https://routine.test/fire";
const BOT = "123:bot-token";

let TMP: string;
let app: Hono;
let sent: { url: string; body: Record<string, any>; headers: Record<string, string> }[];
let fireStatus = 200;

const ENV_KEYS = ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN", "ATLAS_ROUTINE_FIRE_URL", "ATLAS_ROUTINE_TOKEN", "DATA_DIR", "RATE_LIMIT"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  TMP = mkdtempSync(join(tmpdir(), "meridian-atlas-telegram-"));
  process.env.DATA_DIR = TMP;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_CHAT_ID = CHAT;
  process.env.TELEGRAM_BOT_TOKEN = BOT;
  process.env.ATLAS_ROUTINE_FIRE_URL = FIRE_URL;
  process.env.ATLAS_ROUTINE_TOKEN = "routine-token";
  delete process.env.RATE_LIMIT;
  resetRateLimits();
  app = new Hono();
  app.route("/api/telegram/atlas", atlasTelegram);
  sent = [];
  fireStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), headers: (init?.headers ?? {}) as Record<string, string> });
      if (String(url) === FIRE_URL) return new Response(fireStatus === 200 ? "{}" : "nope", { status: fireStatus });
      return new Response('{"ok":true}', { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(TMP, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const botCalls = () => sent.filter((s) => s.url.startsWith("https://api.telegram.org/"));
const fireCalls = () => sent.filter((s) => s.url === FIRE_URL);

function post(update: unknown, secret: string | null = SECRET, raw?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return app.request("/api/telegram/atlas", { method: "POST", headers, body: raw ?? JSON.stringify(update) });
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 10, chat: { id: Number(CHAT) }, from: { id: 55, username: "owner", language_code: "en" }, text, ...extra },
});

describe("POST /api/telegram/atlas security", () => {
  it("is 404 not_configured without TELEGRAM_WEBHOOK_SECRET", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const res = await post(message("/help"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_configured");
    expect(sent).toHaveLength(0);
  });

  it("is 404 not_configured without TELEGRAM_CHAT_ID", async () => {
    delete process.env.TELEGRAM_CHAT_ID;
    expect((await post(message("/help"))).status).toBe(404);
  });

  it("is 401 with a wrong or missing secret, and does nothing", async () => {
    expect((await post(message("/scout"), "wrong")).status).toBe(401);
    expect((await post(message("/scout"), null)).status).toBe(401);
    expect((await post(message("/scout"), "")).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("acknowledges a message from another chat with 200 and takes no action", async () => {
    const other = message("/scout destination:Bali");
    other.message.chat.id = 999;
    const res = await post(other);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    expect(await listRuns()).toHaveLength(0);
  });

  it("acknowledges updates with no message, and messages with no text or photo", async () => {
    expect((await post({ update_id: 2, edited_message: { text: "x" } })).status).toBe(200);
    expect((await post({ update_id: 3, message: { message_id: 1, chat: { id: Number(CHAT) } } })).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("is 400 for a body that is not JSON", async () => {
    const res = await post(null, SECRET, "not json");
    expect(res.status).toBe(400);
  });

  it("is 413 for a body over the size limit", async () => {
    const res = await post(message("x".repeat(70 * 1024)));
    expect(res.status).toBe(413);
  });

  it("is rate limited when the limiter is on", async () => {
    process.env.RATE_LIMIT = "on";
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await post(message("/help"), "wrong")).status;
    expect(last).toBe(429);
  });
});

describe("POST /api/telegram/atlas replies and routine", () => {
  it("answers /help through the Bot API without starting the routine", async () => {
    const res = await post(message("/help"));
    expect(res.status).toBe(200);
    expect(fireCalls()).toHaveLength(0);
    expect(botCalls()).toHaveLength(1);
    expect(botCalls()[0].url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(botCalls()[0].body.chat_id).toBe(CHAT);
    expect(botCalls()[0].body.text).toContain("Atlas commands");
    expect(await listRuns()).toHaveLength(0);
  });

  it("answers /start and /help@BotName the same way", async () => {
    await post(message("/start"));
    await post(message("/help@AtlasBot"));
    expect(botCalls()).toHaveLength(2);
    expect(fireCalls()).toHaveLength(0);
  });

  it("fires the routine in scan mode for /scout with the message and execution_context in the text", async () => {
    const res = await post(message("/scout destination:Portugal activity:surf budget:<1500 origin:MAD", { location: { latitude: 1, longitude: 2 } }));
    expect(res.status).toBe(200);
    expect(fireCalls()).toHaveLength(1);
    const call = fireCalls()[0];
    expect(call.headers.Authorization).toBe("Bearer routine-token");
    const text: string = call.body.text;
    expect(text.startsWith("atlas scan\nrun_id: ")).toBe(true);
    expect(text).toContain("/scout destination:Portugal activity:surf budget:<1500 origin:MAD");
    const ctx = JSON.parse(text.slice(text.indexOf("execution_context:\n") + "execution_context:\n".length));
    expect(ctx.command.name).toBe("scout");
    expect(ctx.resolved_origin).toBe("MAD");
    expect(ctx.user_context.destination_focus).toEqual(["Portugal"]);
    expect(ctx.user_context.max_budget_eur).toBe(1500);
    expect(ctx.telegram).toMatchObject({ chat_id: CHAT, message_id: 10, user_id: 55, username: "owner", location: { latitude: 1, longitude: 2 } });
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "fire", mode: "scan", status: "fired" });
    expect(botCalls()[0].body.text).toBe("Atlas is on it.");
  });

  it("uses discover mode for /discover, /discovery and /findme", async () => {
    for (const name of ["discover", "discovery", "findme"]) await post(message(`/${name} activity:surf`));
    expect(fireCalls().map((c) => String(c.body.text).split("\n")[0])).toEqual(["atlas discover", "atlas discover", "atlas discover"]);
  });

  it("fires a scan for plain text and for /watch, with a null command for plain text", async () => {
    await post(message("find me a quiet surf trip"));
    await post(message("/watch destination:Thailand budget:<1500"));
    const [plain, watch] = fireCalls().map((c) => String(c.body.text));
    expect(plain.startsWith("atlas scan")).toBe(true);
    expect(JSON.parse(plain.slice(plain.indexOf("execution_context:\n") + 18)).command).toBeNull();
    expect(JSON.parse(watch.slice(watch.indexOf("execution_context:\n") + 18)).command.name).toBe("watch");
  });

  it("handles a photo with a caption and a photo with no text", async () => {
    await post(message("", { text: undefined, caption: "what is this beach", photo: [{ file_id: "a" }, { file_id: "b" }] }));
    await post({ update_id: 5, message: { message_id: 11, chat: { id: Number(CHAT) }, photo: [{ file_id: "c" }] } });
    expect(fireCalls()).toHaveLength(2);
    expect(String(fireCalls()[0].body.text)).toContain("what is this beach");
    expect(String(fireCalls()[1].body.text)).toContain("(no text)");
  });

  it("replies with the failure and records a failed run when the routine trigger refuses", async () => {
    fireStatus = 500;
    const res = await post(message("/scout"));
    expect(res.status).toBe(200);
    expect(botCalls()[0].body.text).toContain("Atlas could not start.");
    expect(botCalls()[0].body.text).toContain("answered 500");
    expect((await listRuns())[0]).toMatchObject({ kind: "fire", status: "failed" });
  });

  it("replies that the trigger is not set up when the routine variables are missing", async () => {
    delete process.env.ATLAS_ROUTINE_FIRE_URL;
    const res = await post(message("/scout"));
    expect(res.status).toBe(200);
    expect(fireCalls()).toHaveLength(0);
    expect(botCalls()[0].body.text).toContain("ATLAS_ROUTINE_FIRE_URL");
  });

  it("still answers 200 when the Bot API reply fails or no bot token is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url) === FIRE_URL ? new Response("{}", { status: 200 }) : new Response("bad", { status: 500 })))
    );
    expect((await post(message("/scout"))).status).toBe(200);
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect((await post(message("/help"))).status).toBe(200);
  });

  it("never puts the bot token or the secret in the response", async () => {
    const res = await post(message("/help"));
    const text = await res.text();
    expect(text).not.toContain(BOT);
    expect(text).not.toContain(SECRET);
  });
});

describe("mounted in the whole app", () => {
  it("is reachable without the owner token and is not behind the /api/atlas gate", async () => {
    process.env.MERIDIAN_TOKEN = "owner-token";
    try {
      const { default: full } = await import("../app");
      const headers = { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET };
      const ok = await full.request("/api/telegram/atlas", { method: "POST", headers, body: JSON.stringify(message("/help")) });
      expect(ok.status).toBe(200);
      const bad = await full.request("/api/telegram/atlas", { method: "POST", headers: { ...headers, "X-Telegram-Bot-Api-Secret-Token": "x" }, body: "{}" });
      expect(bad.status).toBe(401);
      expect((await bad.json()).error).toBe("unauthorized");
      // The routine's own API stays gated.
      expect((await full.request("/api/atlas/context")).status).toBe(401);
    } finally {
      delete process.env.MERIDIAN_TOKEN;
    }
  });
});
