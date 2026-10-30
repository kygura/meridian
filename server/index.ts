import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "net";
import { execSync } from "child_process";

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
import { gateRoutes } from "./middleware/auth.js";

// Load city data on startup
loadCities();
// Fingerprint every journey on save (spec-journal §5).
registerJournalFingerprint();

const app = new Hono();

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

// Health check
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve static files from dist/ in production
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 3001);

// ── Port conflict management ────────────────────────────────────────

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(true);
      else resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

function killProcessOnPort(port: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" });
      const match = out.match(/(\d+)\s*$/m);
      if (match) {
        const pid = match[1];
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[meridian] Killed process ${pid} on port ${port}`);
        return true;
      }
    } else {
      const out = execSync(`lsof -ti:${port}`, { encoding: "utf-8" }).trim();
      if (out) {
        const pids = out.split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGKILL");
            console.log(`[meridian] Killed process ${pid} on port ${port}`);
          } catch {
            // Process may have already exited
          }
        }
        return pids.length > 0;
      }
    }
  } catch {
    // lsof/netstat returned nothing — no process found
  }
  return false;
}

async function startServer(port: number): Promise<void> {
  const inUse = await isPortInUse(port);

  if (inUse) {
    console.log(`[meridian] Port ${port} is already in use.`);
    const killed = killProcessOnPort(port);
    if (killed) {
      // Wait briefly for the OS to release the port
      await new Promise((r) => setTimeout(r, 300));
      const stillInUse = await isPortInUse(port);
      if (stillInUse) {
        console.error(`[meridian] Port ${port} still in use after killing process. Trying next port...`);
        await startServer(port + 1);
        return;
      }
    } else {
      console.log(`[meridian] Could not identify process on port ${port}. Trying next port...`);
      await startServer(port + 1);
      return;
    }
  }

  console.log(`[meridian] Server starting on http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`[meridian] Server running on http://localhost:${port}`);
}

startServer(port);
