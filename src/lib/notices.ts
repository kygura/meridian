// Client for /api/notifications (ADR 0016): the Notice list shown under "Alerts",
// the channel status and test alert in Settings, and this device's push subscription.
// Everything goes through jfetch, so it carries the journal token and follows the lock.

import { create } from "zustand";
import type { Notice, NoticeChannelStatus, NoticeDelivery } from "../types";
import { hasToken, jfetch, JournalApiError } from "./journalApi";
import { useMeridianStore } from "../store";

interface NoticesState {
  notices: Notice[];
  unseen: number;
  loaded: boolean;
  /** The Alerts sheet. */
  open: boolean;
}

export const useNotices = create<NoticesState>(() => ({ notices: [], unseen: 0, loaded: false, open: false }));

export const openNotices = () => useNotices.setState({ open: true });
export const closeNotices = () => useNotices.setState({ open: false });

/** Forget the list (on lock). */
export function clearNotices(): void {
  useNotices.setState({ notices: [], unseen: 0, loaded: false });
}

/** Load the list into the store. No token, or locked: no request. Never throws. */
export async function refreshNotices(): Promise<void> {
  if (!hasToken() || useMeridianStore.getState().journalLocked) return;
  try {
    const data = await jfetch<{ notices?: Notice[]; unseen?: number }>("/api/notifications");
    const notices = data.notices ?? [];
    useNotices.setState({ notices, unseen: data.unseen ?? notices.filter((n) => !n.seen).length, loaded: true });
  } catch {
    /* offline or locked: keep what we have */
  }
}

/** Mark everything read, here first so the badge clears at once. */
export async function markAllNoticesSeen(): Promise<void> {
  const { notices, unseen } = useNotices.getState();
  if (!unseen) return;
  useNotices.setState({ notices: notices.map((n) => (n.seen ? n : { ...n, seen: true })), unseen: 0 });
  try {
    await jfetch("/api/notifications/seen", { method: "POST" });
  } catch {
    // Not saved (offline): the next refresh shows them as new again.
  }
}

export async function listChannels(): Promise<NoticeChannelStatus[]> {
  const data = await jfetch<{ channels?: NoticeChannelStatus[] }>("/api/notifications/channels");
  return data.channels ?? [];
}

export async function sendTestAlert(): Promise<NoticeDelivery[]> {
  const data = await jfetch<{ deliveries?: NoticeDelivery[] }>("/api/notifications/test", { method: "POST" });
  void refreshNotices();
  return data.deliveries ?? [];
}

/** One line for the toast after a test alert. */
export function describeDeliveries(deliveries: NoticeDelivery[], labels: Record<string, string> = {}): { message: string; ok: boolean } {
  const name = (d: NoticeDelivery) => labels[d.channel] ?? d.channel;
  if (deliveries.length === 0) return { message: "Test alert added to Alerts. No other channel is set up.", ok: true };
  const sent = deliveries.filter((d) => d.ok).map(name);
  const failed = deliveries.filter((d) => !d.ok).map(name);
  if (failed.length === 0) return { message: `Test alert sent: ${sent.join(", ")}.`, ok: true };
  if (sent.length === 0) return { message: `Test alert failed: ${failed.join(", ")}. It is still in Alerts.`, ok: false };
  return { message: `Test alert sent: ${sent.join(", ")}. Failed: ${failed.join(", ")}.`, ok: false };
}

/** "5 min ago", "3 h ago", "2 d ago", then the date. */
export function noticeAge(createdAt: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(createdAt);
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const KIND_LABELS: Record<string, string> = { "watch-alert": "Watch", test: "Test", replan: "Re-plan", gmail: "Gmail" };
/** "watch-alert" → "Watch"; unknown kinds read as their own words ("book-by" → "Book by"). */
export function noticeKindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  const words = kind.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The in-app hash for a Notice link, or null when it points outside the app. */
export function noticeHash(url: string | undefined): string | null {
  if (!url) return null;
  const m = /^\/?(#\/.*)$/.exec(url);
  return m ? m[1] : null;
}

// ── Web Push on this device ─────────────────────────────────────────

export type PushState =
  /** No service worker or Push API here (or a dev build). */
  | "unsupported"
  /** The server has no VAPID keys. */
  | "server-off"
  /** The browser has blocked notifications for this site. */
  | "denied"
  | "off"
  | "on";

/** VAPID keys travel as base64url; PushManager wants bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(): boolean {
  return import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  // `ready` never settles without a worker; don't hang the Settings panel on it.
  return Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000))]);
}

async function serverKey(): Promise<string | null> {
  try {
    return (await jfetch<{ publicKey: string }>("/api/notifications/push/key")).publicKey;
  } catch (err) {
    if (err instanceof JournalApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if ((await serverKey()) === null) return "server-off";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

/** Ask permission, subscribe this browser and store the subscription on the server. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const key = await serverKey();
  if (key === null) return "server-off";
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "denied" : "off";
  const reg = await registration();
  if (!reg) return "unsupported";
  const existing = await reg.pushManager.getSubscription();
  // A subscription made with other keys can't be reused.
  if (existing) await existing.unsubscribe().catch(() => undefined);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) });
  try {
    await jfetch("/api/notifications/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  } catch (err) {
    await sub.unsubscribe().catch(() => undefined);
    throw err;
  }
  return "on";
}

export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await jfetch("/api/notifications/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return "off";
}
