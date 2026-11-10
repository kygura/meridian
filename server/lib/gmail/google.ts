// Google OAuth (authorization code with PKCE) and the few Gmail REST calls the sync needs.
// Read-only: the only scope is gmail.readonly. All HTTP goes through an injectable fetch.

import { createHash, randomBytes } from "crypto";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GoogleError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

export function googleCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// ── PKCE ─────────────────────────────────────────────────────────────

export function newPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(48).toString("base64url"); // 64 characters, within RFC 7636's 43 to 128
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomBytes(24).toString("base64url") };
}

export function authorizationUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline", // a refresh token
    prompt: "consent", // Google only returns a refresh token on a consent screen
    include_granted_scopes: "false",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  }).toString();
  return u.toString();
}

async function tokenRequest(fetchImpl: FetchLike, body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }> {
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !j.access_token) throw new GoogleError(res.status, j.error ?? "token_error", `Google refused the token request (${j.error ?? res.status})`);
  return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, refresh_token: j.refresh_token, scope: j.scope };
}

export function exchangeCode(fetchImpl: FetchLike, p: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string }) {
  return tokenRequest(fetchImpl, {
    grant_type: "authorization_code",
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  });
}

export function refreshAccessToken(fetchImpl: FetchLike, p: { refreshToken: string; clientId: string; clientSecret: string }) {
  return tokenRequest(fetchImpl, { grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret });
}

/** Best effort: the token is forgotten locally whether or not Google answers. */
export async function revokeToken(fetchImpl: FetchLike, token: string): Promise<boolean> {
  try {
    const res = await fetchImpl(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Gmail ────────────────────────────────────────────────────────────

export interface GmailApi {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  listIds(q: string, pageToken?: string): Promise<{ ids: string[]; next?: string }>;
  /** Ids of messages added since `startHistoryId`; null when Google no longer has that history (about a week). */
  addedSince(startHistoryId: string): Promise<string[] | null>;
  /** The message as RFC 822 bytes. Held in memory by the caller and never stored. */
  raw(id: string): Promise<Uint8Array | null>;
}

export function createGmailApi(accessToken: string, fetchImpl: FetchLike): GmailApi {
  async function get<T>(path: string, allow404 = false): Promise<T | null> {
    const res = await fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
      throw new GoogleError(res.status, j.error?.status ?? "gmail_error", `Gmail answered ${res.status}${j.error?.status ? ` (${j.error.status})` : ""}`);
    }
    return (await res.json()) as T;
  }
  return {
    async profile() {
      return (await get<{ emailAddress: string; historyId: string }>("/profile"))!;
    },
    async listIds(q, pageToken) {
      const qs = new URLSearchParams({ q, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      const j = (await get<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${qs}`))!;
      return { ids: (j.messages ?? []).map((m) => m.id), next: j.nextPageToken };
    },
    async addedSince(startHistoryId) {
      const ids = new Set<string>();
      let token: string | undefined;
      for (let i = 0; i < 20; i++) {
        const qs = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500", ...(token ? { pageToken: token } : {}) });
        const j = await get<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string }>(`/history?${qs}`, true);
        if (!j) return null;
        for (const h of j.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
        if (!j.nextPageToken) return [...ids];
        token = j.nextPageToken;
      }
      return [...ids];
    },
    async raw(id) {
      const j = await get<{ raw?: string }>(`/messages/${encodeURIComponent(id)}?format=raw`, true);
      return j?.raw ? new Uint8Array(Buffer.from(j.raw, "base64url")) : null;
    },
  };
}
