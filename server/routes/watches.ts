// /api/watches (spec-journal §10, R7). Token-gated (also by gateRoutes in index.ts).
// Static paths (/run, /alerts) are registered before /:id.

import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { requireToken } from "../middleware/auth.js";
import { executeReplay } from "../lib/replayService.js";
import {
  WatchLimitError,
  createWatch,
  deleteWatch,
  listAlerts,
  listWatches,
  markAlertSeen,
  runWatches,
  type WatchRunDeps,
} from "../lib/watches.js";

let depsFactory: () => WatchRunDeps = () => ({ now: () => new Date(), replay: executeReplay });

/** Test seam: inject now / replay / webhook for POST /run; no arg restores the real wiring. */
export function setWatchDepsFactory(f?: () => WatchRunDeps): void {
  depsFactory = f ?? (() => ({ now: () => new Date(), replay: executeReplay }));
}

const watches = new Hono();
watches.use("*", requireToken);

watches.post("/", async (c) => {
  try {
    const watch = await createWatch(await c.req.json().catch(() => null));
    return c.json({ watch }, 201);
  } catch (err) {
    if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    if (err instanceof WatchLimitError) return c.json({ error: "too_many_watches", message: err.message }, 400);
    console.error("[watches] create failed:", err);
    return c.json({ error: "watch_failed" }, 500);
  }
});

watches.get("/", async (c) => c.json({ watches: await listWatches() }));

const runHandler = async (c: Context) => {
  try {
    return c.json(await runWatches(depsFactory()));
  } catch (err) {
    console.error("[watches] run failed:", err);
    return c.json({ error: "run_failed", message: "Could not run watches." }, 500);
  }
};
watches.post("/run", runHandler);
// Vercel Cron calls GET with "Authorization: Bearer $CRON_SECRET"; set CRON_SECRET to the
// same value as MERIDIAN_TOKEN and the token gate above accepts it.
watches.get("/run", runHandler);

watches.get("/alerts", async (c) => c.json({ alerts: await listAlerts({ unseen: c.req.query("unseen") === "1" }) }));

watches.post("/alerts/:id/seen", async (c) => {
  const alert = await markAlertSeen(c.req.param("id"));
  return alert ? c.json({ alert }) : c.json({ error: "not_found" }, 404);
});

watches.delete("/:id", async (c) => ((await deleteWatch(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));

export default watches;
