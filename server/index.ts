import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";

import { loadCities } from "./lib/cities.js";
import citiesRoutes from "./routes/cities.js";
import metricsRoutes from "./routes/metrics.js";
import agentRoutes from "./routes/agent.js";
import shortlistRoutes from "./routes/shortlist.js";

// Load city data on startup
loadCities();

const app = new Hono();

// CORS middleware for dev
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Mount API routes
app.route("/api/cities", citiesRoutes);
app.route("/api/metrics", metricsRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/shortlist", shortlistRoutes);

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve static files from dist/ in production
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 3001);

console.log(`[meridian] Server starting on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`[meridian] Server running on http://localhost:${port}`);
