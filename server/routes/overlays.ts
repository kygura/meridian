import { Hono } from "hono";
import { anomaliesFor, eventPointsFor, eventsForCities, eventTagCounts } from "../lib/phenomena.js";
import { liveEventsStatus, SOURCE_LABEL } from "../lib/liveEvents.js";

// Map overlay feeds that are not metric surfaces (see server/lib/phenomena.ts).

const overlays = new Hono();

function readMonth(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const m = Number(raw);
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

/**
 * GET /api/overlays/events?month=1-12 - events in that month, one point per city.
 * GET /api/overlays/events?cityIds=a,b - every upcoming event at those cities, any month
 *   (a seasonal trip's stops), with cityIds narrowed to the ones asked for.
 * Events are live from Wikidata (ADR 0021); both answers carry `asOf` (when they were fetched)
 * and `source`.
 */
overlays.get("/events", async (c) => {
  const cityParam = c.req.query("cityIds");
  if (cityParam !== undefined) {
    const ids = [...new Set(cityParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 200);
    if (!ids.length) return c.json({ error: "cityIds must list at least one city" }, 400);
    const events = await eventsForCities(ids);
    return c.json({ asOf: (await liveEventsStatus()).fetchedAt, source: SOURCE_LABEL, events });
  }
  const month = readMonth(c.req.query("month"));
  if (!month) return c.json({ error: "month must be 1-12" }, 400);
  const events = await eventPointsFor(month);
  return c.json({ month, asOf: (await liveEventsStatus()).fetchedAt, source: SOURCE_LABEL, events });
});

/** GET /api/overlays/events/tags - distinct tags of the upcoming events with counts, most common first. */
overlays.get("/events/tags", async (c) => {
  const tags = await eventTagCounts(new Date(), 40);
  return c.json({ asOf: (await liveEventsStatus()).fetchedAt, source: SOURCE_LABEL, tags });
});

/** GET /api/overlays/events/status - per-source counts, errors and fetch times, for diagnostics. */
overlays.get("/events/status", async (c) => c.json({ source: SOURCE_LABEL, ...(await liveEventsStatus()) }));

/** GET /api/overlays/anomalies[?month=1-12] - conflicts plus hazards in season. */
overlays.get("/anomalies", (c) => {
  const month = readMonth(c.req.query("month"));
  if (month === null) return c.json({ error: "month must be 1-12" }, 400);
  return c.json({ month: month ?? null, ...anomaliesFor(month) });
});

export default overlays;
