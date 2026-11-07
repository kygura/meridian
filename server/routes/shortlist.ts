import { Hono } from "hono";
import { z } from "zod";
import { getCityById } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import { createJsonStore } from "../lib/jsonStore.js";
import type { ShortlistEntry } from "../../src/types.js";

const shortlist = new Hono();

// File under DATA_DIR, or Postgres when DATABASE_URL is set.
const store = createJsonStore<ShortlistEntry[]>("shortlist.json", () => []);

/** GET /api/shortlist - read shortlist */
shortlist.get("/", async (c) => {
  return c.json(await store.read());
});

/** POST /api/shortlist - add city to shortlist */
shortlist.post("/", async (c) => {
  const body = await c.req.json();
  const schema = z.object({ cityId: z.string() });
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { cityId } = parsed.data;
  const city = getCityById(cityId);
  if (!city) {
    return c.json({ error: `City '${cityId}' not found` }, 404);
  }

  const score = computeFullScore(city);
  const entry: ShortlistEntry = {
    cityId: city.id,
    name: city.name,
    country: city.country,
    lat: city.lat,
    lng: city.lng,
    iata: city.iata,
    addedAt: new Date().toISOString(),
    score: score.overall,
  };

  const added = await store.update((entries) => {
    if (entries.some((e) => e.cityId === cityId)) return false;
    entries.push(entry);
    return true;
  });
  if (!added) return c.json({ error: "City already in shortlist" }, 409);

  return c.json(entry, 201);
});

/** DELETE /api/shortlist/:cityId - remove from shortlist */
shortlist.delete("/:cityId", async (c) => {
  const cityId = c.req.param("cityId");
  const removed = await store.update((entries) => {
    const idx = entries.findIndex((e) => e.cityId === cityId);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    return true;
  });

  if (!removed) {
    return c.json({ error: `City '${cityId}' not in shortlist` }, 404);
  }

  return c.json({ success: true, cityId });
});

export default shortlist;
