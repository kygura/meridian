// Client for /api/notion and /api/gmail (ADR 0017). Owner-only; calls go through jfetch.

import { jfetch } from "./journalApi";

// ── Notion ───────────────────────────────────────────────────────────

export interface NotionMapping {
  seasons: Record<"title" | "place" | "kind" | "start" | "end" | "notes" | "country", string>;
  research: Record<"name" | "country" | "type" | "stay" | "stayMin" | "stayMax" | "budget" | "budgetMin" | "budgetMax" | "currency" | "notes" | "overall", string>;
}

export interface NotionReviewItem {
  key: string;
  db: "seasons" | "research";
  label: string;
  reason: "no-match" | "ambiguous" | "compound" | "bad-dates" | "bad-kind";
  detail: string;
  count: number;
  suggestions: { cityId: string; name: string; country: string }[];
}

export interface NotionStatus {
  tokenSet: boolean;
  config: NotionMapping & {
    seasonsDb?: string;
    researchDb?: string;
    researchPage?: string;
    daily: boolean;
    writeBack: { enabled: boolean; database?: string };
  };
  resolved: { seasonsDb: boolean; researchDb: boolean; researchPage: boolean; writeBackDb: boolean };
  writeBackAllowed: boolean;
  pool: number;
  review: NotionReviewItem[];
  lastRun: { at: string; source: "api" | "upload"; trigger: "manual" | "daily"; summary: Record<string, number> } | null;
}

export interface WindowView {
  ref: string;
  kind: "peak" | "shoulder" | "avoid";
  months: { start: number; end: number };
  reason?: string;
}

export interface NotionPlan {
  places: { cityId: string; name: string; country: string; added: WindowView[]; updated: { before: WindowView; after: WindowView }[]; removed: WindowView[]; unchanged: number }[];
  pool: { added: { ref: string; cityName: string }[]; updated: { after: { ref: string; cityName: string } }[]; removed: { ref: string; cityName: string }[]; unchanged: number } | null;
  review: NotionReviewItem[];
  covers: { seasons: boolean; research: boolean };
  summary: { windowsAdded: number; windowsUpdated: number; windowsRemoved: number; poolAdded: number; poolUpdated: number; poolRemoved: number; review: number };
  digest: string;
}

export type NotionSource = { kind: "api" } | { kind: "upload"; seasonsCsv?: string; researchCsv?: string; researchMarkdown?: string };

export const getNotionStatus = (): Promise<NotionStatus> => jfetch("/api/notion/status");
export const saveNotionConfig = (patch: unknown): Promise<NotionStatus> => jfetch("/api/notion/config", { method: "PUT", body: JSON.stringify(patch) });
export const previewNotion = (source: NotionSource): Promise<{ plan: NotionPlan }> => jfetch("/api/notion/preview", { method: "POST", body: JSON.stringify({ source }) });
export const applyNotion = (source: NotionSource, digest: string): Promise<{ summary: NotionPlan["summary"]; review: NotionReviewItem[] }> =>
  jfetch("/api/notion/apply", { method: "POST", body: JSON.stringify({ source, digest }) });
export const resolveNotionReview = (key: string, cityIds: string[]): Promise<{ ok: true }> => jfetch("/api/notion/review/resolve", { method: "POST", body: JSON.stringify({ key, cityIds }) });
export const writeBackNotion = (): Promise<{ created: number; updated: number; skipped: number }> => jfetch("/api/notion/write-back", { method: "POST" });

// ── Gmail ────────────────────────────────────────────────────────────

export interface GmailStatus {
  /** GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the encryption key are all set. */
  configured: boolean;
  missing: string[];
  connected: boolean;
  /** The Google account's address as Google reported it, shown so the owner knows which account is linked. */
  account?: string;
  connectedAt?: string;
  lastSync: { at: string; mode: "backfill" | "incremental"; messages: number; unstructured: number; candidates: number; added: number; duplicates: number; cancelled: number; complete: boolean; error?: string } | null;
  redirectUri: string;
}

export const getGmailStatus = (): Promise<GmailStatus> => jfetch("/api/gmail/status");
export const startGmailConnect = (): Promise<{ url: string }> => jfetch("/api/gmail/connect", { method: "POST" });
export const disconnectGmail = (): Promise<{ ok: true }> => jfetch("/api/gmail/disconnect", { method: "POST" });
export const syncGmail = (): Promise<NonNullable<GmailStatus["lastSync"]>> => jfetch("/api/gmail/sync", { method: "POST" });
