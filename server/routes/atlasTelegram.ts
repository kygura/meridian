// POST /api/telegram/atlas: the Atlas bot's webhook (ADR 0020). Public, because Telegram cannot
// send the Bearer token; it is protected by the webhook secret Telegram echoes in a header, and
// by an allow-list of one chat, the owner's.
//
//   TELEGRAM_WEBHOOK_SECRET  must equal the header X-Telegram-Bot-Api-Secret-Token (setWebhook secret_token)
//   TELEGRAM_CHAT_ID         the only chat whose messages are acted on
//   TELEGRAM_BOT_TOKEN       replies go out through the same Telegram channel Meridian's alerts use
//
// Unset secret or chat: 404. Wrong secret: 401. A message from another chat gets 200 and no
// action, since Telegram retries on any other status. /help and /start are answered here; every
// other message starts the routine through fireRoutine, which records the run.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CHANNELS } from "../lib/notify/channels.js";
import { AtlasInputError, fireRoutine } from "../lib/atlas/service.js";
import { COMMAND_HELP_TEXT, buildRoutineRequest, clipMessage, parseTelegramCommand, type TelegramMessage } from "../lib/atlas/telegram.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { tokenMatches } from "../middleware/auth.js";

const MAX_BODY_BYTES = 64 * 1024;

/** One owner sends a handful of messages; anything faster is noise or guessing. */
const telegramLimiter = createRateLimiter({ name: "telegram_atlas", limit: 60, windowMs: 60_000, globalLimit: 600, globalWindowMs: 60 * 60_000 });

const atlasTelegram = new Hono();

const set = (v: string | undefined): v is string => !!v?.trim();

/** Sends a reply to the owner's chat with Meridian's Telegram channel. Never throws. */
async function reply(text: string): Promise<void> {
  const telegram = CHANNELS.find((c) => c.id === "telegram");
  if (!telegram || !(await telegram.status(process.env)).configured) return;
  try {
    await telegram.send(
      { id: "atlas-telegram-reply", kind: "atlas-reply", title: text, body: "" },
      { env: process.env, fetch: globalThis.fetch, signal: AbortSignal.timeout(10_000) }
    );
  } catch (err) {
    // The channel's errors carry no secret by design.
    console.error("[atlas-telegram] reply failed:", err instanceof Error ? err.message : String(err));
  }
}

atlasTelegram.post(
  "/",
  telegramLimiter.middleware,
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }),
  async (c) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const ownerChat = process.env.TELEGRAM_CHAT_ID;
    if (!set(secret) || !set(ownerChat)) {
      return c.json({ error: "not_configured", message: "Set TELEGRAM_WEBHOOK_SECRET and TELEGRAM_CHAT_ID to use the Atlas bot." }, 404);
    }
    const presented = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (!presented || !tokenMatches(presented, secret.trim())) return c.json({ error: "unauthorized" }, 401);

    const update = (await c.req.json().catch(() => null)) as { message?: TelegramMessage } | null;
    if (!update || typeof update !== "object") return c.json({ error: "invalid_body" }, 400);

    const message = update.message;
    const chatId = message?.chat?.id != null ? String(message.chat.id) : null;
    // Not the owner's chat, not a message, or nothing to act on: acknowledge so Telegram does not retry.
    if (!message || chatId !== ownerChat.trim()) return c.json({ ok: true });
    const hasPhoto = !!message.photo?.length;
    const text = clipMessage(((message.caption || message.text) ?? "").trim());
    if (!text && !hasPhoto) return c.json({ ok: true });

    const command = text ? parseTelegramCommand(text) : null;
    if (command?.name === "help") {
      await reply(COMMAND_HELP_TEXT);
      return c.json({ ok: true });
    }

    try {
      const run = await fireRoutine(buildRoutineRequest(message, command, text));
      await reply(run.status === "failed" ? `Atlas could not start. ${run.detail ?? ""}`.trim() : "Atlas is on it.");
    } catch (err) {
      const detail = err instanceof AtlasInputError ? err.message : "The request failed on the server.";
      console.error("[atlas-telegram] could not start the routine:", err);
      await reply(`Atlas could not start. ${detail}`);
    }
    return c.json({ ok: true });
  }
);

export default atlasTelegram;
