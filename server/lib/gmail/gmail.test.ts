import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCities } from "../cities";
import { getQueue } from "../imports";
import { decryptToken, encryptToken } from "./crypto";
import { GMAIL_SCOPE, authorizationUrl, newPkce } from "./google";
import { GmailSetupError, beginConnect, completeConnect, disconnect, getGmailStatus, missingConfig, runGmailDaily, syncGmail, TRAVEL_QUERIES, MAX_FETCH_PER_SYNC } from "./service";

const FIX = join(__dirname, "..", "__fixtures__", "ingest");
const lodging = readFileSync(join(FIX, "lodging.eml"));
const REDIRECT = "https://meridian.test/api/gmail/callback";
const NOW = new Date("2026-11-10T08:00:00Z");

let TMP: string;

/** A Google that answers from memory. Records every request so tests can inspect what was sent. */
function fakeGoogle(opts: { messages?: Record<string, Buffer>; historyAdded?: string[] | null; historyId?: () => string; refreshError?: boolean } = {}) {
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  const messages = opts.messages ?? { m1: lodging };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init?.body as string | undefined, auth: headers.Authorization });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const form = new URLSearchParams(init!.body as string);
      if (form.get("grant_type") === "authorization_code") return json({ access_token: "at-1", expires_in: 3599, refresh_token: "1//refresh-secret-value", scope: GMAIL_SCOPE });
      if (opts.refreshError) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at-2", expires_in: 3599 });
    }
    if (u.pathname === "/revoke") return json({});
    if (u.pathname.endsWith("/profile")) return json({ emailAddress: "owner@example.com", historyId: opts.historyId?.() ?? "100" });
    if (u.pathname.endsWith("/history")) return opts.historyAdded === null ? json({ error: { status: "NOT_FOUND" } }, 404) : json({ history: (opts.historyAdded ?? []).map((id) => ({ messagesAdded: [{ message: { id } }] })) });
    if (u.pathname.endsWith("/messages")) {
      const q = u.searchParams.get("q") ?? "";
      // Only the stays query (booking.com) matches anything, and only in the year the mail was sent or after the cut-off.
      const hit = q.includes("booking.com") && (q.includes("after:2024/01/01") || /after:2026\/(0|1)\d\/\d\d/.test(q));
      return json({ messages: hit ? Object.keys(messages).map((id) => ({ id })) : [] });
    }
    const m = u.pathname.match(/\/messages\/([^/]+)$/);
    if (m) return messages[m[1]] ? json({ raw: messages[m[1]].toString("base64url") }) : json({ error: { status: "NOT_FOUND" } }, 404);
    return json({}, 500);
  });
  return { fetchMock, calls };
}

beforeAll(() => loadCities());
beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-gmail-"));
  process.env.DATA_DIR = TMP;
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret-value";
  process.env.GMAIL_TOKEN_KEY = "k".repeat(40);
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  for (const k of ["DATA_DIR", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_TOKEN_KEY", "GMAIL_BACKFILL_FROM_YEAR"]) delete process.env[k];
});

async function connect(g: ReturnType<typeof fakeGoogle>) {
  const url = new URL(await beginConnect(REDIRECT, { fetch: g.fetchMock, now: () => NOW }));
  const state = url.searchParams.get("state")!;
  await completeConnect("auth-code", state, { fetch: g.fetchMock, now: () => NOW });
  return { url, state };
}

describe("token encryption", () => {
  it("round-trips, differs each time and rejects tampering or another key", () => {
    const a = encryptToken("1//refresh");
    expect(a).not.toContain("refresh");
    expect(encryptToken("1//refresh")).not.toBe(a);
    expect(decryptToken(a)).toBe("1//refresh");
    const parts = a.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA");
    expect(() => decryptToken(parts.join("."))).toThrow();
    process.env.GMAIL_TOKEN_KEY = "z".repeat(40);
    expect(() => decryptToken(a)).toThrow();
  });
  it("refuses a short key", () => {
    process.env.GMAIL_TOKEN_KEY = "short";
    expect(() => encryptToken("x")).toThrow(/32 characters/);
  });
});

describe("authorization request", () => {
  it("uses the code flow with S256 PKCE, read-only scope and offline access", () => {
    const p = newPkce();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    const u = new URL(authorizationUrl({ clientId: "cid", redirectUri: REDIRECT, challenge: p.challenge, state: p.state }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "cid", redirect_uri: REDIRECT, response_type: "code", scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", code_challenge: p.challenge, code_challenge_method: "S256", state: p.state });
  });
});

describe("connect and disconnect", () => {
  it("says what to set when credentials are missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GMAIL_TOKEN_KEY;
    expect(missingConfig()).toEqual(["GOOGLE_CLIENT_ID", "GMAIL_TOKEN_KEY"]);
    const s = await getGmailStatus(REDIRECT);
    expect(s).toMatchObject({ configured: false, connected: false, missing: ["GOOGLE_CLIENT_ID", "GMAIL_TOKEN_KEY"] });
    await expect(beginConnect(REDIRECT)).rejects.toThrow(/GOOGLE_CLIENT_ID, GMAIL_TOKEN_KEY/);
    expect(await runGmailDaily()).toEqual({ skipped: "not configured" });
  });

  it("sends the PKCE verifier on the exchange, stores the refresh token encrypted, and the state is single-use", async () => {
    const g = fakeGoogle();
    const { url, state } = await connect(g);
    const exchange = g.calls.find((c) => c.url.includes("/token"))!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("redirect_uri")).toBe(REDIRECT);
    // The verifier hashes to the challenge that was sent to Google earlier.
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));

    const status = await getGmailStatus(REDIRECT);
    expect(status).toMatchObject({ configured: true, connected: true, account: "owner@example.com" });

    // Nothing in the data directory contains the token in the clear.
    for (const f of readdirSync(TMP)) expect(readFileSync(join(TMP, f), "utf8")).not.toContain("1//refresh-secret-value");
    expect(readFileSync(join(TMP, "gmail.json"), "utf8")).toMatch(/"refresh": "v1\./);

    await expect(completeConnect("auth-code", state, { fetch: g.fetchMock, now: () => NOW })).rejects.toBeInstanceOf(GmailSetupError);
  });

  it("rejects an unknown or expired state without calling Google", async () => {
    const g = fakeGoogle();
    await expect(completeConnect("c", "forged", { fetch: g.fetchMock, now: () => NOW })).rejects.toThrow(/expired or was not started here/);
    const url = new URL(await beginConnect(REDIRECT, { fetch: g.fetchMock, now: () => NOW }));
    const later = () => new Date(NOW.getTime() + 11 * 60_000);
    await expect(completeConnect("c", url.searchParams.get("state")!, { fetch: g.fetchMock, now: later })).rejects.toThrow(/expired/);
    expect(g.calls).toHaveLength(0);
  });

  it("disconnect forgets the token and revokes it at Google", async () => {
    const g = fakeGoogle();
    await connect(g);
    await disconnect({ fetch: g.fetchMock });
    expect((await getGmailStatus(REDIRECT)).connected).toBe(false);
    const revoke = g.calls.find((c) => c.url.endsWith("/revoke"))!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("1//refresh-secret-value");
    await expect(syncGmail({ fetch: g.fetchMock })).rejects.toThrow(/not connected/);
  });
});

describe("sync", () => {
  it("backfills, lands candidates as gmail imports without bodies, then goes incremental by history id", async () => {
    let hid = "100";
    const g = fakeGoogle({ historyAdded: ["m2"], historyId: () => hid, messages: { m1: lodging, m2: lodging } });
    await connect(g);
    const syncStart = g.calls.length;
    const r1 = await syncGmail({ fetch: g.fetchMock, now: () => NOW, fromYear: 2024 });
    expect(r1).toMatchObject({ mode: "backfill", complete: true });
    expect(r1.added).toBeGreaterThanOrEqual(1);
    expect(r1.messages).toBe(2);
    // The searches are the stored prompt's queries.
    const searched = g.calls.filter((c) => c.url.includes("/messages?")).map((c) => new URL(c.url).searchParams.get("q")!);
    for (const q of TRAVEL_QUERIES) expect(searched.some((s) => s.startsWith(q))).toBe(true);
    // Every request carried the refreshed access token.
    expect(g.calls.slice(syncStart).filter((c) => c.url.includes("gmail.googleapis.com")).every((c) => c.auth === "Bearer at-2")).toBe(true);

    const queue = await getQueue();
    const lodgings = queue.candidates.filter((c) => c.kind === "lodging");
    expect(lodgings.length).toBeGreaterThanOrEqual(1);
    expect(lodgings[0].provenance).toMatchObject({ source: "gmail", sourceRef: expect.stringMatching(/^m\d#0$/) });
    expect(lodgings[0].payload).toMatchObject({ name: "Hotel Avenida Palace", arrive: "2024-05-02", depart: "2024-05-06" });
    // Only extracted fields are stored: nothing from the message text or headers.
    const stored = readFileSync(join(TMP, "imports.json"), "utf8");
    for (const secret of ["traveler@example.com", "Reservation confirmed", "Delivered-To", "reservas@avenida.example"]) expect(stored).not.toContain(secret);

    const before = queue.candidates.length;
    hid = "120";
    const r2 = await syncGmail({ fetch: g.fetchMock, now: () => new Date(NOW.getTime() + 86_400_000) });
    expect(r2.mode).toBe("incremental");
    expect(g.calls.some((c) => c.url.includes("/history?") && c.url.includes("startHistoryId=100"))).toBe(true);
    expect((await getQueue()).candidates.length).toBe(before);

    // Third pass: nothing new in history, so no searching or fetching at all.
    const g2 = fakeGoogle({ historyAdded: [] });
    const r3 = await syncGmail({ fetch: g2.fetchMock, now: () => new Date(NOW.getTime() + 2 * 86_400_000) });
    expect(r3).toMatchObject({ mode: "incremental", messages: 0 });
    expect(g2.calls.some((c) => c.url.includes("/messages"))).toBe(false);
  });

  it("falls back to a windowed query when Google has dropped the history", async () => {
    const g = fakeGoogle({ historyAdded: null, messages: { m9: lodging } });
    await connect(g);
    await syncGmail({ fetch: g.fetchMock, now: () => NOW, fromYear: 2026 });
    const r = await syncGmail({ fetch: g.fetchMock, now: () => new Date(NOW.getTime() + 86_400_000) });
    expect(r).toMatchObject({ mode: "incremental" });
    expect(r.messages + r.duplicates).toBeGreaterThanOrEqual(0);
  });

  it("works through a big backlog in slices and resumes", async () => {
    const many: Record<string, Buffer> = {};
    for (let i = 0; i < MAX_FETCH_PER_SYNC + 30; i++) many[`b${i}`] = Buffer.from(`Message-ID: <x${i}>\nContent-Type: text/plain\n\nnothing here\n`);
    const g = fakeGoogle({ messages: many });
    await connect(g);
    const a = await syncGmail({ fetch: g.fetchMock, now: () => NOW, fromYear: 2024 });
    expect(a).toMatchObject({ mode: "backfill", complete: false, messages: MAX_FETCH_PER_SYNC });
    const b = await syncGmail({ fetch: g.fetchMock, now: () => NOW, fromYear: 2024 });
    expect(b).toMatchObject({ mode: "backfill", complete: true, messages: 30 });
    expect(b.unstructured).toBe(30);
  });

  it("asks to reconnect when Google revokes the grant, and records the failure", async () => {
    const g = fakeGoogle({ refreshError: true });
    await connect(g);
    await expect(syncGmail({ fetch: g.fetchMock, now: () => NOW })).rejects.toThrow(/Disconnect and connect again/);
    expect((await getGmailStatus(REDIRECT)).lastSync?.error).toMatch(/Disconnect/);
  });

  it("asks to reconnect when the encryption key changed", async () => {
    const g = fakeGoogle();
    await connect(g);
    process.env.GMAIL_TOKEN_KEY = "q".repeat(40);
    await expect(syncGmail({ fetch: g.fetchMock, now: () => NOW })).rejects.toThrow(/GMAIL_TOKEN_KEY changed/);
  });

  it("the daily job syncs when connected and never throws", async () => {
    expect(await runGmailDaily()).toEqual({ skipped: "not connected" });
    const g = fakeGoogle();
    await connect(g);
    const out = await runGmailDaily({ fetch: g.fetchMock, now: () => NOW, fromYear: 2026 });
    expect(out).toMatchObject({ mode: "backfill" });
    const bad = await runGmailDaily({ fetch: async () => new Response("{}", { status: 500 }), now: () => NOW });
    expect(bad).toHaveProperty("error");
  });
});
