// Server-side trips (ADR 0006). One document, "trips.json", in the shared store:
// a file under DATA_DIR or Postgres when DATABASE_URL is set.
//
// Each trip carries `updatedAt` (server-set). Deletes leave a tombstone so a device
// that still holds the trip drops it on its next sync instead of re-uploading it.
// Conflicts are per trip, last write wins.

import { z } from "zod";
import type { Trip } from "../../src/types.js";
import { createJsonStore } from "./jsonStore.js";
import { isoDateSchema, moneyInputSchema } from "./journalSchemas.js";
import { isLocalDateTime } from "../../src/lib/zoned.js";

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

const baseNodeSchema = z.object({
  cityId: z.string().min(1).max(200),
  name: z.string().max(200),
  iata: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ── Itinerary (ADR 0010; shapes in src/types.ts) ─────────────────────
/** A wall-clock time with no zone, as typed: YYYY-MM-DDTHH:MM. */
const localDateTime = z.string().refine(isLocalDateTime, "expected YYYY-MM-DDTHH:MM");
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
/** Links are opened from the trip, so only http(s). */
const link = z
  .string()
  .max(2000)
  .refine((s) => /^https?:\/\//i.test(s) && URL.canParse(s), "expected an http(s) link");
const money = moneyInputSchema.pick({ amount: true, currency: true });

const lodgingSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["hotel", "apartment", "hostel", "friends", "other"]).optional(),
  address: z.string().max(300).optional(),
  checkIn: isoDateSchema.optional(),
  checkOut: isoDateSchema.optional(),
  cost: money.optional(),
  bookingRef: z.string().max(80).optional(),
  link: link.optional(),
});

const activitySchema = z.object({
  id: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  date: isoDateSchema.optional(),
  time: clockTime.optional(),
  cost: money.optional(),
  link: link.optional(),
  note: z.string().max(1000).optional(),
});

const legPlanSchema = z.object({
  fromCityId: z.string().min(1).max(200),
  mode: z.enum(["flight", "train", "bus", "ferry", "drive"]).optional(),
  booked: z
    .object({
      carrier: z.string().max(100).optional(),
      number: z.string().max(20).optional(),
      reference: z.string().max(80).optional(),
      cost: money.optional(),
      departAt: localDateTime.optional(),
      arriveAt: localDateTime.optional(),
    })
    .optional(),
});

const nodeSchema = baseNodeSchema.extend({
  months: monthSpanSchema.optional(),
  arrive: isoDateSchema.optional(),
  depart: isoDateSchema.optional(),
  lodging: lodgingSchema.optional(),
  activities: z.array(activitySchema).max(200).optional(),
  notes: z.string().max(4000).optional(),
  travel: legPlanSchema.optional(),
});

export const tripInputSchema = z.object({
  name: z.string().max(200),
  color: z.string().max(32),
  status: z.enum(["draft", "scouting", "confirmed"]),
  nodes: z.array(nodeSchema).max(200),
  season: monthSpanSchema.optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  /** Home airport the route starts from; absent = the client's default (LPA). */
  departure: baseNodeSchema.optional(),
  /** false = one-way, no flight back to the departure. */
  returnHome: z.boolean().optional(),
  travellers: z.number().int().min(1).max(9).optional(),
  homeLeg: legPlanSchema.optional(),
});

export type TripInput = z.infer<typeof tripInputSchema>;

export const tripIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

export async function getTrip(id: string): Promise<StoredTrip | undefined> {
  return (await store.read()).trips.find((t) => t.id === id);
}

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
