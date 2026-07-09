import { Hono } from "hono";
import { z } from "zod";
import { getCitySeasonality, getRegionAggregates } from "../lib/seasonality.js";

const seasonality = new Hono();

const MAX_BATCH = 100;

/** GET /api/seasonality/regions - per-country monthly comfort aggregates. */
seasonality.get("/regions", (c) => {
  return c.json({ regions: getRegionAggregates() });
});

/** GET /api/seasonality?cityIds=a,b,c - batch fetch for the calendar grid. */
seasonality.get("/", (c) => {
  const schema = z.object({
    cityIds: z
      .string()
      .min(1)
      .transform((s) =>
        s
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      )
      .refine((ids) => ids.length > 0, "cityIds must contain at least one id")
      .refine((ids) => ids.length <= MAX_BATCH, `cityIds cannot exceed ${MAX_BATCH} ids`),
  });

  const parsed = schema.safeParse({ cityIds: c.req.query("cityIds") });
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const cities: Record<string, ReturnType<typeof getCitySeasonality> | null> = {};
  for (const id of parsed.data.cityIds) {
    cities[id] = getCitySeasonality(id) ?? null;
  }

  return c.json({ cities });
});

/** GET /api/seasonality/:cityId - 12 monthly entries for a covered city. */
seasonality.get("/:cityId", (c) => {
  const cityId = c.req.param("cityId");
  const months = getCitySeasonality(cityId);
  if (!months) {
    return c.json({ error: `No seasonality data for '${cityId}'` }, 404);
  }
  return c.json({ cityId, months });
});

export default seasonality;
