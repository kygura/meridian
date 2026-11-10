// In-app Gmail import (ADR 0017): connect with Google OAuth, find travel confirmations with
// the queries of docs/ingest/gmail-import-task.md, run each message through the existing
// JSON-LD / .eml parser and land the candidates in the review Inbox.
//
// What is stored: the refresh token (encrypted, key from the environment), the account's
// address, a history id and a progress cursor, message ids already seen, and counts.
// Message bodies are read into memory, parsed, and dropped; only extracted fields reach the Inbox.

import { addAll, flagCancelled } from "../imports.js";
import { parseEmailUpload } from "../ingest/jsonld.js";
import { createJsonStore } from "../jsonStore.js";
import { decryptToken, encryptToken, tokenKeyConfigured } from "./crypto.js";
import { GMAIL_SCOPE, GoogleError, authorizationUrl, createGmailApi, exchangeCode, googleCredentials, newPkce, refreshAccessToken, revokeToken, type FetchLike, type GmailApi } from "./google.js";

export const MAX_FETCH_PER_SYNC = 120;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_SEEN = 5000;
const DEFAULT_BACKFILL_YEARS = 3;

// The sender lists are a starting point, as in the stored prompt.
export const TRAVEL_QUERIES: string[] = [
  'subject:("e-ticket" OR "booking confirmation" OR itinerary OR "boarding pass") from:(ryanair.com OR easyjet.com OR wizzair.com OR lufthansa.com OR ba.com OR airfrance.com OR klm.com OR turkishairlines.com OR vueling.com)',
  'subject:(reservation OR confirmation OR "booking confirmation") from:(booking.com OR airbnb.com OR expedia.com OR hotels.com)',
  "from:(thetrainline.com OR bahn.de OR eurostar.com OR sncf-connect.com OR trenitalia.com OR renfe.com OR flixbus.com)",
  "subject:(reservation OR confirmation OR booking) from:(sixt.com OR hertz.com OR europcar.com OR enterprise.com)",
  'subject:(tickets OR "your order" OR "booking confirmation") from:(getyourguide.com OR viator.com OR ticketmaster.com OR eventbrite.com)',
].map((q) => `${q} -category:promotions`);

export interface LastSync {
  at: string;
  mode: "backfill" | "incremental";
  messages: number;
  unstructured: number;
  candidates: number;
  added: number;
  duplicates: number;
  cancelled: number;
  /** Backfill only: false while older years are still to be scanned. */
  complete: boolean;
  error?: string;
}

interface GmailFile {
  version: 1;
  connection?: { refresh: string; account: string; connectedAt: string };
  pending: { state: string; verifier: string; redirectUri: string; at: string }[];
  sync: {
    historyId?: string;
    backfill?: { year: number; q: number; pageToken?: string; startHistoryId: string };
    seen: string[];
    last?: LastSync;
  };
}

const store = createJsonStore<GmailFile>("gmail.json", () => ({ version: 1, pending: [], sync: { seen: [] } }));

export class GmailSetupError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "GmailSetupError";
  }
}

export interface GmailDeps {
  fetch?: FetchLike;
  now?: () => Date;
  /** Test seam for the Gmail calls. */
  api?: (accessToken: string) => GmailApi;
  fromYear?: number;
}

const fetchOf = (d: GmailDeps): FetchLike => d.fetch ?? fetch;
const nowOf = (d: GmailDeps) => d.now?.() ?? new Date();

// ── Status ───────────────────────────────────────────────────────────

export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) missing.push("GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) missing.push("GOOGLE_CLIENT_SECRET");
  if (!tokenKeyConfigured()) missing.push("GMAIL_TOKEN_KEY");
  return missing;
}

export async function getGmailStatus(redirectUri: string) {
  const f = await store.read();
  const missing = missingConfig();
  return {
    configured: missing.length === 0,
    missing,
    connected: !!f.connection,
    account: f.connection?.account,
    connectedAt: f.connection?.connectedAt,
    lastSync: f.sync.last ?? null,
    redirectUri,
    scope: GMAIL_SCOPE,
  };
}

// ── Connect / disconnect ─────────────────────────────────────────────

function requireConfigured() {
  const missing = missingConfig();
  if (missing.length) throw new GmailSetupError(`Set ${missing.join(", ")} on the server first.`);
  return googleCredentials()!;
}

/** Starts the consent flow: remembers the PKCE verifier against a random state and returns Google's URL. */
export async function beginConnect(redirectUri: string, deps: GmailDeps = {}): Promise<string> {
  const { clientId } = requireConfigured();
  const p = newPkce();
  const now = nowOf(deps).getTime();
  await store.update((f) => {
    f.pending = f.pending.filter((x) => now - Date.parse(x.at) < PENDING_TTL_MS).slice(-4);
    f.pending.push({ state: p.state, verifier: p.verifier, redirectUri, at: new Date(now).toISOString() });
  });
  return authorizationUrl({ clientId, redirectUri, challenge: p.challenge, state: p.state });
}

/** Finishes the flow from Google's redirect. The state must be one this server issued in the last 10 minutes, and is single-use. */
export async function completeConnect(code: string, state: string, deps: GmailDeps = {}): Promise<{ account: string }> {
  const { clientId, clientSecret } = requireConfigured();
  const now = nowOf(deps).getTime();
  const pending = await store.update((f) => {
    const hit = f.pending.find((x) => x.state === state && now - Date.parse(x.at) < PENDING_TTL_MS);
    f.pending = f.pending.filter((x) => x.state !== state);
    return hit;
  });
  if (!pending) throw new GmailSetupError("This sign-in link expired or was not started here. Connect again from Settings.", 409);
  const tokens = await exchangeCode(fetchOf(deps), { code, verifier: pending.verifier, redirectUri: pending.redirectUri, clientId, clientSecret });
  if (!tokens.scope?.split(" ").includes(GMAIL_SCOPE)) throw new GmailSetupError("Gmail read access was not granted.");
  if (!tokens.refresh_token) throw new GmailSetupError("Google did not return a refresh token. Remove Meridian under your Google account's third-party access, then connect again.");
  const api = (deps.api ?? ((t) => createGmailApi(t, fetchOf(deps))))(tokens.access_token);
  const profile = await api.profile();
  await store.update((f) => {
    f.connection = { refresh: encryptToken(tokens.refresh_token!), account: profile.emailAddress, connectedAt: nowOf(deps).toISOString() };
    f.sync = { seen: [] };
  });
  return { account: profile.emailAddress };
}

/** Forgets the token first, then tells Google to revoke it. Already-imported candidates stay in the Inbox. */
export async function disconnect(deps: GmailDeps = {}): Promise<void> {
  const refresh = await store.update((f) => {
    const sealed = f.connection?.refresh;
    f.connection = undefined;
    f.pending = [];
    f.sync = { seen: [] };
    return sealed;
  });
  if (!refresh) return;
  try {
    await revokeToken(fetchOf(deps), decryptToken(refresh));
  } catch {
    /* key changed or value damaged: nothing to revoke from here */
  }
}

// ── Sync ─────────────────────────────────────────────────────────────

let running = false;
const day = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;

interface Collected {
  candidates: unknown[];
  cancelled: unknown[];
  messages: number;
  unstructured: number;
  errors: number;
}

async function fetchAndParse(api: GmailApi, ids: string[], out: Collected, seen: Set<string>): Promise<void> {
  for (const id of ids) {
    let raw: Uint8Array | null;
    try {
      raw = await api.raw(id);
    } catch (err) {
      if (err instanceof GoogleError && (err.status === 401 || err.status === 403 || err.status === 429)) throw err;
      out.errors++;
      continue;
    }
    seen.add(id);
    if (!raw) continue; // deleted since it was listed
    out.messages++;
    try {
      const parsed = parseEmailUpload(raw);
      out.unstructured += parsed.unstructured;
      // The message id replaces the Message-ID header as the dedupe reference, and the source says where it came from.
      const retag = (c: unknown, n: number) => {
        const cand = c as { provenance: Record<string, unknown> };
        return { ...cand, provenance: { ...cand.provenance, source: "gmail", sourceRef: `${id}#${n}` } };
      };
      parsed.candidates.forEach((c, n) => out.candidates.push(retag(c, n)));
      parsed.cancelled.forEach((c, n) => out.cancelled.push(retag(c, n)));
    } catch {
      out.errors++;
    }
  }
}

async function accessTokenFor(sealed: string, deps: GmailDeps): Promise<string> {
  const { clientId, clientSecret } = requireConfigured();
  let refreshToken: string;
  try {
    refreshToken = decryptToken(sealed);
  } catch {
    throw new GmailSetupError("The stored Gmail token cannot be read (GMAIL_TOKEN_KEY changed?). Disconnect and connect again.", 409);
  }
  try {
    return (await refreshAccessToken(fetchOf(deps), { refreshToken, clientId, clientSecret })).access_token;
  } catch (err) {
    if (err instanceof GoogleError && err.code === "invalid_grant") throw new GmailSetupError("Google no longer accepts the saved access. Disconnect and connect again.", 409);
    throw err;
  }
}

/**
 * One sync pass. The first passes backfill year by year (oldest first, at most MAX_FETCH_PER_SYNC
 * messages per pass, resuming where the last stopped); after that each pass asks Gmail's history
 * for messages added since the last history id and fetches the ones matching the travel queries.
 */
export async function syncGmail(deps: GmailDeps = {}): Promise<LastSync> {
  requireConfigured();
  if (running) throw new GmailSetupError("A sync is already running.", 409);
  running = true;
  try {
    const f0 = await store.read();
    if (!f0.connection) throw new GmailSetupError("Gmail is not connected.");
    const now = nowOf(deps);
    const api = (deps.api ?? ((t) => createGmailApi(t, fetchOf(deps))))(await accessTokenFor(f0.connection.refresh, deps));
    const profile = await api.profile();
    const seen = new Set(f0.sync.seen);
    const out: Collected = { candidates: [], cancelled: [], messages: 0, unstructured: 0, errors: 0 };
    const budget = () => MAX_FETCH_PER_SYNC - out.messages - out.errors;
    let mode: LastSync["mode"];
    let complete = true;
    let backfill = f0.sync.backfill;
    let historyId = f0.sync.historyId;

    if (!historyId) {
      mode = "backfill";
      backfill ??= { year: deps.fromYear ?? (Number(process.env.GMAIL_BACKFILL_FROM_YEAR) || now.getUTCFullYear() - DEFAULT_BACKFILL_YEARS), q: 0, startHistoryId: profile.historyId };
      scan: while (backfill.year <= now.getUTCFullYear()) {
        while (backfill.q < TRAVEL_QUERIES.length) {
          const query = `${TRAVEL_QUERIES[backfill.q]} after:${backfill.year}/01/01 before:${backfill.year + 1}/01/01`;
          for (;;) {
            const page = await api.listIds(query, backfill.pageToken);
            const fresh = page.ids.filter((id) => !seen.has(id));
            if (fresh.length > budget()) {
              await fetchAndParse(api, fresh.slice(0, Math.max(0, budget())), out, seen);
              complete = false;
              break scan; // keep this page's token: ids already seen are skipped next time
            }
            await fetchAndParse(api, fresh, out, seen);
            if (!page.next) break;
            backfill.pageToken = page.next;
          }
          backfill.q++;
          backfill.pageToken = undefined;
        }
        backfill.year++;
        backfill.q = 0;
      }
      if (complete) {
        historyId = backfill.startHistoryId;
        backfill = undefined;
      }
    } else {
      mode = "incremental";
      const added = await api.addedSince(historyId);
      const last = f0.sync.last ? new Date(f0.sync.last.at) : new Date(now.getTime() - 30 * 86_400_000);
      const since = day(new Date(Math.min(last.getTime(), now.getTime()) - 2 * 86_400_000));
      if (added === null || added.length) {
        // When history is gone (null), fall back to the last window by query alone.
        const addedSet = added ? new Set(added) : null;
        const want = new Set<string>();
        for (const q of TRAVEL_QUERIES) {
          let token: string | undefined;
          for (let i = 0; i < 5; i++) {
            const page = await api.listIds(`${q} after:${since}`, token);
            for (const id of page.ids) if ((!addedSet || addedSet.has(id)) && !seen.has(id)) want.add(id);
            if (!page.next) break;
            token = page.next;
          }
        }
        const ids = [...want];
        await fetchAndParse(api, ids.slice(0, Math.max(0, budget())), out, seen);
        if (ids.length > MAX_FETCH_PER_SYNC) complete = false;
      }
      if (complete) historyId = profile.historyId;
    }

    let report = { added: 0, duplicates: 0 };
    let cancelled = 0;
    if (out.candidates.length) report = await addAll(out.candidates, now);
    if (out.cancelled.length) cancelled = await flagCancelled(out.cancelled, now);

    const last: LastSync = {
      at: now.toISOString(),
      mode,
      messages: out.messages,
      unstructured: out.unstructured,
      candidates: out.candidates.length,
      added: report.added,
      duplicates: report.duplicates,
      cancelled,
      complete: mode === "backfill" ? complete : true,
      ...(out.errors ? { error: `${out.errors} message${out.errors === 1 ? "" : "s"} could not be read` } : {}),
    };
    await store.update((f) => {
      f.sync = { historyId, backfill, seen: [...seen].slice(-MAX_SEEN), last };
    });
    return last;
  } catch (err) {
    // Keep the failure visible in Settings without touching the cursor.
    const message = err instanceof GoogleError ? err.message : err instanceof GmailSetupError ? err.message : "Sync failed";
    await store
      .update((f) => {
        f.sync.last = { at: nowOf(deps).toISOString(), mode: f.sync.historyId ? "incremental" : "backfill", messages: 0, unstructured: 0, candidates: 0, added: 0, duplicates: 0, cancelled: 0, complete: false, error: message };
      })
      .catch(() => {});
    throw err;
  } finally {
    running = false;
  }
}

/** For the daily-job hook. Never throws; does nothing unless Gmail is configured and connected. */
export async function runGmailDaily(deps: GmailDeps = {}): Promise<Record<string, unknown>> {
  if (missingConfig().length) return { skipped: "not configured" };
  if (!(await store.read()).connection) return { skipped: "not connected" };
  try {
    const r = await syncGmail(deps);
    return { mode: r.mode, messages: r.messages, added: r.added, duplicates: r.duplicates, complete: r.complete };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "failed" };
  }
}
