// Journal client (DESIGN-journal.md §1.3 "shared contracts owned by (a)").
// Every call goes through jfetch: Bearer token from localStorage["meridian.token"],
// 401 -> JournalLockedError + store.journalLocked. Other journal tasks add their typed
// calls (replay, watches, import actions, uploads) below, on top of jfetch.

import { apiUrl } from "./api";
import { useMeridianStore } from "../store";
import type { Alert, Fingerprint, ImportQueue, Journey, JourneyInput } from "../types";

// ── Token ────────────────────────────────────────────────────────────

export const TOKEN_KEY = "meridian.token";

/** Kept when localStorage throws (private window) so the session still works. */
let memoryToken: string | null = null;
let storageFailed = false;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    const t = window.localStorage.getItem(TOKEN_KEY);
    if (t) return t;
  } catch {
    storageFailed = true;
  }
  return memoryToken;
}

export function hasToken(): boolean {
  return !!getToken();
}

/** Returns false when the token could only be kept in memory (private window). */
export function setToken(token: string): boolean {
  memoryToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
  return !storageFailed;
}

export function clearToken(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing stored */
  }
}

/** True once a write or read of localStorage has thrown this session. */
export function tokenNotPersisted(): boolean {
  return storageFailed;
}

// ── Errors ───────────────────────────────────────────────────────────

/** 401. `reason` is "token_not_configured" when the server has no MERIDIAN_TOKEN (R1);
 *  undefined means the token is missing or wrong. */
export class JournalLockedError extends Error {
  reason?: "token_not_configured";
  constructor(reason?: "token_not_configured") {
    super(reason === "token_not_configured" ? "Journal is not switched on on this server" : "Journal is locked");
    this.name = "JournalLockedError";
    this.reason = reason;
  }
}

/** Any other non-2xx: 400 (issues), 404, 422 fx_unavailable (currency + date), 5xx. */
export class JournalApiError extends Error {
  status: number;
  code?: string;
  issues?: unknown;
  currency?: string;
  date?: string;
  constructor(status: number, data: any) {
    super(data?.message ?? data?.error ?? `Journal request failed (${status})`);
    this.name = "JournalApiError";
    this.status = status;
    this.code = data?.error;
    this.issues = data?.issues;
    this.currency = data?.currency;
    this.date = data?.date;
  }
  get fxUnavailable(): boolean {
    return this.status === 422 && this.code === "fx_unavailable";
  }
}

export class JournalNetworkError extends Error {
  constructor(message = "Couldn't reach the server") {
    super(message);
    this.name = "JournalNetworkError";
  }
}

// ── Transport ────────────────────────────────────────────────────────

export async function jfetch<T = any>(
  path: string,
  init: RequestInit = {},
  opts: { token?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = opts.token ?? getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(apiUrl(path), { ...init, headers });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new JournalNetworkError();
  }
  const data: any = await res.json().catch(() => null);

  if (res.status === 401) {
    const reason = data?.reason === "token_not_configured" ? "token_not_configured" : undefined;
    // A candidate-token check (opts.token) must not flip the page lock itself.
    if (!opts.token) useMeridianStore.getState().setJournalLocked(true, reason ?? null);
    throw new JournalLockedError(reason);
  }
  if (!res.ok) throw new JournalApiError(res.status, data);
  return data as T;
}

/** Like jfetch, but a 404 (route not built yet on this server) resolves to `fallback`. */
async function tolerate404<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof JournalApiError && err.status === 404) return fallback;
    throw err;
  }
}

// ── Journeys ─────────────────────────────────────────────────────────

export async function listJourneys(): Promise<Journey[]> {
  const data = await jfetch<{ journeys: Journey[] }>("/api/journal");
  return data.journeys ?? [];
}

export async function getJourney(id: string): Promise<Journey | null> {
  try {
    const data = await jfetch<{ journey: Journey }>(`/api/journal/${encodeURIComponent(id)}`);
    return data.journey ?? null;
  } catch (err) {
    if (err instanceof JournalApiError && err.status === 404) return null;
    throw err;
  }
}

/** POST when `id` is absent, PUT otherwise. Money may omit eur/rateDate (server fills them, R5). */
export async function saveJourney(input: JourneyInput, id?: string): Promise<Journey> {
  const data = await jfetch<{ journey: Journey }>(id ? `/api/journal/${encodeURIComponent(id)}` : "/api/journal", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(input),
  });
  return data.journey;
}

export async function deleteJourney(id: string): Promise<void> {
  await jfetch(`/api/journal/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** GET /api/journal/:id/fingerprint (task R); null while that route does not exist. */
export async function getFingerprint(id: string): Promise<Fingerprint | null> {
  const data = await tolerate404(
    jfetch<{ fingerprint?: Fingerprint } & Partial<Fingerprint>>(`/api/journal/${encodeURIComponent(id)}/fingerprint`),
    null
  );
  if (!data) return null;
  return (data.fingerprint ?? (data.status ? (data as Fingerprint) : null)) as Fingerprint | null;
}

/** Fetch the list into the store. Errors propagate (JournalPage renders lock / retry). */
export async function refreshJourneys(): Promise<Journey[]> {
  const journeys = await listJourneys();
  const s = useMeridianStore.getState();
  s.setJourneys(journeys);
  s.setJournalLocked(false);
  return journeys;
}

/** Check a candidate token with GET /api/journal. Resolves on success. */
export async function verifyToken(token: string): Promise<void> {
  await jfetch("/api/journal", {}, { token });
}

// ── Nav badges (TopBar §3) ───────────────────────────────────────────

/** GET /api/import/queue; null while the import route is not mounted (404). */
export async function getQueue(): Promise<ImportQueue | null> {
  return tolerate404(jfetch<ImportQueue>("/api/import/queue"), null);
}

/** GET /api/watches/alerts; [] while the watches route is not mounted (404). */
export async function listAlerts(): Promise<Alert[]> {
  const data = await tolerate404(jfetch<{ alerts?: Alert[] } | Alert[]>("/api/watches/alerts"), []);
  return Array.isArray(data) ? data : data.alerts ?? [];
}

/** Refresh importPending + alerts in the store. No token -> no request. Never throws. */
export async function refreshBadges(): Promise<void> {
  if (!hasToken()) return;
  const [queue, alerts] = await Promise.allSettled([getQueue(), listAlerts()]);
  const s = useMeridianStore.getState();
  if (queue.status === "fulfilled" && queue.value) {
    s.setImportPending(queue.value.candidates.filter((c) => c.state === "pending").length);
  }
  if (alerts.status === "fulfilled") s.setAlerts(alerts.value);
}
