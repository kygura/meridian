// Server-side rotation (ADR 0011). One document, "rotation.json", in the shared store:
// a file under DATA_DIR, or a row in Postgres when DATABASE_URL is set.
//
// Stays and place profiles are written one at a time, each stamped `updatedAt` by the
// server. A write names the `baseUpdatedAt` it was edited from; when the stored copy has
// moved on since (another browser saved it), the write is refused with the current copy
// instead of silently overwriting it. Deletes leave a tombstone so a browser holding the
// stay learns it is gone.

import { z } from "zod";
import { createJsonStore } from "./jsonStore.js";
import { isoDateSchema, moneyInputSchema } from "./journalSchemas.js";
import {
  DEFAULT_SETTINGS,
  MAX_HORIZON,
  MIN_HORIZON,
  STAY_KINDS,
  STAY_STATUSES,
  WINDOW_KINDS,
  currentStay,
  dueReminders,
  todayIso,
  type PlaceProfile,
  type Reminder,
  type RotationSettings,
  type RotationState,
  type RotationStay,
} from "../../src/lib/rotation.js";

export interface Tombstone {
  kind: "stay" | "place";
  id: string;
  deletedAt: string;
}

export interface RotationFile {
  version: 1;
  settings: RotationSettings;
  stays: RotationStay[];
  places: PlaceProfile[];
  deleted: Tombstone[];
}

const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;

const store = createJsonStore<RotationFile>("rotation.json", () => ({
  version: 1,
  settings: { ...DEFAULT_SETTINGS },
  stays: [],
  places: [],
  deleted: [],
}));

// ── Schemas ──────────────────────────────────────────────────────────

const month = z.number().int().min(1).max(12);
const monthSpan = z.object({ start: month, end: month });
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");
const money = moneyInputSchema.pick({ amount: true, currency: true });
const link = z
  .string()
  .max(2000)
  .refine((s) => /^https?:\/\//i.test(s) && URL.canParse(s), "expected an http(s) link");
const leadTime = z
  .object({ min: z.number().int().min(0).max(104), max: z.number().int().min(0).max(104) })
  .refine((l) => l.min <= l.max, "min must not exceed max");

export const placeSchema = z.object({
  cityId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  country: z.string().max(100).optional(),
  iata: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

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

const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("trip"), tripId: z.string().max(100) }),
  z.object({ kind: z.literal("journey"), journeyId: z.string().max(100), stopIndex: z.number().int().min(0) }),
  z.object({ kind: z.literal("solver"), runId: z.string().max(100).optional() }),
]);

export const stayInputSchema = z
  .object({
    place: placeSchema,
    kind: z.enum(STAY_KINDS as [string, ...string[]]),
    status: z.enum(STAY_STATUSES as [string, ...string[]]),
    start: isoDateSchema.optional(),
    end: isoDateSchema.optional(),
    window: z.object({ from: yearMonth, to: yearMonth }).refine((w) => w.from <= w.to, "window ends before it starts").optional(),
    minNights: z.number().int().min(1).max(1000).optional(),
    maxNights: z.number().int().min(1).max(1000).optional(),
    budgetMonthly: money.optional(),
    rentMonthly: money.optional(),
    lodging: lodgingSchema.optional(),
    notes: z.string().max(4000).optional(),
    locked: z.boolean().optional(),
    leadTime: leadTime.optional(),
    origin: originSchema.optional(),
  })
  // Leaving before arriving is a contradiction; a gap or an overlap with another stay is not (it is shown).
  .refine((s) => !(s.start && s.end) || s.start < s.end, { message: "move-out must be after move-in", path: ["end"] })
  .refine((s) => !(s.minNights && s.maxNights) || s.minNights <= s.maxNights, { message: "minimum exceeds maximum", path: ["maxNights"] });

export const windowSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(WINDOW_KINDS as [string, ...string[]]),
  months: monthSpan,
  reason: z.string().max(300).optional(),
  source: z.object({ kind: z.enum(["manual", "notion", "import"]), ref: z.string().max(300).optional() }).optional(),
});

export const placeInputSchema = z.object({
  name: z.string().min(1).max(200),
  country: z.string().max(100).optional(),
  windows: z.array(windowSchema).max(48),
  leadTime: leadTime.optional(),
  notes: z.string().max(4000).optional(),
});

export const settingsInputSchema = z.object({
  name: z.string().min(1).max(200),
  home: placeSchema.optional(),
  horizonMonths: z.number().int().min(MIN_HORIZON).max(MAX_HORIZON),
});

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const cityIdSchema = z.string().min(1).max(200).regex(/^[^/\\]+$/);

export type StayInput = z.infer<typeof stayInputSchema>;
export type PlaceInput = z.infer<typeof placeInputSchema>;
export type SettingsInput = z.infer<typeof settingsInputSchema>;

// ── Reads ────────────────────────────────────────────────────────────

export async function readRotation(): Promise<RotationFile> {
  const f = await store.read();
  return { ...f, settings: { ...DEFAULT_SETTINGS, ...f.settings } };
}

export function stateOf(f: RotationFile): RotationState {
  return { settings: f.settings, stays: f.stays, places: f.places };
}

/** The stay containing `today` (the owner's current base), or null between stays. */
export async function currentLocation(today = todayIso()): Promise<RotationStay | null> {
  return currentStay((await store.read()).stays, today);
}

/**
 * Booking reminders due on `today`, for a daily job (a notifier built separately calls
 * this and decides how to send). `noticeDays` is how far ahead a deadline counts as due.
 */
export async function rotationRemindersDue(today = todayIso(), noticeDays = 14): Promise<Reminder[]> {
  return dueReminders(stateOf(await readRotation()), today, noticeDays);
}

// ── Writes ───────────────────────────────────────────────────────────

export type WriteResult<T> = { ok: true; value: T } | { ok: false; conflict: "changed" | "deleted"; current: T | null };

function prune(f: RotationFile, now: Date): void {
  const cutoff = now.getTime() - TOMBSTONE_TTL_MS;
  f.deleted = f.deleted.filter((d) => Date.parse(d.deletedAt) > cutoff);
}

/**
 * Create or replace a stay. `baseUpdatedAt` is the copy the edit started from: absent for
 * a new stay. A stale base, or a base for a stay deleted elsewhere, is a conflict.
 */
export function putStay(id: string, input: StayInput, baseUpdatedAt: string | undefined, now = new Date()): Promise<WriteResult<RotationStay>> {
  return store.update((f) => {
    const idx = f.stays.findIndex((s) => s.id === id);
    const existing = idx === -1 ? undefined : f.stays[idx];
    if (existing && existing.updatedAt !== baseUpdatedAt) return { ok: false, conflict: "changed", current: existing };
    if (!existing && baseUpdatedAt && f.deleted.some((d) => d.kind === "stay" && d.id === id)) {
      return { ok: false, conflict: "deleted", current: null };
    }
    const stay = { id, ...input, updatedAt: now.toISOString() } as RotationStay;
    if (idx === -1) f.stays.push(stay);
    else f.stays[idx] = stay;
    f.deleted = f.deleted.filter((d) => !(d.kind === "stay" && d.id === id));
    return { ok: true, value: stay };
  });
}

/** Idempotent; records a tombstone either way. */
export function deleteStay(id: string, now = new Date()): Promise<boolean> {
  return store.update((f) => {
    const before = f.stays.length;
    f.stays = f.stays.filter((s) => s.id !== id);
    prune(f, now);
    f.deleted = f.deleted.filter((d) => !(d.kind === "stay" && d.id === id));
    f.deleted.push({ kind: "stay", id, deletedAt: now.toISOString() });
    return f.stays.length < before;
  });
}

export function putPlace(cityId: string, input: PlaceInput, baseUpdatedAt: string | undefined, now = new Date()): Promise<WriteResult<PlaceProfile>> {
  return store.update((f) => {
    const idx = f.places.findIndex((p) => p.cityId === cityId);
    const existing = idx === -1 ? undefined : f.places[idx];
    if (existing && existing.updatedAt !== baseUpdatedAt) return { ok: false, conflict: "changed", current: existing };
    const place = { cityId, ...input, updatedAt: now.toISOString() } as PlaceProfile;
    if (idx === -1) f.places.push(place);
    else f.places[idx] = place;
    f.deleted = f.deleted.filter((d) => !(d.kind === "place" && d.id === cityId));
    return { ok: true, value: place };
  });
}

export function deletePlace(cityId: string, now = new Date()): Promise<boolean> {
  return store.update((f) => {
    const before = f.places.length;
    f.places = f.places.filter((p) => p.cityId !== cityId);
    prune(f, now);
    f.deleted = f.deleted.filter((d) => !(d.kind === "place" && d.id === cityId));
    f.deleted.push({ kind: "place", id: cityId, deletedAt: now.toISOString() });
    return f.places.length < before;
  });
}

export function putSettings(input: SettingsInput, baseUpdatedAt: string | undefined, now = new Date()): Promise<WriteResult<RotationSettings>> {
  return store.update((f) => {
    const existing = f.settings;
    if (existing?.updatedAt && existing.updatedAt !== baseUpdatedAt) return { ok: false, conflict: "changed", current: existing };
    f.settings = { ...input, updatedAt: now.toISOString() };
    return { ok: true, value: f.settings };
  });
}
