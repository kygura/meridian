import { Hono } from "hono";
import { deleteTrip, listTrips, putTrip, tripIdSchema, tripInputSchema } from "../lib/trips.js";

// Token-gated via GATED_PREFIXES (server/middleware/auth.ts).
const trips = new Hono();

/** GET /api/trips → { trips, deleted } (deleted = ids removed on another device). */
trips.get("/", async (c) => c.json(await listTrips()));

/** PUT /api/trips/:id — create or replace one trip. */
trips.put("/:id", async (c) => {
  const id = tripIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const body = tripInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_trip", details: body.error.issues }, 400);
  return c.json({ trip: await putTrip(id.data, body.data) });
});

/** DELETE /api/trips/:id — idempotent; records a tombstone either way. */
trips.delete("/:id", async (c) => {
  const id = tripIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const existed = await deleteTrip(id.data);
  return c.json({ deleted: id.data, existed });
});

export default trips;
