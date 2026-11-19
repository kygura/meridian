// Atlas on Meridian (ADR 0020): input and stored shapes for /api/atlas.
// Atlas's own repository mirrors these types in its Meridian client; change both together.

import { z } from "zod";
import { isoDateSchema } from "../journalSchemas.js";

const iata = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "a 3-letter IATA code")
  .transform((s) => s.toUpperCase());
const month = z.number().int().min(1).max(12);
const link = z
  .string()
  .max(2000)
  .refine((s) => /^https?:\/\//i.test(s) && URL.canParse(s), "expected an http(s) link");
const score5 = z.number().int().min(1).max(5);
const eur = z.number().finite().nonnegative();

/** A place as Atlas names it: a Meridian city id, an airport code, or a name to search. */
export const placeRefSchema = z.union([
  z.object({ cityId: z.string().min(1).max(200) }),
  z.object({ iata }),
  z.object({ query: z.string().trim().min(1).max(200) }),
]);
export type PlaceRef = z.infer<typeof placeRefSchema>;

// ── Config ───────────────────────────────────────────────────────────

const rangeSchema = z.object({ min: eur, max: eur }).refine((r) => r.min <= r.max, "min exceeds max");
const optionalRange = z.object({ min: eur.optional(), max: eur.optional() });
const windowDays = z
  .object({ minDays: z.number().int().min(0).max(365), maxDays: z.number().int().min(0).max(365) })
  .refine((w) => w.minDays <= w.maxDays, "minDays exceeds maxDays");

export const tripProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().min(1).max(100),
  aliases: z.array(z.string().max(60)).max(20).default([]),
  criteria: z.array(z.string().max(200)).max(20).default([]),
  /** Likeness vibes (ADR 0019) that seed the seasonal ranking for this profile. */
  vibes: z.array(z.string().max(40)).max(8).default([]),
  relevantMonths: z.array(month).max(12).default([]),
  maxResults: z.number().int().min(1).max(10).default(3),
});

export const atlasConfigSchema = z.object({
  profile: z.object({
    persona: z.string().min(1).max(4000),
    intentTags: z.array(z.string().max(60)).max(40),
    luxuryExceptions: z.string().max(2000).optional(),
    avoid: z.array(z.string().max(100)).max(40),
  }),
  hardFilters: z.object({
    maxStops: z.number().int().min(0).max(5),
    maxTravelTimeHours: z.number().positive().max(200),
    maxLayoverWaitHours: z.number().positive().max(72),
    budgetEconomyEur: rangeSchema,
    fallbackOrigins: z.array(iata).min(1).max(10),
    lastminuteWindowDays: z.number().int().min(0).max(120),
  }),
  /** Window A (short notice) and Window B (planned ahead), in days from today. */
  windows: z.object({ a: windowDays, b: windowDays }),
  scoringWeights: z.object({
    priceVsBaseline: z.number().nonnegative(),
    weather: z.number().nonnegative(),
    crowd: z.number().nonnegative(),
    surf: z.number().nonnegative(),
    isolation: z.number().nonnegative(),
    opportunityThreshold: z.number().min(0).max(10),
  }),
  discoveryWeights: z.object({
    weather: z.number().nonnegative(),
    tourismSeason: z.number().nonnegative(),
    conditions: z.number().nonnegative(),
    priceSignal: z.number().nonnegative(),
    minCompositeScore: z.number().min(0).max(10),
    repeatPenalty: z.number().nonnegative(),
    repeatWindowDays: z.number().int().min(0).max(365),
    maxCandidatesPerRun: z.number().int().min(1).max(20),
  }),
  tripPreferences: z.object({
    gates: z.object({
      minCompositeScore: z.number().min(0).max(10),
      minWeatherScore: score5,
      allowPeakCrowds: z.boolean(),
      minIsolationScore: score5,
    }),
    accommodation: z.object({
      style: z.array(z.string().max(60)).max(10),
      minRating: z.number().min(0).max(5),
      excludedChains: z.array(z.string().max(60)).max(20),
      sortBy: z.string().max(40),
    }),
    activities: z.object({
      tags: z.array(z.string().max(60)).max(20),
      avoidTags: z.array(z.string().max(60)).max(20),
      groupSizePref: z.string().max(40),
      includeRestaurants: z.boolean(),
      includeNightlife: z.boolean(),
      maxPerDay: z.number().int().min(0).max(6),
      budgetPerDayEur: eur,
    }),
    planning: z.object({
      maxFullPlans: z.number().int().min(0).max(3),
      maxAlternatives: z.number().int().min(0).max(3),
      tripBudgetEur: eur.nullable(),
    }),
  }),
  tripProfiles: z.array(tripProfileSchema).max(30),
});
export type AtlasConfig = z.infer<typeof atlasConfigSchema>;

// ── Wishlist ─────────────────────────────────────────────────────────

export const watchSchema = z.object({
  active: z.boolean().default(true),
  targetBudgetEur: optionalRange.optional(),
  /** Telegram chat that asked, when the watch came from the bot. Notices go to every Channel regardless. */
  chatId: z.string().max(40).optional(),
});

export const wishlistEntryInputSchema = z.object({
  place: placeRefSchema,
  source: z.enum(["wished", "scouted"]).default("wished"),
  intentTags: z.array(z.string().max(60)).max(20).default([]),
  avoidMonths: z.array(month).max(12).default([]),
  notes: z.string().max(2000).optional(),
  watch: watchSchema.optional(),
  discoveryScore: z.number().min(0).max(10).optional(),
  /** 1 (someday) to 5 (next chance I get). Default 3. */
  priority: z.number().int().min(1).max(5).optional(),
});

/** PATCH /api/atlas/wishlist/:cityId: change one place's own fields. Null removes the watch or the notes. */
export const wishlistPatchSchema = z.object({
  priority: z.number().int().min(1).max(5).optional(),
  intentTags: z.array(z.string().max(60)).max(20).optional(),
  avoidMonths: z.array(month).max(12).optional(),
  notes: z.string().max(2000).nullable().optional(),
  watch: watchSchema.nullable().optional(),
  source: z.enum(["wished", "scouted"]).optional(),
});
export type WishlistEntryInput = z.input<typeof wishlistEntryInputSchema>;

export interface AtlasPlace {
  cityId: string;
  name: string;
  country: string;
  iata?: string;
  lat: number;
  lng: number;
  source: "wished" | "scouted";
  intentTags: string[];
  avoidMonths: number[];
  notes?: string;
  watch?: z.infer<typeof watchSchema>;
  discoveryScore?: number;
  priority: number;
  addedAt: string;
  lastScoutedAt?: string;
  updatedAt: string;
}

// ── Season research (signals) ────────────────────────────────────────

/** What the routine found about one place in one month: what climate data cannot show. */
export const signalInputSchema = z.object({
  place: placeRefSchema,
  month,
  /** 5 = genuine low or shoulder season, 1 = peak crowds. */
  quiet: score5.optional(),
  /** Fit for the place's activities that month (swell, trails, visibility, wildlife). */
  conditions: score5.optional(),
  events: z
    .array(z.object({ title: z.string().min(1).max(200), date: isoDateSchema.optional() }))
    .max(20)
    .default([]),
  note: z.string().max(500).optional(),
  sources: z.array(link).max(5).default([]),
});

export interface AtlasSignal {
  cityId: string;
  month: number;
  quiet?: number;
  conditions?: number;
  events: { title: string; date?: string }[];
  note?: string;
  sources: string[];
  researchedAt: string;
}

export const runModes2 = ["scan", "discover", "research"] as const;
export const fireInputSchema = z.object({
  mode: z.enum(runModes2).default("scan"),
  /** Extra words for the routine, as a Telegram message would carry. */
  text: z.string().max(2000).optional(),
});

// ── Scans ────────────────────────────────────────────────────────────

export const flightSchema = z.object({
  id: z.string().min(1).max(120),
  /** Connector it came from: kiwi, lastminute, expedia, … */
  source: z.string().min(1).max(40),
  origin: iata,
  destination: iata,
  destinationName: z.string().min(1).max(200),
  departDate: isoDateSchema,
  returnDate: isoDateSchema,
  priceEur: eur.nullable(),
  priceBusinessEur: eur.nullable().optional(),
  /** Null only on a failed search (`error` set): a failed search has no itinerary. */
  stops: z.number().int().min(0).max(10).nullable(),
  layover: iata.nullable().optional(),
  longestLayoverHours: z.number().nonnegative().max(200).nullable().optional(),
  /** Null only on a failed search, as `stops`. */
  travelHours: z.number().nonnegative().max(200).nullable(),
  bookingUrl: link.nullable(),
  error: z.string().max(500).nullable().optional(),
}).superRefine((f, ctx) => {
  if (f.error) return;
  if (f.stops == null) ctx.addIssue({ code: "custom", path: ["stops"], message: "stops is required unless the search failed (error set)" });
  if (f.travelHours == null) ctx.addIssue({ code: "custom", path: ["travelHours"], message: "travelHours is required unless the search failed (error set)" });
});
export type AtlasFlight = z.infer<typeof flightSchema>;

export const crowdLevels = ["low", "medium", "high", "peak"] as const;

export const annotationSchema = z
  .object({
    flightId: z.string().min(1).max(120),
    weather: score5,
    crowd: z.enum(crowdLevels),
    events: z.array(z.string().max(200)).max(20).default([]),
    distortion: z.boolean(),
    distortionReason: z.string().max(500).nullable().optional(),
    surf: score5.nullable().optional(),
    isolation: score5,
    personalFlag: z.string().min(1).max(500),
    reasoning: z.string().min(1).max(4000),
  })
  .refine((a) => !a.distortion || !!a.distortionReason, { message: "distortionReason is required when distortion is true", path: ["distortionReason"] });
export type AtlasAnnotation = z.infer<typeof annotationSchema>;

export const runModes = ["scheduled", "query", "discovery", "watch"] as const;

export const scanInputSchema = z.object({
  mode: z.enum(runModes),
  origin: iata,
  query: z.string().max(2000).optional(),
  /** Per-run overrides of the hard filters (a /scout budget, say). Not saved. */
  overrides: z
    .object({
      budgetEconomyEur: optionalRange.optional(),
      maxStops: z.number().int().min(0).max(5).optional(),
    })
    .optional(),
  /** Query mode with a named destination: non-budget gates become warnings. */
  relaxGates: z.boolean().optional(),
  flights: z.array(flightSchema).max(200),
  annotations: z.array(annotationSchema).max(200),
});
export type ScanInput = z.input<typeof scanInputSchema>;

// ── Discovery ────────────────────────────────────────────────────────

export const candidateSchema = z.object({
  place: placeRefSchema,
  profileId: z.string().min(1).max(40),
  reason: z.string().min(1).max(1000),
  intentTags: z.array(z.string().max(60)).max(20).default([]),
  avoidMonths: z.array(month).max(12).default([]),
  notes: z.string().max(2000).optional(),
  weather: score5,
  conditions: score5,
  /** 5 = low or shoulder season now, 1 = peak crowds. */
  tourismSeason: score5,
  priceSignalEur: eur.nullable(),
  priceSignalNote: z.string().max(300).nullable(),
});

export const discoveryInputSchema = z.object({
  activityTypes: z.array(z.string().max(40)).max(10).default([]),
  origin: iata.optional(),
  candidates: z.array(candidateSchema).max(40),
});
export type DiscoveryInput = z.input<typeof discoveryInputSchema>;

// ── Trips ────────────────────────────────────────────────────────────

const stayPickSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["hotel", "apartment", "hostel", "friends", "other"]).optional(),
  address: z.string().max(300).optional(),
  rating: z.number().min(0).max(5).optional(),
  pricePerNightEur: eur.optional(),
  totalEur: eur.optional(),
  summary: z.string().max(500).optional(),
  link: link.optional(),
});

export const tripPlanInputSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    origin: placeRefSchema,
    destination: placeRefSchema,
    departDate: isoDateSchema,
    returnDate: isoDateSchema,
    travellers: z.number().int().min(1).max(9).optional(),
    flight: z.object({
      priceEur: eur.nullable(),
      bookingUrl: link.nullable(),
      carrier: z.string().max(100).optional(),
      stops: z.number().int().min(0).max(10).optional(),
      travelHours: z.number().nonnegative().max(200).optional(),
      layover: z.string().max(8).nullable().optional(),
      flightId: z.string().max(120).optional(),
    }),
    stay: stayPickSchema.optional(),
    stayAlternative: stayPickSchema.optional(),
    activities: z
      .array(
        z.object({
          date: isoDateSchema,
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
          title: z.string().min(1).max(200),
          costEur: eur.optional(),
          durationHours: z.number().nonnegative().max(48).optional(),
          rating: z.number().min(0).max(5).optional(),
          link: link.optional(),
          note: z.string().max(1000).optional(),
        })
      )
      .max(60)
      .default([]),
    totals: z
      .object({ flightEur: eur.nullable(), stayEur: eur.nullable(), activitiesEur: eur.nullable(), totalEur: eur.nullable() })
      .optional(),
    /** Validation warnings, baseline context, "prices checked at …". Lands in the stop's notes. */
    notes: z.string().max(3000).optional(),
    scanRunId: z.string().max(60).optional(),
  })
  .refine((t) => t.departDate < t.returnDate, { message: "returnDate must be after departDate", path: ["returnDate"] });
export type TripPlanInput = z.input<typeof tripPlanInputSchema>;

// ── Notices ──────────────────────────────────────────────────────────

export const atlasNoticeKinds = ["digest", "deal", "trip", "watch", "discovery"] as const;

export const atlasNotifyInputSchema = z.object({
  kind: z.enum(atlasNoticeKinds),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(2000).default(""),
  url: z.string().trim().max(500).optional(),
  dedupeKey: z.string().trim().min(1).max(160).optional(),
});

// ── Import (legacy Atlas repository) ─────────────────────────────────

export const importInputSchema = z.object({
  config: z.unknown().optional(),
  wishlist: z.array(wishlistEntryInputSchema).max(500).optional(),
  fares: z
    .array(
      z.object({
        origin: iata,
        destination: iata,
        priceEur: eur,
        departDate: isoDateSchema,
        returnDate: isoDateSchema.optional(),
        snapshotDate: isoDateSchema,
        source: z.string().max(40).default("atlas-legacy"),
      })
    )
    .max(20000)
    .optional(),
});
