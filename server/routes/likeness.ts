import { Hono } from "hono";
import { VIBES } from "../../src/lib/likeness.js";
import { LikenessError, runLikeness, type LikenessLevel } from "../lib/likeness.js";

// Places alike in experience, split into the sources and their lighter echoes (ADR 0019).
// Deterministic and keyless: no provider is called, so the route is public like /api/livability.

const likeness = new Hono();

const LEVELS: LikenessLevel[] = ["city", "region", "country"];
const MAX_LIST = 8;

const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** GET /api/likeness/vibes → the vibes you can ask for. */
likeness.get("/vibes", (c) => {
  c.header("cache-control", "public, max-age=3600");
  return c.json({ vibes: VIBES.map(({ id, label, detail, keywords }) => ({ id, label, detail, keywords })) });
});

/**
 * GET /api/likeness?vibe=old-town,coast&like=kyoto-japan&level=city|region|country&within=Spain&limit=12&min=85
 * → { level, target, counts, sources, echoes }. At least one vibe or one place to be like.
 */
likeness.get("/", (c) => {
  const vibes = list(c.req.query("vibe"));
  const like = list(c.req.query("like"));
  const level = (c.req.query("level") ?? "city") as LikenessLevel;
  if (!LEVELS.includes(level)) return c.json({ error: "bad_level", detail: `level is one of ${LEVELS.join(", ")}` }, 400);
  if (vibes.length > MAX_LIST || like.length > MAX_LIST) return c.json({ error: "too_many", detail: `At most ${MAX_LIST} vibes and ${MAX_LIST} places` }, 400);
  const limit = Math.max(1, Math.min(50, parseInt(c.req.query("limit") ?? "12", 10) || 12));
  const minRaw = c.req.query("min");
  const min = minRaw === undefined ? undefined : Number(minRaw);
  if (min !== undefined && !(min >= 0 && min <= 100)) return c.json({ error: "bad_min", detail: "min is 0-100" }, 400);
  const within = c.req.query("within")?.trim() || undefined;
  try {
    const body = runLikeness({ vibes, like, level, within, limit, minLikeness: min });
    c.header("cache-control", "public, max-age=600");
    return c.json(body);
  } catch (err) {
    if (err instanceof LikenessError) return c.json({ error: err.code, detail: err.detail }, err.code === "unknown_city" ? 404 : 400);
    throw err;
  }
});

export default likeness;
