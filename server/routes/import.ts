import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { z, ZodError } from "zod";
import { requireToken } from "../middleware/auth.js";
import { FxUnavailableError } from "../lib/fx.js";
import { JournalValidationError } from "../lib/journal.js";
import {
  MAX_BATCH,
  ImportError,
  PartialMergeError,
  acceptCluster,
  accept,
  addAll,
  addCandidates,
  discard,
  flagCancelled,
  getQueue,
  merge,
  mergeCluster,
  resolveCandidate,
} from "../lib/imports.js";
import { getSettings } from "../lib/journal.js";
import { MAX_UPLOAD_BYTES, parseEmailUpload } from "../lib/ingest/jsonld.js";
import { MAX_PHOTOS, parsePhotos } from "../lib/ingest/photos.js";
import { parseTimeline } from "../lib/ingest/timeline.js";

const imports = new Hono();

// Gated here as well as in index.ts, so the module is safe however it is mounted.
imports.use("*", requireToken);

const acceptBodySchema = z.object({ journeyId: z.string().trim().min(1).max(200).optional() });
const mergeBodySchema = z.object({ journeyId: z.string().trim().min(1).max(200) });

const badRequest = (c: Context, issues: unknown) => c.json({ error: "Invalid request", issues }, 400);
const body = (c: Context): Promise<unknown> => c.req.json().catch(() => null);

/** Map lib errors to HTTP; unexpected ones become a generic 500. `extra` is merged into error bodies. */
function handleError(c: Context, err: unknown, extra: object = {}): Response {
  if (err instanceof PartialMergeError) return handleError(c, err.cause, { merged: err.merged, remaining: err.remaining });
  if (err instanceof ImportError) return c.json({ ...err.body, ...extra }, err.status);
  if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues, ...extra }, 400);
  if (err instanceof JournalValidationError) return c.json({ error: "Invalid request", issues: err.issues, ...extra }, 400);
  if (err instanceof FxUnavailableError) {
    return c.json({ error: "fx_unavailable", message: err.message, currency: err.currency, date: err.date, ...extra }, 422);
  }
  console.error("[import] error:", err);
  return c.json({ error: "import_failed", message: "Could not process the import.", ...extra }, 500);
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

// File uploads are parsed in memory (never stored); only the candidates they yield are.
const uploadLimit = bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "too_large", maxBytes: MAX_UPLOAD_BYTES }, 413) });

/** Raw .eml/.mbox body (message/rfc822, application/mbox, text/plain, ...) or multipart/form-data field "file". */
imports.post("/upload/email", uploadLimit, async (c) => {
  try {
    let bytes: Uint8Array;
    if ((c.req.header("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const file = (await c.req.parseBody().catch(() => ({})) as Record<string, unknown>).file;
      if (typeof file !== "object" || file === null || !("arrayBuffer" in file)) return badRequest(c, [{ message: 'expected a multipart field named "file"' }]);
      bytes = new Uint8Array(await (file as Blob).arrayBuffer());
    } else bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.byteLength) return badRequest(c, [{ message: "empty upload" }]);
    const parsed = parseEmailUpload(bytes);
    const report = await addAll(parsed.candidates);
    const cancelled = await flagCancelled(parsed.cancelled);
    const errors = [...parsed.errors, ...(report.errors ?? [])];
    return c.json({ ...report, unstructured: parsed.unstructured, ...(cancelled ? { cancelled } : {}), ...(errors.length ? { errors } : {}) });
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/upload/timeline", uploadLimit, async (c) => {
  const json = await body(c);
  if (json === null || typeof json !== "object") return badRequest(c, [{ message: "expected the Timeline JSON export as the request body" }]);
  try {
    const parsed = parseTimeline(json, (await getSettings()).homeCityId);
    const report = await addAll(parsed.candidates);
    const errors = [...parsed.errors, ...(report.errors ?? [])];
    return c.json({ ...report, ...(errors.length ? { errors } : {}), visits: parsed.visits, homeCityId: parsed.homeCityId, homeInferred: parsed.homeInferred });
  } catch (err) {
    return handleError(c, err);
  }
});

imports.post("/photos", limitBody, async (c) => {
  const items = await body(c);
  if (!Array.isArray(items)) return badRequest(c, [{ message: "expected a JSON array of {timestamp, lat, lng, hash}" }]);
  if (items.length > MAX_PHOTOS) return c.json({ error: "too_many", max: MAX_PHOTOS }, 413);
  try {
    const parsed = parsePhotos(items, (await getSettings()).homeCityId);
    const report = await addAll(parsed.candidates);
    const errors = [...parsed.errors, ...(report.errors ?? [])];
    return c.json({ ...report, ...(errors.length ? { errors } : {}), photos: parsed.photos, excludedHome: parsed.excludedHome, homeCityId: parsed.homeCityId, homeInferred: parsed.homeInferred });
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

imports.post("/cluster/:clusterId/merge", async (c) => {
  const parsed = mergeBodySchema.safeParse(await body(c));
  if (!parsed.success) return badRequest(c, parsed.error.issues);
  try {
    return c.json(await mergeCluster(c.req.param("clusterId"), parsed.data.journeyId));
  } catch (err) {
    return handleError(c, err);
  }
});

const cityId = z.string().trim().min(1).max(200);
const patchBodySchema = z.object({ cityId: cityId.optional(), fromCityId: cityId.optional(), toCityId: cityId.optional() }).strict();

/** Resolve the cities of a candidate flagged "unresolved-city". */
imports.patch("/:id", async (c) => {
  const parsed = patchBodySchema.safeParse(await body(c));
  if (!parsed.success) return badRequest(c, parsed.error.issues);
  try {
    return c.json({ candidate: await resolveCandidate(c.req.param("id"), parsed.data) });
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
