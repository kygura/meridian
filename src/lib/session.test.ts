import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_TOKEN_KEY,
  LockedOutError,
  SESSION_FLAG_KEY,
  SignInUnavailableError,
  WrongPasswordError,
  checkSession,
  isSignedIn,
  noteUnauthorized,
  onSessionChange,
  resetSessionForTests,
  sessionEnded,
  sessionMarker,
  signIn,
  signOut,
  waitText,
} from "./session";
import { getToken, hasToken, jfetch, JournalLockedError } from "./journalApi";
import { BookingLockedError, listBookings, searchOffers } from "./bookingApi";
import { useMeridianStore } from "../store";

/** A localStorage stand-in (tests run in Node). */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

type Call = [string, RequestInit | undefined];
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  });
  return calls;
}

let store: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  store = fakeStorage();
  vi.stubGlobal("window", { localStorage: store });
  resetSessionForTests();
  useMeridianStore.getState().setJournalLocked(false);
});
afterEach(() => vi.unstubAllGlobals());

describe("signIn", () => {
  it("posts the password once, keeps only a flag, and never stores the password", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { signedIn: true, user: { id: "owner" } } }));
    const seen: Array<string | null> = [];
    onSessionChange(() => seen.push(sessionMarker()));

    await signIn("hunter2 hunter2");

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/auth/login");
    expect(calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", body: '{"password":"hunter2 hunter2"}' });
    expect(isSignedIn()).toBe(true);
    expect(hasToken()).toBe(true);
    expect(getToken()).toBe("session-1");
    expect(seen).toEqual(["session-1"]);
    expect([...store.data.entries()]).toEqual([[SESSION_FLAG_KEY, "1"]]);
    expect(JSON.stringify([...store.data.entries()])).not.toContain("hunter2");
  });

  it("maps a wrong password, a lockout and an unconfigured server to their errors", async () => {
    stubFetch(() => ({ status: 401, body: { error: "unauthorized", attemptsLeft: 2 } }));
    await expect(signIn("x")).rejects.toMatchObject({ name: "WrongPasswordError", attemptsLeft: 2 });
    await expect(signIn("x")).rejects.toBeInstanceOf(WrongPasswordError);

    stubFetch(() => ({ status: 429, body: { error: "locked_out", retryAfterSeconds: 840 }, headers: { "Retry-After": "840" } }));
    const locked = await signIn("x").catch((e) => e);
    expect(locked).toBeInstanceOf(LockedOutError);
    expect(locked.retryAfterSeconds).toBe(840);

    stubFetch(() => ({ status: 401, body: { error: "journal_locked", reason: "token_not_configured" } }));
    await expect(signIn("x")).rejects.toBeInstanceOf(SignInUnavailableError);
    expect(useMeridianStore.getState().journalLockReason).toBe("token_not_configured");
    expect(isSignedIn()).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it("gives each sign-in a new marker so screens refetch", async () => {
    stubFetch(() => ({ status: 200, body: { signedIn: true } }));
    await signIn("p");
    const first = getToken();
    await signOut();
    expect(getToken()).toBeNull();
    await signIn("p");
    expect(getToken()).not.toBe(first);
  });
});

describe("signOut and server-ended sessions", () => {
  it("tells the server and forgets the flag, even offline", async () => {
    resetSessionForTests({ signedIn: true });
    store.setItem(SESSION_FLAG_KEY, "1");
    const calls = stubFetch(() => ({ status: 200, body: { signedIn: false } }));
    await signOut();
    expect(calls[0][0]).toBe("/api/auth/logout");
    expect(calls[0][1]).toMatchObject({ method: "POST" });
    expect(isSignedIn()).toBe(false);
    expect(sessionEnded()).toBe(false);
    expect(store.data.has(SESSION_FLAG_KEY)).toBe(false);

    resetSessionForTests({ signedIn: true });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await signOut();
    expect(isSignedIn()).toBe(false);
  });

  it("a 401 on a gated call signs this browser out and marks the session as ended", async () => {
    resetSessionForTests({ signedIn: true });
    stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(jfetch("/api/journal")).rejects.toBeInstanceOf(JournalLockedError);
    expect(isSignedIn()).toBe(false);
    expect(sessionEnded()).toBe(true);
    expect(useMeridianStore.getState().journalLocked).toBe(true);
  });

  it("jfetch sends the cookie policy and no Authorization header", async () => {
    resetSessionForTests({ signedIn: true });
    const calls = stubFetch(() => ({ status: 200, body: { journeys: [] } }));
    await jfetch("/api/journal");
    expect(calls[0][1]?.credentials).toBe("same-origin");
    expect(new Headers(calls[0][1]?.headers).has("Authorization")).toBe(false);
  });

  it("noteUnauthorized records why sign-in is unavailable", () => {
    noteUnauthorized("token_not_configured");
    expect(useMeridianStore.getState().journalLockReason).toBe("token_not_configured");
  });
});

describe("checkSession", () => {
  it("trusts the server over the flag", async () => {
    resetSessionForTests({ signedIn: true });
    stubFetch(() => ({ status: 200, body: { configured: true, signedIn: false } }));
    await checkSession();
    expect(isSignedIn()).toBe(false);
    expect(sessionEnded()).toBe(true);

    resetSessionForTests();
    stubFetch(() => ({ status: 200, body: { configured: true, signedIn: true } }));
    await checkSession();
    expect(isSignedIn()).toBe(true);
    expect(store.getItem(SESSION_FLAG_KEY)).toBe("1");
  });

  it("removes the old stored bearer token, using it once to sign in", async () => {
    store.setItem(LEGACY_TOKEN_KEY, "old-token");
    const calls = stubFetch((url) =>
      url.endsWith("/session") ? { status: 200, body: { configured: true, signedIn: false } } : { status: 200, body: { signedIn: true } }
    );
    await checkSession();
    expect(store.data.has(LEGACY_TOKEN_KEY)).toBe(false);
    expect(calls.map((c) => c[0])).toEqual(["/api/auth/session", "/api/auth/login"]);
    expect(calls[1][1]?.body).toBe('{"password":"old-token"}');
    expect(isSignedIn()).toBe(true);
    expect(JSON.stringify([...store.data.entries()])).not.toContain("old-token");
  });

  it("removes the old token even when it no longer works or the server is unreachable", async () => {
    store.setItem(LEGACY_TOKEN_KEY, "stale");
    stubFetch((url) => (url.endsWith("/session") ? { status: 200, body: { configured: true, signedIn: false } } : { status: 401, body: { error: "unauthorized" } }));
    await checkSession();
    expect(store.data.has(LEGACY_TOKEN_KEY)).toBe(false);
    expect(isSignedIn()).toBe(false);

    resetSessionForTests();
    store.setItem(LEGACY_TOKEN_KEY, "stale");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    await checkSession();
    expect(store.data.has(LEGACY_TOKEN_KEY)).toBe(false);
  });

  it("flags a server with no password", async () => {
    stubFetch(() => ({ status: 200, body: { configured: false, signedIn: false } }));
    await checkSession();
    expect(useMeridianStore.getState().journalLockReason).toBe("token_not_configured");
  });
});

describe("bookings need the session", () => {
  it("does not ask for the bookings list while signed out", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { bookings: [] } }));
    await expect(listBookings()).rejects.toBeInstanceOf(BookingLockedError);
    expect(calls).toHaveLength(0);
  });

  it("turns a 401 into BookingLockedError and ends the session", async () => {
    resetSessionForTests({ signedIn: true });
    stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(listBookings()).rejects.toBeInstanceOf(BookingLockedError);
    expect(isSignedIn()).toBe(false);
  });

  it("reports a locked flight search without touching the lock state of a signed-out browser", async () => {
    stubFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
    await expect(searchOffers({} as never)).rejects.toBeInstanceOf(BookingLockedError);
    expect(useMeridianStore.getState().journalLocked).toBe(false);
  });
});

describe("waitText", () => {
  it("rounds up to whole minutes", () => {
    expect(waitText(30)).toBe("30 seconds");
    expect(waitText(60)).toBe("1 minute");
    expect(waitText(61)).toBe("2 minutes");
    expect(waitText(900)).toBe("15 minutes");
  });
});
