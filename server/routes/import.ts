import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { z, ZodError } from "zod";
import { requireToken } from "../middleware/auth.js";
import { FxUnavailableError } from "../lib/fx.js";
import { JournalValidationError } from "../lib/journal.js";
import { MAX_BATCH, ImportError, acceptCluster, accept, addCandidates, discard, getQueue, merge } from "../lib/imports.js";

const imports = new Hono();

// Gated here as well as in index.ts, so the module is safe however it is mounted.
imports.use("*", requireToken);

const acceptBodySchema = z.object({ journeyId: z.string().trim().min(1).max(200).optional() });
const mergeBodySchema = z.object({ journeyId: z.string().trim().min(1).max(200) });

const badRequest = (c: Context, issues: unknown) => c.json({ error: "Invalid request", issues }, 400);
const body = (c: Context): Promise<unknown> => c.req.json().catch(() => null);

/** Map lib errors to HTTP; unexpected ones become a generic 500. */
function handleError(c: Context, err: unknown) {
  if (err instanceof ImportError) return c.json(err.body, err.status);
  if (err instanceof ZodError) return badRequest(c, err.issues);
  if (err instanceof JournalValidationError) return badRequest(c, err.issues);
  if (err instanceof FxUnavailableError) {
    return c.json({ error: "fx_unavailable", message: err.message, currency: err.currency, date: err.date }, 422);
  }
  console.error("[import] error:", err);
  return c.json({ error: "import_failed", message: "Could not process the import." }, 500);
}

// 500 candidates are well under 1 MB; refuse bigger bodies before they are buffered.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const limitBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "too_large", maxBytes: MAX_BODY_BYTES }, 413) });

imports.post("/", limitBody, async (c) => {
  const items = await body(c);
  if (!Array.isArray(items)) return badRequest(c, [{ message: "expected a JSON array of import candidates" }]);
  if (items.length > MAX_BATCH) return c.json({ error: "too_many", max: MAX_BATCH }, 413);
  try {
    return c.json(await addCandidates(items));
  } catch (err) {
    return handleError(c, err);
  }
});

// Fixed paths before /:id.
imports.get("/queue", async (c) => {
  try {
    return c.json(await getQueue());
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/cluster/:clusterId/accept", async (c) => {
  try {
    return c.json({ journey: await acceptCluster(c.req.param("clusterId")) }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/:id/accept", async (c) => {
  const parsed = acceptBodySchema.safeParse((await body(c)) ?? {});
  if (!parsed.success) return badRequest(c, parsed.error.issues);
  try {
    return c.json({ journey: await accept(c.req.param("id"), parsed.data.journeyId) }, parsed.data.journeyId ? 200 : 201);
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/:id/merge", async (c) => {
  const parsed = mergeBodySchema.safeParse(await body(c));
  if (!parsed.success) return badRequest(c, parsed.error.issues);
  try {
    return c.json({ journey: await merge(c.req.param("id"), parsed.data.journeyId) });
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/:id/discard", async (c) => {
  try {
    return c.json({ candidate: await discard(c.req.param("id")) });
  } catch (err) {
    return handleError(c, err);
  }
});

export default imports;
