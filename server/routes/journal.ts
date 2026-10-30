import { Hono } from "hono";
import type { Context } from "hono";
import { z, ZodError } from "zod";
import type { JournalSettings } from "../../src/types.js";
import { requireToken } from "../middleware/auth.js";
import type { JourneyInputRaw } from "../lib/journalSchemas.js";
import { FxUnavailableError } from "../lib/fx.js";
import {
  listJourneys,
  getJourney,
  createJourney,
  updateJourney,
  deleteJourney,
  getSettings,
  saveSettings,
  JournalValidationError,
  JournalConflictError,
} from "../lib/journal.js";
import { ensureFingerprint } from "../lib/journalFingerprint.js";

const journal = new Hono();

// Gated here as well as in index.ts, so the module is safe however it is mounted.
journal.use("*", requireToken);

const listQuerySchema = z.object({
  year: z.coerce.number().int().min(1900).max(2200).optional(),
  tag: z.string().trim().min(1).max(50).optional(),
});

function badRequest(c: Context, issues: unknown) {
  return c.json({ error: "Invalid request", issues }, 400);
}

async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/** Map lib errors to HTTP; rethrow anything unexpected. */
function handleError(c: Context, err: unknown) {
  if (err instanceof ZodError) return badRequest(c, err.issues);
  if (err instanceof JournalValidationError) return badRequest(c, err.issues);
  if (err instanceof JournalConflictError) {
    return c.json({ error: "conflict", message: "The journey changed since it was loaded; reload and retry." }, 409);
  }
  if (err instanceof FxUnavailableError) {
    return c.json({ error: "fx_unavailable", message: err.message, currency: err.currency, date: err.date }, 422);
  }
  console.error("[journal] error:", err);
  return c.json({ error: "journal_failed", message: "Could not save the journey." }, 500);
}

// ── Settings (registered before /:id) ───────────────────────────────

journal.get("/settings", async (c) => c.json({ settings: await getSettings() }));

journal.put("/settings", async (c) => {
  try {
    return c.json({ settings: await saveSettings((await body(c)) as JournalSettings) });
  } catch (err) {
    return handleError(c, err);
  }
});

// ── Journeys ────────────────────────────────────────────────────────

journal.get("/", async (c) => {
  const q = listQuerySchema.safeParse(c.req.query());
  if (!q.success) return badRequest(c, q.error.issues);
  return c.json({ journeys: await listJourneys(q.data) });
});

journal.get("/:id", async (c) => {
  const journey = await getJourney(c.req.param("id"));
  if (!journey) return c.json({ error: "not_found", message: "Journey not found" }, 404);
  return c.json({ journey });
});

// Recomputes (and persists) when inputs changed or a dim is still pending (R6 retry).
journal.get("/:id/fingerprint", async (c) => {
  const stored = await getJourney(c.req.param("id"));
  if (!stored) return c.json({ error: "not_found", message: "Journey not found" }, 404);
  try {
    const journey = await ensureFingerprint(stored);
    return c.json({
      fingerprint: journey.fingerprint,
      status: journey.fingerprint?.status,
      stops: journey.stops.map((s, index) => ({ index, fingerprint: s.fingerprint })),
    });
  } catch (err) {
    console.error("[journal] fingerprint error:", err);
    return c.json({ error: "fingerprint_failed", message: "Could not compute the fingerprint." }, 500);
  }
});

journal.post("/", async (c) => {
  try {
    return c.json({ journey: await createJourney((await body(c)) as JourneyInputRaw) }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

journal.put("/:id", async (c) => {
  try {
    // Optional optimistic concurrency: `If-Match: <updatedAt the client loaded>` → 409 when stale.
    const ifMatch = c.req.header("If-Match")?.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
    const journey = await updateJourney(c.req.param("id"), (await body(c)) as JourneyInputRaw, ifMatch ? { ifUpdatedAt: ifMatch } : {});
    if (!journey) return c.json({ error: "not_found", message: "Journey not found" }, 404);
    return c.json({ journey });
  } catch (err) {
    return handleError(c, err);
  }
});

journal.delete("/:id", async (c) => {
  const removed = await deleteJourney(c.req.param("id"));
  if (!removed) return c.json({ error: "not_found", message: "Journey not found" }, 404);
  return c.json({ deleted: c.req.param("id") });
});

export default journal;
