import { Hono } from "hono";
import { getCityById } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { getSurfaceById, listSurfaces, getCityMetrics } from "../lib/datasets.js";

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

export default metrics;
