import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireToken } from "../middleware/auth.js";
import {
  NotionSetupError,
  PlanChangedError,
  applyImport,
  candidatePool,
  getStatus,
  previewImport,
  resolveReviewItem,
  saveConfig,
  writeBackRotation,
  type Deps,
  type Source,
} from "../lib/notion/service.js";
import { NotionError } from "../lib/notion/client.js";

// Notion bridge (ADR 0017). Owner-only: it reads the owner's planning workspace and
// writes their rotation. The integration token lives in NOTION_TOKEN, never in a request.
const notion = new Hono();
notion.use("*", requireToken);

let testDeps: Deps = {};
/** Test seam: a fake Notion client or fetch. */
export function setNotionDeps(d: Deps = {}): void {
  testDeps = d;
}

const name = z.string().trim().min(1).max(100);
const idText = z.string().trim().max(300);
const configSchema = z
  .object({
    seasonsDb: idText,
    researchDb: idText,
    researchPage: idText,
    daily: z.boolean(),
    seasons: z.object({ title: name, place: name, kind: name, start: name, end: name, notes: name, country: name }).partial(),
    research: z.object({ name, country: name, type: name, stay: name, stayMin: name, stayMax: name, budget: name, budgetMin: name, budgetMax: name, currency: name, notes: name, overall: name }).partial(),
    writeBack: z.object({ enabled: z.boolean(), database: idText }).partial(),
  })
  .partial();

const file = z.string().max(4_000_000);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api") }),
  z.object({ kind: z.literal("upload"), seasonsCsv: file.optional(), researchCsv: file.optional(), researchMarkdown: file.optional() }),
]);
const importBody = z.object({ source: sourceSchema, digest: z.string().max(64).optional() });

const limit = bodyLimit({ maxSize: 9_000_000, onError: (c) => c.json({ error: "too_large" }, 413) });

function fail(c: Context, err: unknown) {
  if (err instanceof NotionSetupError) return c.json({ error: "not_configured", message: err.message }, 400);
  if (err instanceof PlanChangedError) return c.json({ error: "plan_changed", message: err.message }, 409);
  if (err instanceof NotionError) return c.json({ error: "notion_error", message: err.message }, 502);
  console.error("[notion] failed:", err instanceof Error ? err.message : err);
  return c.json({ error: "notion_failed", message: "The Notion import failed." }, 500);
}

notion.get("/status", async (c) => c.json(await getStatus()));

notion.put("/config", async (c) => {
  const p = configSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid request", issues: p.error.issues }, 400);
  await saveConfig(p.data);
  return c.json(await getStatus());
});

notion.post("/preview", limit, async (c) => {
  const p = importBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid request", issues: p.error.issues }, 400);
  try {
    return c.json({ plan: await previewImport(p.data.source as Source, testDeps) });
  } catch (err) {
    return fail(c, err);
  }
});

notion.post("/apply", limit, async (c) => {
  const p = importBody.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid request", issues: p.error.issues }, 400);
  try {
    return c.json(await applyImport(p.data.source as Source, { expectDigest: p.data.digest }, testDeps));
  } catch (err) {
    return fail(c, err);
  }
});

notion.get("/pool", async (c) => c.json({ pool: await candidatePool() }));

const resolveSchema = z.object({ key: z.string().min(1).max(400), cityIds: z.array(z.string().min(1).max(200)).max(10) });
notion.post("/review/resolve", async (c) => {
  const p = resolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: "Invalid request", issues: p.error.issues }, 400);
  try {
    return (await resolveReviewItem(p.data.key, p.data.cityIds)) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

notion.post("/write-back", async (c) => {
  try {
    return c.json(await writeBackRotation(testDeps));
  } catch (err) {
    return fail(c, err);
  }
});

export default notion;
