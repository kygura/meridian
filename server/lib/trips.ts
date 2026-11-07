// Server-side trips (ADR 0006). One document, "trips.json", in the shared store:
// a file under DATA_DIR or Postgres when DATABASE_URL is set.
//
// Each trip carries `updatedAt` (server-set). Deletes leave a tombstone so a device
// that still holds the trip drops it on its next sync instead of re-uploading it.
// Conflicts are per trip, last write wins.

import { z } from "zod";
import type { Trip } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";

export interface StoredTrip extends Trip {
  updatedAt: string;
}

export interface TripsFile {
  version: 1;
  trips: StoredTrip[];
  deleted: { id: string; deletedAt: string }[];
}

/** Tombstones older than this are dropped; a device offline longer may resurrect a deleted trip. */
const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;

const store = createJsonStore<TripsFile>("trips.json", () => ({ version: 1, trips: [], deleted: [] }));

const month = z.number().int().min(1).max(12);
/** Months with no year (src/types.ts MonthSpan); start > end wraps the new year. */
const monthSpanSchema = z.object({ start: month, end: month });

const nodeSchema = z.object({
  cityId: z.string().min(1).max(200),
  name: z.string().max(200),
  iata: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  months: monthSpanSchema.optional(),
});

export const tripInputSchema = z.object({
  name: z.string().max(200),
  color: z.string().max(32),
  status: z.enum(["draft", "scouting", "confirmed"]),
  nodes: z.array(nodeSchema).max(200),
  season: monthSpanSchema.optional(),
  year: z.number().int().min(2000).max(2100).optional(),
});

export type TripInput = z.infer<typeof tripInputSchema>;

export const tripIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

export async function listTrips(): Promise<{ trips: StoredTrip[]; deleted: string[] }> {
  const file = await store.read();
  return { trips: file.trips, deleted: file.deleted.map((d) => d.id) };
}

export function putTrip(id: string, input: TripInput, now = new Date()): Promise<StoredTrip> {
  const trip: StoredTrip = { id, ...input, origin: "manual", updatedAt: now.toISOString() };
  return store.update((file) => {
    const idx = file.trips.findIndex((t) => t.id === id);
    if (idx === -1) file.trips.push(trip);
    else file.trips[idx] = trip;
    file.deleted = file.deleted.filter((d) => d.id !== id);
    return trip;
  });
}

/** Returns false when the trip didn't exist (a tombstone is still recorded). */
export function deleteTrip(id: string, now = new Date()): Promise<boolean> {
  return store.update((file) => {
    const before = file.trips.length;
    file.trips = file.trips.filter((t) => t.id !== id);
    const cutoff = now.getTime() - TOMBSTONE_TTL_MS;
    file.deleted = file.deleted.filter((d) => d.id !== id && Date.parse(d.deletedAt) > cutoff);
    file.deleted.push({ id, deletedAt: now.toISOString() });
    return file.trips.length < before;
  });
}
