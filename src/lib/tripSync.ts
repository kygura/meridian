// Keeps browser trips in step with the server (/api/trips, token-gated; ADR 0006).
//
// Runs only while the journal is unlocked. Without a token, trips stay local, as before.
// Merge is three-way per trip: this browser's copy, the server's, and `base` (the
// server's copy as of this browser's last sync, kept in localStorage). So an edit or
// delete made here while offline survives the next pull, and a trip deleted on
// another device is dropped here instead of being re-uploaded.

import { useMeridianStore } from "../store";
import type { Trip } from "../types";
import { getToken, jfetch, JournalLockedError } from "./journalApi";

const BASE_KEY = "meridian.tripSync.base";
const PUSH_DELAY_MS = 800;
const RETRY_MS = 30_000;

/** Map of trip id → fingerprint of the synced fields. */
export type SyncBase = Record<string, string>;

export function tripFingerprint(t: Pick<Trip, "name" | "color" | "status" | "nodes">): string {
  return JSON.stringify({
    name: t.name,
    color: t.color,
    status: t.status,
    nodes: t.nodes.map(({ cityId, name, iata, lat, lng }) => ({ cityId, name, iata, lat, lng })),
  });
}

function toTrip(t: Trip & { updatedAt?: string }): Trip {
  const { updatedAt: _u, ...rest } = t;
  return { ...rest, origin: "manual" };
}

/**
 * Merge a server snapshot into local trips. Returns the trips to keep locally and the new
 * base; anything that then differs from the base is pushed (PUT), and base ids missing
 * from the trips are deleted on the server.
 */
export function mergeRemote(
  local: Trip[],
  remote: (Trip & { updatedAt?: string })[],
  deleted: string[],
  base: SyncBase
): { trips: Trip[]; base: SyncBase } {
  const remoteById = new Map(remote.map((t) => [t.id, t]));
  const localIds = new Set(local.map((t) => t.id));
  const gone = new Set(deleted);
  const nextBase: SyncBase = {};
  for (const t of remote) nextBase[t.id] = tripFingerprint(t);

  const trips: Trip[] = [];
  for (const t of local) {
    const r = remoteById.get(t.id);
    if (r) {
      // Edited here since the last sync → keep ours (it'll be pushed). Otherwise take theirs.
      const editedHere = t.id in base && tripFingerprint(t) !== base[t.id];
      trips.push(editedHere ? t : toTrip(r));
    } else if (gone.has(t.id)) {
      // Deleted on another device: drop it.
    } else {
      trips.push(t); // never synced → upload
    }
  }
  for (const r of remote) {
    if (localIds.has(r.id)) continue;
    if (r.id in base) continue; // deleted here while offline → stays out; push deletes it remotely
    trips.push(toTrip(r));
  }
  return { trips, base: nextBase };
}

/** What a push has to do to bring the server to `trips`. */
export function pendingChanges(trips: Trip[], base: SyncBase): { put: Trip[]; del: string[] } {
  const ids = new Set(trips.map((t) => t.id));
  return {
    put: trips.filter((t) => base[t.id] !== tripFingerprint(t)),
    del: Object.keys(base).filter((id) => !ids.has(id)),
  };
}

// ── Runtime ──────────────────────────────────────────────────────────

function loadBase(): SyncBase {
  try {
    const raw = window.localStorage.getItem(BASE_KEY);
    return raw ? (JSON.parse(raw) as SyncBase) : {};
  } catch {
    return {};
  }
}

function saveBase(base: SyncBase): void {
  try {
    window.localStorage.setItem(BASE_KEY, JSON.stringify(base));
  } catch {
    /* private window: we just re-pull next time */
  }
}

export function clearTripSyncBase(): void {
  try {
    window.localStorage.removeItem(BASE_KEY);
  } catch {
    /* nothing stored */
  }
}

const userTrips = () => useMeridianStore.getState().trips.filter((t) => t.origin !== "agent");

let active = false;
let base: SyncBase = {};
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pushing: Promise<void> | null = null;

function stop(): void {
  active = false;
  clearTimeout(pushTimer);
}

function schedulePush(delay = PUSH_DELAY_MS): void {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void push(), delay);
}

async function push(): Promise<void> {
  if (!active) return;
  if (pushing) return pushing;
  const run = async () => {
    try {
      const { put, del } = pendingChanges(userTrips(), base);
      for (const t of put) {
        const body = JSON.parse(tripFingerprint(t));
        await jfetch(`/api/trips/${encodeURIComponent(t.id)}`, { method: "PUT", body: JSON.stringify(body) });
        base = { ...base, [t.id]: tripFingerprint(t) };
        saveBase(base);
      }
      for (const id of del) {
        await jfetch(`/api/trips/${encodeURIComponent(id)}`, { method: "DELETE" });
        const { [id]: _gone, ...rest } = base;
        base = rest;
        saveBase(base);
      }
    } catch (err) {
      if (err instanceof JournalLockedError) stop();
      else schedulePush(RETRY_MS);
      return;
    }
    // Edits made while this push ran.
    const left = pendingChanges(userTrips(), base);
    if (active && (left.put.length || left.del.length)) schedulePush();
  };
  // Clear the flag asynchronously: `run` can finish synchronously when there is nothing to send.
  pushing = run().finally(() => {
    pushing = null;
  });
  return pushing;
}

async function pull(): Promise<void> {
  if (!getToken()) return stop();
  let data: { trips: (Trip & { updatedAt?: string })[]; deleted: string[] };
  try {
    data = await jfetch("/api/trips");
  } catch (err) {
    if (err instanceof JournalLockedError) return stop();
    if (active) schedulePush(RETRY_MS);
    return;
  }
  const state = useMeridianStore.getState();
  const agent = state.trips.filter((t) => t.origin === "agent");
  const merged = mergeRemote(userTrips(), data.trips, data.deleted, active ? base : loadBase());
  base = merged.base;
  saveBase(base);
  active = true;
  const trips = [...merged.trips, ...agent];
  const activeTripId = trips.some((t) => t.id === state.activeTripId) ? state.activeTripId : (merged.trips[0]?.id ?? null);
  useMeridianStore.setState({ trips, activeTripId });
  await push();
}

let started = false;

/** Call once at startup. Syncs whenever a token is present; returns a stop function. */
export function startTripSync(onTokenChange: (cb: () => void) => () => void): () => void {
  if (started) return () => {};
  started = true;
  const unsubStore = useMeridianStore.subscribe((s, prev) => {
    if (active && s.trips !== prev.trips) schedulePush();
  });
  const unsubToken = onTokenChange(() => {
    stop();
    if (getToken()) return void pull();
    // Locked or forgotten: the next unlock may be a different server, so start clean.
    clearTripSyncBase();
    base = {};
  });
  const onFocus = () => {
    if (active) void push().then(pull);
  };
  window.addEventListener("focus", onFocus);
  if (getToken()) void pull();
  return () => {
    stop();
    started = false;
    unsubStore();
    unsubToken();
    window.removeEventListener("focus", onFocus);
  };
}
