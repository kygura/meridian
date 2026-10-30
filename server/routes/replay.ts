// POST /api/replay (spec-journal §6). Token-gated (also by gateRoutes in index.ts).
// Body = ReplayQuery (zod-validated) → ReplayResponse. A template journey whose
// fingerprint is missing/stale is recomputed + persisted first, so
// template_not_fingerprinted only means it is still impossible.

import { Hono } from "hono";
import type { ReplayQuery } from "../../src/types.js";
import { requireToken } from "../middleware/auth.js";
import { ReplayError } from "../lib/replay.js";
import { replayQuerySchema } from "../lib/replaySchema.js";
import { executeReplay } from "../lib/replayService.js";

const replay = new Hono();
replay.use("*", requireToken);

replay.post("/", async (c) => {
  const parsed = replayQuerySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  const query = parsed.data as ReplayQuery;

  try {
    const result = await executeReplay(query);
    return c.json(result);
  } catch (err) {
    if (err instanceof ReplayError) {
      const status = err.code === "template_not_found" ? 404 : err.code === "template_not_fingerprinted" ? 409 : 400;
      return c.json({ error: err.code, message: err.message }, status);
    }
    console.error("[replay] error:", err);
    return c.json({ error: "replay_failed", message: "Could not run replay." }, 500);
  }
});

export default replay;
