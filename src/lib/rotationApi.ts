// Client for /api/rotation (ADR 0011). Owner-only: every call goes through jfetch, which
// sends the session cookie and turns a 401 into JournalLockedError.

import { jfetch, JournalApiError } from "./journalApi";
import type { PlaceProfile, RotationIssue, RotationSettings, RotationStay } from "./rotation";

export interface RotationSnapshot {
  settings: RotationSettings;
  stays: RotationStay[];
  places: PlaceProfile[];
  deleted: { kind: "stay" | "place"; id: string }[];
  today: string;
  currentStayId: string | null;
  issues: RotationIssue[];
}

/** The server holds a newer copy (another browser saved it), or the item was deleted there. */
export class RotationConflictError<T> extends Error {
  constructor(
    public kind: "conflict" | "deleted",
    public current: T | null
  ) {
    super(kind === "deleted" ? "Deleted in another browser" : "Changed in another browser");
    this.name = "RotationConflictError";
  }
}

const enc = encodeURIComponent;

async function put<T>(path: string, body: unknown, key: string): Promise<T> {
  try {
    const res = await jfetch<Record<string, T>>(path, { method: "PUT", body: JSON.stringify(body) });
    return res[key];
  } catch (err) {
    if (err instanceof JournalApiError && err.status === 409) {
      // jfetch keeps the error code; the current copy needs a second read.
      throw new RotationConflictError<T>(err.code === "deleted" ? "deleted" : "conflict", null);
    }
    throw err;
  }
}

export function getRotation(today?: string): Promise<RotationSnapshot> {
  return jfetch(`/api/rotation${today ? `?today=${enc(today)}` : ""}`);
}

/** What the server stores for a stay: everything but the id and the server stamp. */
export type StayBody = Omit<RotationStay, "id" | "updatedAt">;

export function stayBody(s: RotationStay): StayBody {
  const { id: _id, updatedAt: _u, ...rest } = s;
  return rest;
}

export function saveStay(stay: RotationStay, baseUpdatedAt?: string): Promise<RotationStay> {
  return put(`/api/rotation/stays/${enc(stay.id)}`, { stay: stayBody(stay), baseUpdatedAt }, "stay");
}

export async function removeStay(id: string): Promise<void> {
  await jfetch(`/api/rotation/stays/${enc(id)}`, { method: "DELETE" });
}

export function savePlace(place: PlaceProfile, baseUpdatedAt?: string): Promise<PlaceProfile> {
  const { cityId, updatedAt: _u, ...rest } = place;
  return put(`/api/rotation/places/${enc(cityId)}`, { place: rest, baseUpdatedAt }, "place");
}

export async function removePlace(cityId: string): Promise<void> {
  await jfetch(`/api/rotation/places/${enc(cityId)}`, { method: "DELETE" });
}

export function saveSettings(settings: RotationSettings, baseUpdatedAt?: string): Promise<RotationSettings> {
  const { updatedAt: _u, ...rest } = settings;
  return put(`/api/rotation/settings`, { ...rest, baseUpdatedAt }, "settings");
}
