import { Hono } from "hono";
import { anomaliesFor, eventPointsFor, eventsForCities } from "../lib/phenomena.js";

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
 */
overlays.get("/events", async (c) => {
  const cityParam = c.req.query("cityIds");
  if (cityParam !== undefined) {
    const ids = [...new Set(cityParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 200);
    if (!ids.length) return c.json({ error: "cityIds must list at least one city" }, 400);
    return c.json({ events: await eventsForCities(ids) });
  }
  const month = readMonth(c.req.query("month"));
  if (!month) return c.json({ error: "month must be 1-12" }, 400);
  return c.json({ month, events: await eventPointsFor(month) });
});

/** GET /api/overlays/anomalies[?month=1-12] - conflicts plus hazards in season. */
overlays.get("/anomalies", (c) => {
  const month = readMonth(c.req.query("month"));
  if (month === null) return c.json({ error: "month must be 1-12" }, 400);
  return c.json({ month: month ?? null, ...anomaliesFor(month) });
});

export default overlays;
