// Delivery channels for Notices. Each is optional, switched on by its own environment
// variables (read per call, like the rest of the server), and fails on its own: one
// channel throwing never stops another (notifier.ts settles them separately).
//
//   webhook   ALERT_WEBHOOK_URL
//   ntfy      NTFY_TOPIC [+ NTFY_SERVER, NTFY_TOKEN]
//   telegram  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   email     ALERT_EMAIL_TO + (RESEND_API_KEY | SMTP_URL) [+ ALERT_EMAIL_FROM]
//   push      VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY + VAPID_SUBJECT, and a subscribed device
//
// Channel status never includes a secret: only whether it is set up and what is missing.

import { bareAddress, parseSmtpUrl, sendMail } from "./smtp.js";
import { PushGoneError, listPushSubscriptions, removePushSubscription, sendPush, vapidConfig } from "./webPush.js";

export interface OutboundNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** Absolute link into the app, when PUBLIC_URL (or the host's own URL) is known. */
  url?: string;
  /** App-relative link ("/#/plan/watches"); push uses it so the click stays in the installed app. */
  path?: string;
  /** Extra fields for the webhook payload only. */
  data?: Record<string, unknown>;
}

export interface ChannelStatus {
  id: string;
  label: string;
  configured: boolean;
  /** What is missing, or a non-secret note such as "2 devices". */
  detail?: string;
}

export interface ChannelContext {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  signal: AbortSignal;
}

export interface Channel {
  id: string;
  label: string;
  status(env: NodeJS.ProcessEnv): Promise<Omit<ChannelStatus, "id" | "label">> | Omit<ChannelStatus, "id" | "label">;
  /** Resolve when delivered; throw with a short, secret-free message otherwise. */
  send(notice: OutboundNotice, ctx: ChannelContext): Promise<void>;
}

const set = (v: string | undefined): v is string => !!v?.trim();
const plainText = (n: OutboundNotice) => [n.title, n.body, n.url].filter(Boolean).join("\n");

async function okOrThrow(res: Response, what: string): Promise<void> {
  if (!res.ok) throw new Error(`${what} responded ${res.status}`);
}

// ── webhook ─────────────────────────────────────────────────────────

/** POST {text, kind, title, body, url, ...data}. `text` keeps Slack-style hooks working. */
const webhook: Channel = {
  id: "webhook",
  label: "Webhook",
  status: (env) => (set(env.ALERT_WEBHOOK_URL) ? { configured: true } : { configured: false, detail: "Set ALERT_WEBHOOK_URL" }),
  async send(n, { env, fetch, signal }) {
    const res = await fetch(env.ALERT_WEBHOOK_URL!.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...n.data, text: `Meridian: ${n.title}. ${n.body}`, kind: n.kind, title: n.title, body: n.body, url: n.url }),
      signal,
    });
    await okOrThrow(res, "webhook");
  },
};

// ── ntfy ────────────────────────────────────────────────────────────

const ntfy: Channel = {
  id: "ntfy",
  label: "ntfy",
  status: (env) => (set(env.NTFY_TOPIC) ? { configured: true } : { configured: false, detail: "Set NTFY_TOPIC" }),
  async send(n, { env, fetch, signal }) {
    const server = (env.NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (set(env.NTFY_TOKEN)) headers.Authorization = `Bearer ${env.NTFY_TOKEN.trim()}`;
    const res = await fetch(server, {
      method: "POST",
      headers,
      body: JSON.stringify({ topic: env.NTFY_TOPIC!.trim(), title: n.title, message: n.body, ...(n.url ? { click: n.url } : {}) }),
      signal,
    });
    await okOrThrow(res, "ntfy");
  },
};

// ── Telegram ────────────────────────────────────────────────────────

const telegram: Channel = {
  id: "telegram",
  label: "Telegram",
  status: (env) =>
    set(env.TELEGRAM_BOT_TOKEN) && set(env.TELEGRAM_CHAT_ID)
      ? { configured: true }
      : { configured: false, detail: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" },
  async send(n, { env, fetch, signal }) {
    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN!.trim()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID!.trim(), text: plainText(n), disable_web_page_preview: true }),
        signal,
      });
    } catch (err) {
      // fetch errors can quote the URL, which carries the bot token.
      throw new Error(`Telegram request failed${err instanceof Error && err.name === "TimeoutError" ? " (timed out)" : ""}`);
    }
    await okOrThrow(res, "Telegram");
  },
};

// ── email ───────────────────────────────────────────────────────────

/** Resend's shared test sender: it only delivers to the Resend account's own address. */
const RESEND_TEST_FROM = "Meridian <onboarding@resend.dev>";

const recipients = (env: NodeJS.ProcessEnv) =>
  (env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const email: Channel = {
  id: "email",
  label: "Email",
  status(env) {
    const via = set(env.RESEND_API_KEY) ? "Resend" : set(env.SMTP_URL) ? "SMTP" : null;
    if (!via) return { configured: false, detail: "Set RESEND_API_KEY or SMTP_URL, and ALERT_EMAIL_TO" };
    if (recipients(env).length === 0) return { configured: false, detail: "Set ALERT_EMAIL_TO" };
    if (via === "SMTP") {
      try {
        const cfg = parseSmtpUrl(env.SMTP_URL!.trim());
        if (!set(env.ALERT_EMAIL_FROM) && !cfg.user?.includes("@")) return { configured: false, detail: "Set ALERT_EMAIL_FROM" };
      } catch (err) {
        return { configured: false, detail: err instanceof Error ? err.message : "SMTP_URL is invalid" };
      }
    }
    return { configured: true, detail: `via ${via}` };
  },
  async send(n, { env, fetch, signal }) {
    const to = recipients(env);
    const text = [n.body, n.url].filter(Boolean).join("\n\n");
    if (set(env.RESEND_API_KEY)) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY.trim()}` },
        body: JSON.stringify({ from: env.ALERT_EMAIL_FROM?.trim() || RESEND_TEST_FROM, to, subject: n.title, text }),
        signal,
      });
      return okOrThrow(res, "Resend");
    }
    const cfg = parseSmtpUrl(env.SMTP_URL!.trim());
    const from = env.ALERT_EMAIL_FROM?.trim() || cfg.user!;
    await sendMail(cfg, { from: from.includes("<") ? from : `Meridian <${bareAddress(from)}>`, to, subject: n.title, text });
  },
};

// ── Web Push ────────────────────────────────────────────────────────

const push: Channel = {
  id: "push",
  label: "Push",
  async status(env) {
    const vapid = vapidConfig(env);
    if ("missing" in vapid) return { configured: false, detail: `Set ${vapid.missing}` };
    const n = (await listPushSubscriptions()).length;
    return n ? { configured: true, detail: `${n} ${n === 1 ? "device" : "devices"}` } : { configured: false, detail: "No device subscribed yet" };
  },
  async send(n, { env, fetch, signal }) {
    const vapid = vapidConfig(env);
    if ("missing" in vapid) throw new Error("VAPID keys missing");
    const subs = await listPushSubscriptions();
    const payload = JSON.stringify({ id: n.id, kind: n.kind, title: n.title, body: n.body.slice(0, 1000), url: n.path ?? n.url });
    const results = await Promise.allSettled(subs.map((s) => sendPush(s, payload, vapid, fetch, signal)));
    let delivered = 0;
    let firstError = "";
    for (const [i, r] of results.entries()) {
      if (r.status === "fulfilled") delivered++;
      else if (r.reason instanceof PushGoneError) await removePushSubscription(subs[i].endpoint);
      else firstError ||= r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
    // One reachable device is a delivery; none is a failure worth showing.
    if (delivered === 0) throw new Error(firstError || "No subscribed device could be reached");
  },
};

export const CHANNELS: readonly Channel[] = [push, email, telegram, ntfy, webhook];

export async function channelStatuses(env: NodeJS.ProcessEnv = process.env, channels: readonly Channel[] = CHANNELS): Promise<ChannelStatus[]> {
  return Promise.all(channels.map(async (c) => ({ id: c.id, label: c.label, ...(await c.status(env)) })));
}
