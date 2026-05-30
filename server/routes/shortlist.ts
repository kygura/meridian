import { Hono } from "hono";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getCityById } from "../lib/cities.js";
import { computeFullScore } from "../lib/scoring.js";
import type { ShortlistEntry } from "../../src/types.js";

const shortlist = new Hono();

const SHORTLIST_PATH = join(process.cwd(), "data", "shortlist.json");

function readShortlist(): ShortlistEntry[] {
  try {
    const raw = readFileSync(SHORTLIST_PATH, "utf-8");
    return JSON.parse(raw) as ShortlistEntry[];
  } catch {
    return [];
  }
}

function writeShortlist(entries: ShortlistEntry[]): void {
  writeFileSync(SHORTLIST_PATH, JSON.stringify(entries, null, 2));
}

/** GET /api/shortlist - read shortlist */
shortlist.get("/", (c) => {
  return c.json(readShortlist());
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

  const entries = readShortlist();
  if (entries.some((e) => e.cityId === cityId)) {
    return c.json({ error: "City already in shortlist" }, 409);
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

  entries.push(entry);
  writeShortlist(entries);

  return c.json(entry, 201);
});

/** DELETE /api/shortlist/:cityId - remove from shortlist */
shortlist.delete("/:cityId", (c) => {
  const cityId = c.req.param("cityId");
  const entries = readShortlist();
  const filtered = entries.filter((e) => e.cityId !== cityId);

  if (filtered.length === entries.length) {
    return c.json({ error: `City '${cityId}' not in shortlist` }, 404);
  }

  writeShortlist(filtered);
  return c.json({ success: true, cityId });
});

export default shortlist;
