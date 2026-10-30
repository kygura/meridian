// zod schema for ReplayQuery (trust boundary shared by POST /api/replay, watches and agent tools).

import { z } from "zod";

const month = z.number().int().min(1).max(12);

const fingerprintSchema = z
  .object({
    month,
    weekOfYear: z.number().int().min(1).max(53),
    comfort: z.number().min(0).max(100),
    tempC: z.number().min(-60).max(60),
    precipMm: z.number().min(0).max(5000),
    dailySpendEur: z.number().min(0),
    flightCostEurPer1000km: z.number().min(0),
    crowdProxy: z.number().min(0).max(100),
    durationNights: z.number().int().min(0),
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    tags: z.array(z.string().max(50)).max(50),
  })
  .partial();

const weight = z.number().min(0).max(1);

export const replayQuerySchema = z.object({
  template: z.union([
    z.object({ journeyId: z.string().min(1), stopIndex: z.number().int().min(0).optional() }),
    z.object({ fingerprint: fingerprintSchema }),
  ]),
  bend: z
    .object({
      tempC: z.number().min(-10).max(10).optional(),
      spendPct: z.number().min(-50).max(50).optional(),
      crowd: z.number().min(-50).max(50).optional(),
      monthShift: z.number().int().min(-6).max(6).nullable().optional(),
    })
    .default({}),
  weights: z.object({ climate: weight, spend: weight, crowd: weight, flight: weight }),
  constraints: z
    .object({
      months: z.array(month).max(12).optional(),
      regions: z.array(z.string().min(1).max(50)).max(20).optional(),
      excludeVisited: z.boolean().optional(),
      maxFlightHours: z.number().positive().max(48).optional(),
      fromCityId: z.string().min(1).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      cityIds: z.array(z.string().min(1)).max(500).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
