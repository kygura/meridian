// /api/notifications: the Notice list, channel status, the test alert and Web Push
// subscriptions (ADR 0016). Token-gated here, the same way /api/watches is.
// Static paths are registered before /:id.

import { Hono } from "hono";
import { ZodError, z } from "zod";
import { randomUUID } from "crypto";
import { requireToken } from "../middleware/auth.js";
import { listChannels, listNotices, markAllNoticesSeen, markNoticeSeen, notify } from "../lib/notifier.js";
import { removePushSubscription, savePushSubscription, vapidConfig } from "../lib/notify/webPush.js";

const notifications = new Hono();
notifications.use("*", requireToken);

notifications.get("/", async (c) => {
  const all = await listNotices();
  return c.json({ notices: all.slice(0, 100), unseen: all.filter((n) => !n.seen).length });
});

notifications.get("/channels", async (c) => c.json({ channels: await listChannels() }));

/** Sends a real Notice through every configured channel and returns how each fared. */
notifications.post("/test", async (c) => {
  try {
    const result = await notify({
      kind: "test",
      title: "Test alert from Meridian",
      body: "If you can read this, alerts reach you here.",
      url: "/#/",
      dedupeKey: `test:${randomUUID()}`,
    });
    return c.json({ notice: result.notice, deliveries: result.deliveries });
  } catch (err) {
    console.error("[notifications] test failed:", err);
    return c.json({ error: "test_failed", message: "Could not send the test alert." }, 500);
  }
});

notifications.post("/seen", async (c) => c.json({ marked: await markAllNoticesSeen() }));

/** The VAPID public key the browser subscribes with. 404 `push_not_configured` when the server has no keys. */
notifications.get("/push/key", (c) => {
  const vapid = vapidConfig();
  if ("missing" in vapid) return c.json({ error: "push_not_configured", message: `Push needs ${vapid.missing} on the server.` }, 404);
  return c.json({ publicKey: vapid.publicKey });
});

notifications.post("/push/subscribe", async (c) => {
  if ("missing" in vapidConfig()) return c.json({ error: "push_not_configured" }, 404);
  try {
    const sub = await savePushSubscription(await c.req.json().catch(() => null));
    return c.json({ ok: true, endpoint: sub.endpoint }, 201);
  } catch (err) {
    if (err instanceof ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    console.error("[notifications] subscribe failed:", err);
    return c.json({ error: "subscribe_failed" }, 500);
  }
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });
notifications.post("/push/unsubscribe", async (c) => {
  const parsed = unsubscribeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  return c.json({ ok: true, removed: await removePushSubscription(parsed.data.endpoint) });
});

notifications.post("/:id/seen", async (c) => {
  const notice = await markNoticeSeen(c.req.param("id"));
  return notice ? c.json({ notice }) : c.json({ error: "not_found" }, 404);
});

export default notifications;
