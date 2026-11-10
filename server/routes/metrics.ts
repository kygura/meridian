import { Hono } from "hono";
import { getCityById } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { getSurfaceById, listSurfaces, getCityMetrics } from "../lib/datasets.js";
import { placeDataInfo, placeFacts } from "../lib/placeData.js";

const metrics = new Hono();

/** GET /api/metrics/surfaces - list all available metric surfaces */
metrics.get("/surfaces", (c) => {
  return c.json(listSurfaces());
});

/** GET /api/metrics/surface/:id - get full MetricSurface with values */
metrics.get("/surface/:id", (c) => {
  const id = c.req.param("id");
  const surface = getSurfaceById(id);
  if (!surface) {
    return c.json({ error: `Surface '${id}' not found` }, 404);
  }
  return c.json(surface);
});

/** GET /api/metrics/city/:cityId - get all metrics for a specific city */
metrics.get("/city/:cityId", (c) => {
  const cityId = c.req.param("cityId");
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }
  const cityMetrics = getCityMetrics(cityId);
  return c.json({ cityId, metrics: cityMetrics ?? {} });
});

/** GET /api/metrics/score/:cityId - get MeridianScore for a city */
metrics.get("/score/:cityId", (c) => {
  const cityId = c.req.param("cityId");
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }
  const score = computeFullScore(city);
  return c.json({ cityId, score });
});

/**
 * GET /api/metrics/facts/:cityId - the measured figures behind a city's scores (ADR 0013):
 * cost, rent, internet, healthcare, stability, visitors. Each fact has its source key, year and
 * granularity; a fact with no data is null. `sources` names and links every dataset.
 */
metrics.get("/facts/:cityId", (c) => {
  const cityId = c.req.param("cityId");
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }
  c.header("cache-control", "public, max-age=3600");
  const info = placeDataInfo();
  return c.json({
    ...placeFacts(city, (id) => getCityById(id)?.name),
    score: computeFullScore(city),
    builtAt: info.builtAt,
    anchor: info.anchor,
    sources: info.sources,
  });
});

/** GET /api/metrics/coverage - how many cities have each measured value. */
metrics.get("/coverage", (c) => {
  const info = placeDataInfo();
  return c.json({ builtAt: info.builtAt, coverage: info.coverage });
});

export default metrics;
