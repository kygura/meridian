// The Hono app, without a listener: server/index.ts serves it on a port with the
// built frontend; server/vercel.ts exposes it as one Vercel function.
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loadCities } from "./lib/cities.js";
import citiesRoutes from "./routes/cities.js";
import metricsRoutes from "./routes/metrics.js";
import agentRoutes from "./routes/agent.js";
import shortlistRoutes from "./routes/shortlist.js";
import bookingsRoutes from "./routes/bookings.js";
import newsRoutes from "./routes/news.js";
import seasonalityRoutes from "./routes/seasonality.js";
import journalRoutes from "./routes/journal.js";
import replayRoutes from "./routes/replay.js";
import { registerJournalFingerprint } from "./lib/journalFingerprint.js";
import importRoutes from "./routes/import.js";
import watchesRoutes from "./routes/watches.js";
import tripsRoutes from "./routes/trips.js";
import livabilityRoutes from "./routes/livability.js";
import overlaysRoutes from "./routes/overlays.js";
import { gateRoutes } from "./middleware/auth.js";

// Load city data on startup
loadCities();
// Fingerprint every journey on save (spec-journal §5).
registerJournalFingerprint();

export const app = new Hono();

// CORS middleware for dev
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Token-gate personal-data prefixes (spec-journal D1/R1) — each prefix itself and
// everything under it, including routes later tasks mount. /api/bookings stays
// ungated (ruling R2).
gateRoutes(app);

// Mount API routes
app.route("/api/cities", citiesRoutes);
app.route("/api/metrics", metricsRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/shortlist", shortlistRoutes);
app.route("/api/bookings", bookingsRoutes);
app.route("/api/news", newsRoutes);
app.route("/api/seasonality", seasonalityRoutes);
app.route("/api/journal", journalRoutes);
app.route("/api/replay", replayRoutes);
app.route("/api/import", importRoutes);
app.route("/api/watches", watchesRoutes);
app.route("/api/trips", tripsRoutes);
app.route("/api/overlays", overlaysRoutes);
app.route("/api/livability", livabilityRoutes);

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
