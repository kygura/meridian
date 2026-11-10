// The notifier: one call that records a Notice and delivers it (ADR 0016).
//
//   import { notify } from "./notifier.js";
//   await notify({
//     kind: "watch-alert",                       // what raised it; free-form, kebab-case
//     title: "Lisbon in December at 80 EUR",     // one line
//     body: "Below your usual 150 EUR ...",      // a sentence or two, plain text
//     url: "/#/plan/watches",                    // app-relative link (optional)
//     dedupeKey: "watch-alert:al_1234",          // same key = same Notice, never sent twice
//   });
//
// What it guarantees:
// - The Notice is written to the log (notices.json in the document store) BEFORE any
//   channel is tried, so the in-app list shows it even with no channel set up or all
//   of them down.
// - Dedupe: a dedupeKey that is already in the log returns { deduped: true } and sends
//   nothing. The insert-if-absent runs inside the store's serialized update, so two
//   concurrent calls (or two processes on Postgres) cannot both send.
// - Every configured channel is tried once, concurrently, each under its own timeout;
//   one failing does not affect the others, and notify() does not throw for them. The
//   outcome per channel is saved on the Notice (`deliveries`).
// - It throws only for invalid input (ZodError) or when the store itself fails.
//
// The log keeps the newest MAX_NOTICES; dedupe therefore holds for as long as a Notice
// is still in the log.

import { createHash } from "crypto";
import { z } from "zod";
import type { Notice, NoticeDelivery } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";
import { CHANNELS, channelStatuses, type Channel, type ChannelStatus, type OutboundNotice } from "./notify/channels.js";

export const MAX_NOTICES = 500;
const CHANNEL_TIMEOUT_MS = 10_000;

export const notifyInputSchema = z.object({
  kind: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{0,39}$/, "kind is lower-case kebab-case"),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(2000).default(""),
  /** App-relative ("/#/plan/watches") or absolute http(s). */
  url: z
    .string()
    .trim()
    .max(500)
    .refine((u) => u.startsWith("/") || /^https?:\/\//.test(u), "url is app-relative or http(s)")
    .optional(),
  dedupeKey: z.string().trim().min(1).max(200),
  /** Extra JSON merged into the webhook payload only; not stored. */
  data: z.record(z.unknown()).optional(),
});
export type NotifyInput = z.input<typeof notifyInputSchema>;

export interface NotifyResult {
  notice: Notice;
  /** True when this dedupeKey was already logged: nothing was sent. */
  deduped: boolean;
  /** One entry per configured channel that was tried (empty when deduped or none is set up). */
  deliveries: NoticeDelivery[];
}

export interface NotifyDeps {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  channels?: readonly Channel[];
  timeoutMs?: number;
}

interface NoticesFile {
  version: 1;
  notices: Notice[];
}
const store = createJsonStore<NoticesFile>("notices.json", () => ({ version: 1, notices: [] }));

export function noticeId(dedupeKey: string): string {
  return "nt_" + createHash("sha256").update(dedupeKey).digest("hex").slice(0, 16);
}

/** The app's public address, for links in email, Telegram, ntfy and the webhook. */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw =
    env.PUBLIC_URL?.trim() ||
    env.RENDER_EXTERNAL_URL?.trim() ||
    (env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL.trim()}` : "");
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

function absoluteUrl(url: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//.test(url)) return url;
  const base = publicBaseUrl(env);
  return base ? `${base}${url}` : undefined;
}

const errorText = (e: unknown) => (e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e)).slice(0, 200);

export async function notify(raw: NotifyInput, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const input = notifyInputSchema.parse(raw);
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const channels = deps.channels ?? CHANNELS;

  const fresh: Notice = {
    id: noticeId(input.dedupeKey),
    kind: input.kind,
    title: input.title,
    body: input.body,
    ...(input.url ? { url: input.url } : {}),
    dedupeKey: input.dedupeKey,
    createdAt: now.toISOString(),
    seen: false,
    deliveries: [],
  };

  const existing = await store.update((f) => {
    const hit = f.notices.find((n) => n.dedupeKey === fresh.dedupeKey);
    if (hit) return hit;
    f.notices.push(fresh);
    if (f.notices.length > MAX_NOTICES) f.notices = f.notices.slice(-MAX_NOTICES);
    return undefined;
  });
  if (existing) return { notice: existing, deduped: true, deliveries: [] };

  const outbound: OutboundNotice = {
    id: fresh.id,
    kind: fresh.kind,
    title: fresh.title,
    body: fresh.body,
    url: absoluteUrl(fresh.url, env),
    path: fresh.url?.startsWith("/") ? fresh.url : undefined,
    data: input.data,
  };

  const deliveries = (
    await Promise.all(
      channels.map(async (ch): Promise<NoticeDelivery | null> => {
        try {
          if (!(await ch.status(env)).configured) return null;
          await ch.send(outbound, { env, fetch: deps.fetch ?? fetch, signal: AbortSignal.timeout(deps.timeoutMs ?? CHANNEL_TIMEOUT_MS) });
          return { channel: ch.id, ok: true, at: new Date().toISOString() };
        } catch (err) {
          console.error(`[notifier] ${ch.id} failed: ${errorText(err)}`);
          return { channel: ch.id, ok: false, error: errorText(err), at: new Date().toISOString() };
        }
      })
    )
  ).filter((d): d is NoticeDelivery => d !== null);

  if (deliveries.length) {
    await store.update((f) => {
      const n = f.notices.find((x) => x.id === fresh.id);
      if (n) n.deliveries = deliveries;
    });
  }
  return { notice: { ...fresh, deliveries }, deduped: false, deliveries };
}

// ── the in-app list ─────────────────────────────────────────────────

/** Newest first. */
export async function listNotices(opts: { unseen?: boolean; limit?: number } = {}): Promise<Notice[]> {
  let notices = (await store.read()).notices;
  if (opts.unseen) notices = notices.filter((n) => !n.seen);
  const sorted = [...notices].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return opts.limit ? sorted.slice(0, opts.limit) : sorted;
}

export async function markNoticeSeen(id: string): Promise<Notice | undefined> {
  return store.update((f) => {
    const n = f.notices.find((x) => x.id === id);
    if (n) n.seen = true;
    return n;
  });
}

/** Returns how many were newly marked. */
export async function markAllNoticesSeen(): Promise<number> {
  return store.update((f) => {
    let n = 0;
    for (const x of f.notices) {
      if (!x.seen) {
        x.seen = true;
        n++;
      }
    }
    return n;
  });
}

export async function listChannels(env: NodeJS.ProcessEnv = process.env): Promise<ChannelStatus[]> {
  return channelStatuses(env);
}
