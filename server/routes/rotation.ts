import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireToken } from "../middleware/auth.js";
import { isoDateSchema } from "../lib/journalSchemas.js";
import {
  cityIdSchema,
  deletePlace,
  deleteStay,
  idSchema,
  placeInputSchema,
  putPlace,
  putSettings,
  putStay,
  readRotation,
  rotationRemindersDue,
  settingsInputSchema,
  stayInputSchema,
  stateOf,
  type WriteResult,
} from "../lib/rotation.js";
import { bookingDeadlines, currentStay, rotationIssues, todayIso, whatsNext } from "../../src/lib/rotation.js";

// Rotation (ADR 0011): the owner's rolling calendar of stays. Personal data, so every
// route needs the owner, the same as /api/trips (ADR 0009).
const rotation = new Hono();
rotation.use("*", requireToken);

const base = z.object({ baseUpdatedAt: z.string().max(40).optional() });
const todayQuery = z.object({ today: isoDateSchema.optional() });

function conflict<T>(c: Context, r: Extract<WriteResult<T>, { ok: false }>) {
  return c.json({ error: r.conflict === "deleted" ? "deleted" : "conflict", current: r.current }, 409);
}

/**
 * GET /api/rotation?today=YYYY-MM-DD → { settings, stays, places, deleted, today, currentStayId, issues }.
 * `deleted` lists ids removed on another browser; `today` defaults to the server's date.
 */
rotation.get("/", async (c) => {
  const q = todayQuery.safeParse({ today: c.req.query("today") || undefined });
  if (!q.success) return c.json({ error: "invalid_date" }, 400);
  const today = q.data.today ?? todayIso();
  const f = await readRotation();
  return c.json({
    settings: f.settings,
    stays: f.stays,
    places: f.places,
    deleted: f.deleted.map(({ kind, id }) => ({ kind, id })),
    today,
    currentStayId: currentStay(f.stays, today)?.id ?? null,
    issues: rotationIssues(f.stays),
  });
});

/** GET /api/rotation/current?today= → { today, stay, next } — where the owner is now. */
rotation.get("/current", async (c) => {
  const q = todayQuery.safeParse({ today: c.req.query("today") || undefined });
  if (!q.success) return c.json({ error: "invalid_date" }, 400);
  const today = q.data.today ?? todayIso();
  const f = await readRotation();
  const w = whatsNext(f.stays, today);
  return c.json({ today, stay: w.current, daysLeft: w.daysLeft, nextMoveDate: w.nextMoveDate, next: w.next });
});

/** GET /api/rotation/deadlines?today= → { deadlines } — every booking deadline still open. */
rotation.get("/deadlines", async (c) => {
  const q = todayQuery.safeParse({ today: c.req.query("today") || undefined });
  if (!q.success) return c.json({ error: "invalid_date" }, 400);
  const f = await readRotation();
  return c.json({ deadlines: bookingDeadlines(stateOf(f), q.data.today ?? todayIso()) });
});

/**
 * GET /api/rotation/reminders?today=&notice=14 → { reminders } — what a daily notifier
 * should send today. Read-only: sending, and not sending twice, is the notifier's job.
 */
rotation.get("/reminders", async (c) => {
  const q = todayQuery.extend({ notice: z.coerce.number().int().min(0).max(365).optional() }).safeParse({
    today: c.req.query("today") || undefined,
    notice: c.req.query("notice") || undefined,
  });
  if (!q.success) return c.json({ error: "invalid_query" }, 400);
  return c.json({ reminders: await rotationRemindersDue(q.data.today ?? todayIso(), q.data.notice ?? 14) });
});

/** PUT /api/rotation/settings { name, home?, horizonMonths, baseUpdatedAt? } */
rotation.put("/settings", async (c) => {
  const body = settingsInputSchema.merge(base).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_settings", details: body.error.issues }, 400);
  const { baseUpdatedAt, ...input } = body.data;
  const r = await putSettings(input, baseUpdatedAt);
  return r.ok ? c.json({ settings: r.value }) : conflict(c, r);
});

/** PUT /api/rotation/stays/:id { stay, baseUpdatedAt? } — 409 with the current copy when it changed elsewhere. */
rotation.put("/stays/:id", async (c) => {
  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const body = z.object({ stay: stayInputSchema }).merge(base).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_stay", details: body.error.issues }, 400);
  const r = await putStay(id.data, body.data.stay as never, body.data.baseUpdatedAt);
  return r.ok ? c.json({ stay: r.value }) : conflict(c, r);
});

/** DELETE /api/rotation/stays/:id — idempotent. */
rotation.delete("/stays/:id", async (c) => {
  const id = idSchema.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  return c.json({ deleted: id.data, existed: await deleteStay(id.data) });
});

/** PUT /api/rotation/places/:cityId { place, baseUpdatedAt? } — personal windows and lead time for one place. */
rotation.put("/places/:cityId", async (c) => {
  const id = cityIdSchema.safeParse(c.req.param("cityId"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  const body = z.object({ place: placeInputSchema }).merge(base).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_place", details: body.error.issues }, 400);
  const r = await putPlace(id.data, body.data.place as never, body.data.baseUpdatedAt);
  return r.ok ? c.json({ place: r.value }) : conflict(c, r);
});

rotation.delete("/places/:cityId", async (c) => {
  const id = cityIdSchema.safeParse(c.req.param("cityId"));
  if (!id.success) return c.json({ error: "invalid_id" }, 400);
  return c.json({ deleted: id.data, existed: await deletePlace(id.data) });
});

export default rotation;
