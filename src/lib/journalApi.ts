// Journal client (DESIGN-journal.md §1.3 "shared contracts owned by (a)").
// Every call goes through jfetch: Bearer token from localStorage["meridian.token"],
// 401 -> JournalLockedError + store.journalLocked. Typed calls (journeys, replay, watches,
// import actions, uploads) sit below, on top of jfetch.

import { apiUrl } from "./api";
import { useMeridianStore } from "../store";
import { MAX_UPLOAD_BYTES, emailContentType, photoBatches, mergeReports, type PhotoPoint, type UploadReport } from "./importUpload";
import type {
  JournalSettings,
  Alert,
  Fingerprint,
  ImportCandidate,
  ImportQueue,
  ImportReport,
  Journey,
  JourneyInput,
  ReplayQuery,
  ReplayResponse,
  Watch,
  WatchPriceRule,
} from "../types";

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

/** POST when `id` is absent, PUT otherwise. Money may omit eur/rateDate (server fills them, R5).
 *  `baseUpdatedAt` (the version the edit started from) goes as If-Match: a stale PUT gets 409 instead of reverting a merge. */
export async function saveJourney(input: JourneyInput, id?: string, baseUpdatedAt?: string): Promise<Journey> {
  const data = await jfetch<{ journey: Journey }>(id ? `/api/journal/${encodeURIComponent(id)}` : "/api/journal", {
    method: id ? "PUT" : "POST",
    ...(id && baseUpdatedAt ? { headers: { "If-Match": baseUpdatedAt } } : {}),
    body: JSON.stringify(input),
  });
  return data.journey;
}

export async function deleteJourney(id: string): Promise<void> {
  await jfetch(`/api/journal/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** GET /api/journal/:id/fingerprint. The server recomputes and persists journey and stop fingerprints;
 *  callers re-read the journey afterwards for the stops (observed weather, per-stop fingerprints). */
export async function getFingerprint(id: string): Promise<Fingerprint | null> {
  const data = await jfetch<{ fingerprint?: Fingerprint }>(`/api/journal/${encodeURIComponent(id)}/fingerprint`);
  return data.fingerprint ?? null;
}

/** PUT /api/journal/settings: the home city drives replay origin, import clustering and "nights away". */
export async function saveSettings(settings: JournalSettings): Promise<JournalSettings> {
  const data = await jfetch<{ settings: JournalSettings }>("/api/journal/settings", { method: "PUT", body: JSON.stringify(settings) });
  return data.settings;
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

/** GET /api/import/queue. */
export function getQueue(): Promise<ImportQueue> {
  return jfetch<ImportQueue>("/api/import/queue");
}

/** GET /api/watches/alerts. */
export async function listAlerts(): Promise<Alert[]> {
  const data = await jfetch<{ alerts?: Alert[] } | Alert[]>("/api/watches/alerts");
  return Array.isArray(data) ? data : data.alerts ?? [];
}

/** Refresh importPending + alerts in the store. No token, or locked -> no request. Never throws. */
export async function refreshBadges(): Promise<void> {
  if (!hasToken() || useMeridianStore.getState().journalLocked) return;
  const [queue, alerts, watches] = await Promise.allSettled([getQueue(), listAlerts(), listWatches()]);
  const s = useMeridianStore.getState();
  if (queue.status === "fulfilled") {
    s.setImportPending(queue.value.candidates.filter((c) => c.state === "pending").length);
  }
  if (alerts.status === "fulfilled") s.setAlerts(alerts.value);
  if (watches.status === "fulfilled") s.setWatches(watches.value);
}

// ── Replay & watches (task b) ────────────────────────────────────────

/** POST /api/replay. Errors: 404 template_not_found, 409 template_not_fingerprinted, 400. Abortable. */
export function runReplay(query: ReplayQuery, signal?: AbortSignal): Promise<ReplayResponse> {
  return jfetch<ReplayResponse>("/api/replay", { method: "POST", body: JSON.stringify(query), signal });
}

/** POST /api/watches. */
export async function createWatch(input: {
  label: string;
  query: ReplayQuery;
  leadWeeks: [number, number];
  priceRule: WatchPriceRule;
}): Promise<Watch> {
  const data = await jfetch<{ watch: Watch }>("/api/watches", { method: "POST", body: JSON.stringify(input) });
  return data.watch;
}

/** GET /api/watches. */
export async function listWatches(): Promise<Watch[]> {
  const data = await jfetch<{ watches?: Watch[] }>("/api/watches");
  return data.watches ?? [];
}

export async function deleteWatch(id: string): Promise<void> {
  await jfetch(`/api/watches/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** POST /api/watches/alerts/:id/seen */
export async function markAlertSeen(id: string): Promise<Alert> {
  const data = await jfetch<{ alert: Alert }>(`/api/watches/alerts/${encodeURIComponent(id)}/seen`, { method: "POST" });
  return data.alert;
}

// ── Inbox (task d) ───────────────────────────────────────────────────

const enc = encodeURIComponent;
const post = (path: string, body?: unknown) => jfetch(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

/** Accepts one candidate as a new journey, or into `journeyId` when given. */
export const acceptCandidate = (id: string, journeyId?: string) => post(`/api/import/${enc(id)}/accept`, journeyId ? { journeyId } : undefined);
export const mergeCandidate = (id: string, journeyId: string) => post(`/api/import/${enc(id)}/merge`, { journeyId });
export const discardCandidate = (id: string) => post(`/api/import/${enc(id)}/discard`);
export const acceptCluster = (clusterId: string) => post(`/api/import/cluster/${enc(clusterId)}/accept`);
export const mergeCluster = (clusterId: string, journeyId: string) => post(`/api/import/cluster/${enc(clusterId)}/merge`, { journeyId });

/** Resolve the city of a candidate flagged "unresolved-city" (PATCH /api/import/:id). */
export async function resolveCandidate(id: string, fix: { cityId?: string; fromCityId?: string; toCityId?: string }): Promise<ImportCandidate> {
  const data = await jfetch<{ candidate: ImportCandidate }>(`/api/import/${enc(id)}`, { method: "PATCH", body: JSON.stringify(fix) });
  return data.candidate;
}

/** Re-read the queue into the store (importPending + alerts counts follow). Errors propagate. */
export async function refreshQueue(): Promise<ImportQueue> {
  const q = await getQueue();
  useMeridianStore.getState().setImportPending(q.candidates.filter((c) => c.state === "pending").length);
  return q;
}

// Uploads. Files are read in the browser and sent as the server expects; photos send metadata only.

/** Refuse over-limit files before reading them into memory (the server would answer 413 anyway). */
function tooLargeCheck(file: File): void {
  if (file.size > MAX_UPLOAD_BYTES) throw new JournalApiError(413, { error: "too_large", message: "That file is too large" });
}

/** .eml / .mbox as a raw body (content type from the extension). */
export function uploadEmail(file: File): Promise<ImportReport> {
  tooLargeCheck(file);
  return jfetch<ImportReport>("/api/import/upload/email", { method: "POST", headers: { "Content-Type": emailContentType(file.name) }, body: file });
}

/** Timeline export: parsed here, sent as the JSON body (the raw file is not kept by the server). */
export async function uploadTimeline(file: File): Promise<ImportReport> {
  tooLargeCheck(file);
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new JournalApiError(400, { error: "invalid_json", message: "That file isn't valid JSON" });
  }
  return jfetch<ImportReport>("/api/import/upload/timeline", { method: "POST", body: JSON.stringify(json) });
}

/**
 * POST /api/import/photos in time-sorted batches; the points carry exactly {timestamp, lat, lng, hash}.
 * A failure rethrows with `partial` (the reports of the batches already saved); a cancel adds a CANCELLED note.
 */
export async function uploadPhotos(points: PhotoPoint[], opts: { note?: string; shouldCancel?: () => boolean } = {}): Promise<UploadReport> {
  const reports: ImportReport[] = [];
  let cancelled = false;
  try {
    for (const batch of photoBatches(points)) {
      if (opts.shouldCancel?.()) {
        cancelled = true;
        break;
      }
      reports.push(await jfetch<ImportReport>("/api/import/photos", { method: "POST", body: JSON.stringify(batch) }));
    }
  } catch (e) {
    throw Object.assign(e as object, { partial: reports });
  }
  return mergeReports(reports, [opts.note, cancelled ? "CANCELLED" : ""].filter(Boolean).join(" · ") || undefined);
}
