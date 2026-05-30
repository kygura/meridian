import { Hono } from "hono";
import { getCities, getCityById, searchCities } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { getCityMetrics } from "../lib/datasets.js";

const cities = new Hono();

/** GET /api/cities - return all cities with pagination */
cities.get("/", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 5000);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const all = getCities();
  const page = all.slice(offset, offset + limit);
  return c.json({
    total: all.length,
    limit,
    offset,
    cities: page,
  });
});

/** GET /api/cities/search?q=tokyo - search cities by name */
cities.get("/search", (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }
  const results = searchCities(q);
  return c.json({ query: q, count: results.length, cities: results });
});

/** GET /api/cities/:id - get single city with all data */
cities.get("/:id", (c) => {
  const id = c.req.param("id");
  const city = getCityById(id);
  if (!city) {
    return c.json({ error: `City '${id}' not found` }, 404);
  }
  const score = computeFullScore(city);
  const metrics = getCityMetrics(city.id);
  return c.json({ city, score, metrics: metrics ?? {} });
});

export default cities;
