// /api/atlas (ADR 0020): the backend of the Atlas routine. Owner-gated; the routine sends the
// Bearer token. Every write is validated in server/lib/atlas; a 400 carries what to fix.

import { Hono, type Context } from "hono";
import { isoDateSchema } from "../lib/journalSchemas.js";
import { requireToken } from "../middleware/auth.js";
import {
  AtlasInputError,
  atlasNotify,
  buildContext,
  createTripFromPlan,
  getConfig,
  importLegacy,
  listRuns,
  listWishlist,
  recordDiscovery,
  recordScan,
  removeFromWishlist,
  routeFares,
  seasonalRanking,
  setConfig,
  upsertWishlist,
} from "../lib/atlas/service.js";

const atlas = new Hono();
atlas.use("*", requireToken);

const body = (c: Context) => c.req.json().catch(() => null);
const list = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function handle(c: Context, work: () => Promise<unknown>, status: 200 | 201 = 200) {
  try {
    return c.json(await work(), status);
  } catch (err) {
    if (err instanceof AtlasInputError) return c.json({ error: err.code, message: err.message, ...(err.details ? { issues: err.details } : {}) }, 400);
    console.error("[atlas]", c.req.method, c.req.path, "failed:", err);
    return c.json({ error: "atlas_failed", message: "The Atlas request failed on the server." }, 500);
  }
}

/** GET /api/atlas/context?today=YYYY-MM-DD: what a run starts from. */
atlas.get("/context", (c) => {
  const today = c.req.query("today");
  if (today !== undefined && !isoDateSchema.safeParse(today).success) return c.json({ error: "invalid_date" }, 400);
  return handle(c, () => buildContext(today));
});

/** GET /api/atlas/seasonal?months=1,2&vibe=coast&profile=surf&limit=25 */
atlas.get("/seasonal", (c) => {
  const months = list(c.req.query("months")).map(Number);
  if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) return c.json({ error: "invalid_months", message: "months are 1-12, comma-separated" }, 400);
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  return handle(c, () => seasonalRanking({ months, vibes: list(c.req.query("vibe")), profileId: c.req.query("profile") || undefined, limit }));
});

atlas.get("/config", (c) => handle(c, getConfig));
atlas.patch("/config", async (c) => {
  const patch = await body(c);
  return handle(c, () => setConfig(patch, "patch"));
});
atlas.put("/config", async (c) => {
  const next = await body(c);
  return handle(c, () => setConfig(next, "replace"));
});

atlas.get("/wishlist", (c) => handle(c, async () => ({ entries: await listWishlist() })));
atlas.post("/wishlist", async (c) => {
  const input = await body(c);
  return handle(c, () => upsertWishlist(input));
});
atlas.delete("/wishlist/:cityId", (c) => handle(c, async () => ({ removed: await removeFromWishlist(c.req.param("cityId")) })));

atlas.post("/scans", async (c) => {
  const input = await body(c);
  return handle(c, () => recordScan(input), 201);
});
atlas.post("/discoveries", async (c) => {
  const input = await body(c);
  return handle(c, () => recordDiscovery(input), 201);
});
atlas.post("/trips", async (c) => {
  const input = await body(c);
  return handle(c, () => createTripFromPlan(input), 201);
});
atlas.post("/notify", async (c) => {
  const input = await body(c);
  return handle(c, () => atlasNotify(input), 201);
});

atlas.get("/runs", (c) => handle(c, async () => ({ runs: await listRuns(Number(c.req.query("limit") ?? 20) || 20) })));
atlas.get("/fares", (c) => handle(c, () => routeFares(c.req.query("route") ?? "")));

atlas.post("/import", async (c) => {
  const input = await body(c);
  return handle(c, () => importLegacy(input));
});

export default atlas;
