import { Hono } from "hono";
import { z } from "zod";
import { deleteTrip, getTrip, listTrips, putTrip, tripIdSchema, tripInputSchema } from "../lib/trips.js";
import { createLink, linkKindSchema, linksForTrip, revokeAllLinks, revokeLink, type TripLink } from "../lib/tripLinks.js";

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
  // A deleted trip's share and calendar links stop working with it.
  await revokeAllLinks(id.data);
  return c.json({ deleted: id.data, existed });
});

// ── Share and calendar links (ADR 0010) ──────────────────────────────
// Managed here, behind the token gate; opened through /api/shared, which is public.

const homeSchema = z.object({
  cityId: z.string().min(1).max(200),
  name: z.string().max(200),
  iata: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const linkBodySchema = z.object({ kind: linkKindSchema, home: homeSchema.optional() });

const view = (l: TripLink | undefined) => (l ? { token: l.token, createdAt: l.createdAt } : null);

/** GET /api/trips/:id/links → { page, calendar } (null where no link exists). */
trips.get("/:id/links", async (c) => {
  const id = tripIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const links = await linksForTrip(id.data);
  return c.json({ page: view(links.page), calendar: view(links.calendar) });
});

/** POST /api/trips/:id/links { kind, home? } — make the link, replacing any earlier one of that kind. */
trips.post("/:id/links", async (c) => {
  const id = tripIdSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const body = linkBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_link", details: body.error.issues }, 400);
  // Only a trip the server holds can be opened by a link.
  if (!(await getTrip(id.data))) return c.json({ error: "trip_not_synced" }, 404);
  const link = await createLink(id.data, body.data.kind, body.data.home);
  return c.json({ link: view(link) });
});

/** DELETE /api/trips/:id/links/:kind — turn the link off. Idempotent. */
trips.delete("/:id/links/:kind", async (c) => {
  const id = tripIdSchema.safeParse(c.req.param("id"));
  const kind = linkKindSchema.safeParse(c.req.param("kind"));
  if (!id.success || !kind.success) return c.json({ error: "invalid_id" }, 400);
  return c.json({ revoked: await revokeLink(id.data, kind.data) });
});

export default trips;
