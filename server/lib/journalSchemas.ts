// zod (v3) schemas for the journal trust boundary. Shared by the journal routes
// and later tasks (import queue, replay, watches) so Money/Provenance/Segment are
// validated identically everywhere. Shapes follow src/types.ts "Journal & Replay";
// input-only leniency: Money may omit eur/rateDate (R5), and array/provenance
// fields default when absent. Server-owned fields (id, timestamps, fingerprint,
// stop.observed/fingerprint) are not accepted — zod strips unknown keys.

import { z } from "zod";

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "invalid calendar date");

/** YYYY-MM-DD or an ISO 8601 datetime ("2024-05-02T09:40", "...Z", "...+01:00"). */
export const isoDateOrDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, "expected ISO date or datetime")
  .refine((s) => isoDateSchema.safeParse(s.slice(0, 10)).success, "invalid calendar date");

export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "expected ISO 4217 code")
  .transform((s) => s.toUpperCase());

/** Money as sent by clients: eur/rateDate optional, filled server-side by fx. */
export const moneyInputSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: currencySchema,
  eur: z.number().finite().nonnegative().optional(),
  rateDate: isoDateSchema.optional(),
});

export const confidenceSchema = z.enum(["high", "medium", "low"]);

export const provenanceSchema = z.object({
  source: z.enum(["manual", "booking", "gmail", "jsonld", "calendar", "timeline", "photo"]),
  sourceRef: z.string().min(1).max(500).optional(),
  confidence: confidenceSchema,
  importedAt: z.string().datetime({ offset: true }).optional(),
});

const MANUAL: z.infer<typeof provenanceSchema> = { source: "manual", confidence: "high" };
const provenanceWithDefault = provenanceSchema.default(MANUAL);

export const ratingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

const cityIdSchema = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(300);

export const lodgingSchema = z.object({
  name: shortText,
  kind: z.enum(["hotel", "apartment", "hostel", "friends", "other"]).optional(),
  cost: moneyInputSchema.optional(),
  provenance: provenanceWithDefault,
});

export const stopSchema = z.object({
  cityId: cityIdSchema,
  arrive: isoDateSchema,
  depart: isoDateSchema,
  lodging: lodgingSchema.optional(),
  rating: ratingSchema.optional(),
  crowdOverride: z.number().min(0).max(100).optional(),
});

export const segmentModeSchema = z.enum(["flight", "train", "bus", "car", "ferry", "other"]);

export const segmentSchema = z.object({
  mode: segmentModeSchema,
  fromCityId: cityIdSchema,
  toCityId: cityIdSchema,
  departAt: isoDateOrDateTimeSchema,
  arriveAt: isoDateOrDateTimeSchema.optional(),
  carrier: z.string().trim().max(100).optional(),
  number: z.string().trim().max(20).optional(),
  cost: moneyInputSchema.optional(),
  bookingRef: z.string().trim().max(100).optional(),
  bookingId: z.string().trim().max(200).optional(),
  provenance: provenanceWithDefault,
});

export const experienceSchema = z.object({
  cityId: cityIdSchema,
  date: isoDateSchema,
  title: shortText,
  kind: z.enum(["food", "tour", "nature", "event", "culture", "nightlife", "other"]).optional(),
  cost: moneyInputSchema.optional(),
  rating: ratingSchema.optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  provenance: provenanceWithDefault,
});

export const journeyStatusSchema = z.enum(["draft", "confirmed"]);

export const journeyInputSchema = z.object({
  title: shortText,
  status: journeyStatusSchema.optional(),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  stops: z.array(stopSchema).min(1).max(200),
  segments: z.array(segmentSchema).max(500).default([]),
  experiences: z.array(experienceSchema).max(1000).default([]),
  rating: ratingSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
  notes: z.string().max(20000).optional(),
  companions: z.number().int().min(0).max(100).optional(),
  fromTripId: z.string().max(200).optional(),
  bookingIds: z.array(z.string().min(1).max(200)).max(200).default([]),
  provenance: provenanceWithDefault,
});

export const journalSettingsSchema = z.object({
  homeCityId: cityIdSchema.optional(),
});

export type MoneyInputBody = z.infer<typeof moneyInputSchema>;
/** Parsed journey body: like JourneyInput but Money may lack eur/rateDate. */
export type JourneyInputBody = z.infer<typeof journeyInputSchema>;
/** What callers may pass to create/update before parsing (defaults not applied yet). */
export type JourneyInputRaw = z.input<typeof journeyInputSchema>;
