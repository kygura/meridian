// /api/visa (ADR 0012): visa, entry-requirement and residency day counting. Owner-only, like
// /api/rotation (ADR 0009): everything here is checked against the owner's passports and stays.
//
//   GET  /api/visa/settings          passports held (with optional expiry), residency, tax watch list
//   PUT  /api/visa/settings          save them
//   GET  /api/visa/data              the requirements rows for the owner's passports, names, validity, sources
//   GET  /api/visa/days              the owner's stays: journal (past), dated trips and the rotation
//   POST /api/visa/check             { stays, passports?, today? } → per-stay verdicts and violations
//   POST /api/visa/buffers           { cityId | lat,lng, start, nights } → places outside Schengen
//   POST /api/visa/border-runs       { cityId | country,lat,lng, date } → where to exit and re-enter

import { Hono } from "hono";
import { z } from "zod";
import { requireToken } from "../middleware/auth.js";
import { isoDateSchema } from "../lib/journalSchemas.js";
import { getVisaSettings, putVisaSettings, visaSettingsSchema } from "../lib/visaStore.js";
import { borderRunsFor, browserData, buffersFor, checkForOwner, ownerStays, placeOfCity, visaContext } from "../lib/visaService.js";
import { todayIso } from "../../src/lib/rotation.js";

const visa = new Hono();
visa.use("*", requireToken);

const passportsSchema = z.array(z.string().regex(/^[A-Z]{2}$/)).max(5).optional();

const checkSchema = z.object({
  stays: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        country: z.string().min(1).max(100),
        start: isoDateSchema,
        end: isoDateSchema,
        label: z.string().max(200).optional(),
        past: z.boolean().optional(),
        tentative: z.boolean().optional(),
      })
    )
    .min(1)
    .max(300),
  passports: passportsSchema,
  today: isoDateSchema.optional(),
});

const fromSchema = z.object({ cityId: z.string().max(200).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), country: z.string().max(100).optional() });
const buffersSchema = fromSchema.extend({ start: isoDateSchema, nights: z.number().int().min(1).max(365), passports: passportsSchema });
const runsSchema = fromSchema.extend({ date: isoDateSchema, passports: passportsSchema });

visa.get("/settings", async (c) => c.json({ settings: await getVisaSettings() }));

visa.put("/settings", async (c) => {
  const body = visaSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_settings", details: body.error.issues }, 400);
  return c.json({ settings: await putVisaSettings(body.data) });
});

visa.get("/data", async (c) => {
  const ctx = await visaContext();
  if ("error" in ctx) return c.json({ error: "no_data", message: ctx.error }, 503);
  return c.json({ data: browserData(ctx), settings: ctx.settings });
});

visa.get("/days", async (c) => {
  const ctx = await visaContext();
  if ("error" in ctx) return c.json({ error: "no_data", message: ctx.error }, 503);
  const today = todayIso();
  return c.json({ today, stays: await ownerStays(today), data: browserData(ctx), settings: ctx.settings });
});

visa.post("/check", async (c) => {
  const body = checkSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  const ctx = await visaContext();
  if ("error" in ctx) return c.json({ error: "no_data", message: ctx.error }, 503);
  return c.json(checkForOwner(ctx, body.data.stays, { today: body.data.today ?? todayIso(), passports: body.data.passports }));
});

function resolveFrom(b: z.infer<typeof fromSchema>): { country?: string; lat: number; lng: number } | null {
  if (b.cityId) {
    const p = placeOfCity(b.cityId);
    if (p) return p;
  }
  if (typeof b.lat === "number" && typeof b.lng === "number") return { country: b.country, lat: b.lat, lng: b.lng };
  return null;
}

visa.post("/buffers", async (c) => {
  const body = buffersSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  const from = resolveFrom(body.data);
  if (!from) return c.json({ error: "invalid_request", message: "Give a cityId, or lat and lng." }, 400);
  const ctx = await visaContext();
  if ("error" in ctx) return c.json({ error: "no_data", message: ctx.error }, 503);
  return c.json({ options: buffersFor(ctx, from, body.data.start, body.data.nights, body.data.passports) });
});

visa.post("/border-runs", async (c) => {
  const body = runsSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_request", details: body.error.issues }, 400);
  const from = resolveFrom(body.data);
  if (!from?.country) return c.json({ error: "invalid_request", message: "Give a cityId, or country, lat and lng." }, 400);
  const ctx = await visaContext();
  if ("error" in ctx) return c.json({ error: "no_data", message: ctx.error }, 503);
  return c.json(borderRunsFor(ctx, { country: from.country, lat: from.lat, lng: from.lng, date: body.data.date }, body.data.passports));
});

export default visa;
