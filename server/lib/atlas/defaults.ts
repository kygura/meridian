// Atlas's shipped configuration (ADR 0020), carried over from its repository's config/*.json.
// The owner changes it with PATCH /api/atlas/config or `atlas config set`.

import type { AtlasConfig } from "./schemas.js";

export const DEFAULT_ATLAS_CONFIG: AtlasConfig = {
  profile: {
    persona:
      "Low-profile, adventurous traveller drawn to coastal and remote places. Core interests: surfing, ocean, nature, local culture. Nomadic at heart, values authenticity over tourist infrastructure. Occasionally splurges on a high-end tropical resort when conditions are right for the season. Avoids peak crowds and tourist traps. Prefers small towns, hidden beaches, and places with real character over well-trodden destinations.",
    intentTags: ["surf", "coastal", "remote", "ocean", "nomadic", "local-culture", "nature"],
    luxuryExceptions:
      "High-end tropical resorts are valid when: the season is peak-quality for surf or diving, the destination is genuinely remote or exclusive, and the price is justified by the experience.",
    avoid: ["over-touristed", "peak crowds", "generic package holiday", "party destination"],
  },
  hardFilters: {
    maxStops: 2,
    maxTravelTimeHours: 50,
    maxLayoverWaitHours: 6,
    budgetEconomyEur: { min: 10, max: 2500 },
    fallbackOrigins: ["AGP", "MAD", "LPA"],
    lastminuteWindowDays: 21,
  },
  windows: { a: { minDays: 14, maxDays: 28 }, b: { minDays: 42, maxDays: 70 } },
  scoringWeights: { priceVsBaseline: 0.3, weather: 0.25, crowd: 0.25, surf: 0.15, isolation: 0.05, opportunityThreshold: 7.5 },
  discoveryWeights: {
    weather: 0.3,
    tourismSeason: 0.3,
    conditions: 0.25,
    priceSignal: 0.15,
    minCompositeScore: 3,
    repeatPenalty: 1.5,
    repeatWindowDays: 45,
    maxCandidatesPerRun: 5,
  },
  tripPreferences: {
    gates: { minCompositeScore: 3, minWeatherScore: 3, allowPeakCrowds: false, minIsolationScore: 2 },
    accommodation: { style: ["boutique", "guesthouse"], minRating: 4, excludedChains: ["all_inclusive"], sortBy: "BEST_VALUE" },
    activities: {
      tags: ["adventure", "nature", "cultural", "off-beat"],
      avoidTags: ["tourist_trap", "bus_tour", "shopping"],
      groupSizePref: "small_group",
      includeRestaurants: false,
      includeNightlife: false,
      maxPerDay: 2,
      budgetPerDayEur: 60,
    },
    planning: { maxFullPlans: 1, maxAlternatives: 1, tripBudgetEur: null },
  },
  tripProfiles: [
    {
      id: "surf",
      label: "Warm-water surf",
      aliases: ["surfing", "surf trip", "waves"],
      criteria: ["consistent swell", "warm water", "reef or point break"],
      vibes: ["coast", "tropical-coast"],
      relevantMonths: [3, 4, 5, 9, 10, 11],
      maxResults: 3,
    },
    {
      id: "natural-adventure",
      label: "Natural adventure",
      aliases: ["adventure", "outdoors", "wilderness", "nature trip"],
      criteria: ["national parks or wild landscapes", "trekking, diving, or expedition access", "low infrastructure saturation"],
      vibes: ["mountains", "dramatic-coast"],
      relevantMonths: [3, 4, 5, 9, 10, 11],
      maxResults: 3,
    },
    {
      id: "hiking",
      label: "Spring and autumn hiking",
      aliases: ["trekking", "trail", "mountains"],
      criteria: ["good trail weather", "low crowds", "scenic"],
      vibes: ["mountains", "alpine-lakes"],
      relevantMonths: [3, 4, 5, 9, 10],
      maxResults: 3,
    },
    {
      id: "relax",
      label: "Relax and slow travel",
      aliases: ["chill", "beach relax", "unwind", "recovery"],
      criteria: ["calm coastline or quiet countryside", "minimal itinerary pressure", "reliable good-weather window"],
      vibes: ["coast", "small-town"],
      relevantMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      maxResults: 3,
    },
    {
      id: "cultural-travel",
      label: "Cultural travel",
      aliases: ["culture", "history", "heritage", "cities"],
      criteria: ["historic centers or living local culture", "shoulder-season crowd levels", "walkable without mass tourism"],
      vibes: ["old-town"],
      relevantMonths: [3, 4, 5, 9, 10, 11],
      maxResults: 3,
    },
    {
      id: "wildlife",
      label: "Wildlife and nature encounters",
      aliases: ["safari", "diving with wildlife", "nature reserve"],
      criteria: ["seasonal wildlife activity window", "genuine remoteness", "low visitor density"],
      vibes: ["dramatic-coast", "tropical-coast"],
      relevantMonths: [1, 2, 6, 7, 8, 12],
      maxResults: 2,
    },
    {
      id: "winter-sun",
      label: "Winter sun",
      aliases: ["sun", "warm winter", "escape the cold"],
      criteria: ["reliably warm and dry in the owner's winter", "short flight from the current base"],
      vibes: ["winter-sun"],
      relevantMonths: [11, 12, 1, 2, 3],
      maxResults: 3,
    },
  ],
};
