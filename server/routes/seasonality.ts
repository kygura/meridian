import { Hono } from "hono";
import { z } from "zod";
import {
  getRegionAggregates,
  getSeasonalityWindow,
  peekCitySeasonality,
  resolveCitySeasonality,
  type MonthSeasonality,
} from "../lib/seasonality.js";

const seasonality = new Hono();

const MAX_BATCH = 100;
const MAX_ON_DEMAND_FETCHES = 4;
const ON_DEMAND_CONCURRENCY = 2;

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency(
  items: string[],
  limit: number,
  worker: (item: string) => Promise<void>
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/** GET /api/seasonality/regions - per-country monthly comfort aggregates. */
seasonality.get("/regions", (c) => {
  return c.json({ regions: getRegionAggregates() });
});

/**
 * GET /api/seasonality?cityIds=a,b,c - batch fetch for the calendar grid.
 * Cache hits are served immediately. Among misses for known cities, at most
 * MAX_ON_DEMAND_FETCHES are fetched on-demand (bounded concurrency); the
 * rest are returned as null so the client can re-request later. Fetch
 * failures also come back as null in a batch — no 503 here, that's reserved
 * for the single-city route below.
 */
seasonality.get("/", async (c) => {
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

  const cities: Record<string, MonthSeasonality[] | null> = {};
  const toFetch: string[] = [];

  for (const id of parsed.data.cityIds) {
    const peek = peekCitySeasonality(id);
    if (peek.kind === "hit") {
      cities[id] = peek.months;
    } else {
      cities[id] = null; // unknown, or a miss not selected for on-demand fetch below
      if (peek.kind === "miss") toFetch.push(id);
    }
  }

  const capped = toFetch.slice(0, MAX_ON_DEMAND_FETCHES);
  await mapWithConcurrency(capped, ON_DEMAND_CONCURRENCY, async (id) => {
    const result = await resolveCitySeasonality(id);
    cities[id] = result.kind === "hit" ? result.months : null;
  });

  return c.json({ cities, window: getSeasonalityWindow() });
});

/**
 * GET /api/seasonality/:cityId - 12 monthly entries for a city. On a cache
 * miss for a known city, fetches Open-Meteo live (can take seconds). Unknown
 * city -> 404. Fetch failure (quota/network/timeout) -> 503 so the client
 * knows to retry rather than treating it as "no such city".
 */
seasonality.get("/:cityId", async (c) => {
  const cityId = c.req.param("cityId");
  const result = await resolveCitySeasonality(cityId);

  if (result.kind === "unknown") {
    return c.json({ error: `No seasonality data for '${cityId}'` }, 404);
  }
  if (result.kind === "unavailable") {
    return c.json(
      { error: "seasonality_unavailable", message: "climate provider quota or network — retry later" },
      503
    );
  }

  return c.json({ cityId, months: result.months });
});

export default seasonality;
