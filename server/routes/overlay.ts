import { Hono } from "hono";
import { getAllCityMonths, getSeasonalityWindow } from "../lib/seasonality.js";
import { getSurfaceById } from "../lib/datasets.js";
import { loadEvents } from "../lib/replayService.js";

// Bulk, compact data for the map overlays (src/lib/overlayConfig.ts). One request per
// kind, returned as dense arrays keyed by city id so the globe can filter every city
// client-side without a round trip per change.

const overlay = new Hono();

const SOCIETY_SURFACES = ["stability", "quality", "cost", "tourism", "connectivity", "density"] as const;

let metricsCache: { metrics: Record<string, Record<string, number>>; confidence: Record<string, string> } | null = null;

function buildMetrics() {
  if (metricsCache) return metricsCache;
  const metrics: Record<string, Record<string, number>> = {};
  const confidence: Record<string, string> = {};
  for (const id of SOCIETY_SURFACES) {
    const surface = getSurfaceById(id);
    if (!surface) continue;
    confidence[id] = surface.confidence;
    const byCity: Record<string, number> = {};
    for (const v of surface.values) byCity[v.locationId] = v.normalized;
    metrics[id] = byCity;
  }
  metricsCache = { metrics, confidence };
  return metricsCache;
}

/**
 * GET /api/overlay/climate - monthly normals for every covered city.
 * `cities[id]` is 12 triples [comfort, tempC, precipMm], January first.
 */
overlay.get("/climate", (c) => {
  const cities: Record<string, [number, number, number][]> = {};
  for (const [id, months] of Object.entries(getAllCityMonths())) {
    cities[id] = months.map((m) => [m.score, m.tempC, m.precipMm]);
  }
  return c.json({ window: getSeasonalityWindow(), cities });
});

/**
 * GET /api/overlay/metrics - the social, political and infrastructure indices for every
 * city, as 0-100 values keyed by metric then city id. Most are modelled or synthesized
 * (see `confidence`), so the client labels them as estimates.
 */
overlay.get("/metrics", (c) => c.json(buildMetrics()));

/** GET /api/overlay/events - the dated events dataset (festivals, eclipses ...). */
overlay.get("/events", async (c) => c.json({ events: await loadEvents() }));

export default overlay;
