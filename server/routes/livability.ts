import { Hono } from "hono";
import { getCityById } from "../lib/cities.js";
import { livabilityFor, livabilityRows, livabilitySources } from "../lib/livability.js";

const livability = new Hono();

/** GET /api/livability → { rows: [cityId, quality, beauty, setting, character][], builtAt, sources } */
livability.get("/", (c) => {
  c.header("cache-control", "public, max-age=3600");
  return c.json({ rows: livabilityRows(), ...livabilitySources() });
});

/** GET /api/livability/:cityId → the full breakdown, with raw inputs and sources. */
livability.get("/:cityId", (c) => {
  const id = c.req.param("cityId");
  if (!getCityById(id)) return c.json({ error: "not_found" }, 404);
  const record = livabilityFor(id);
  if (!record) return c.json({ error: "no_data" }, 404);
  return c.json({ cityId: id, ...record, ...livabilitySources() });
});

export default livability;
