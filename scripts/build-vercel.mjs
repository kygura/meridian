// Writes Vercel's Build Output API v3 (.vercel/output) after `npm run build`:
//   static/          the Vite build (dist/)
//   functions/api.func  the Hono server bundled into one Node function, plus the
//                    read-only datasets it loads at startup
//   config.json      routes (/api/* → function, everything else → the SPA), the security
//                    headers for static files, and the daily jobs run (Vercel Cron)
//
// Usage: npm run build:vercel   (Vercel's build command; see docs/DEPLOY.md)

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const out = join(root, ".vercel/output");
const fn = join(out, "functions/api.func");

if (!existsSync(join(root, "dist/index.html"))) {
  console.error("dist/ is missing: run `npm run build` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

cpSync(join(root, "dist"), join(out, "static"), { recursive: true });

await build({
  entryPoints: [join(root, "server/vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
  // Some dependencies are CommonJS and call require() at runtime.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});

// Datasets the server reads from data/ (cities, airports, capitals, seasonality seed, events, phenomena).
// Personal data never ships: it lives in Postgres (DATABASE_URL).
const DATASETS = ["worldcities.csv", "airports.json", "capitals.json", "seasonality.json", "events.json", "phenomena.json", "native-names.json", "livability.json", "city-geo.json", "city-coast.json", "visa-requirements.json"];
mkdirSync(join(fn, "data"), { recursive: true });
// Optional datasets: the server copes without them (the feature reports "no data").
const OPTIONAL = new Set(["native-names.json", "livability.json", "city-geo.json", "city-coast.json", "visa-requirements.json"]);
for (const f of DATASETS) {
  const src = join(root, "data", f);
  if (!existsSync(src) && OPTIONAL.has(f)) {
    console.warn(`[build-vercel] data/${f} missing; skipping`);
    continue;
  }
  cpSync(src, join(fn, "data", f));
}

writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 60,
    },
    null,
    2
  )
);

// The same security headers the Hono app sends (server/lib/securityHeaders.ts), for the
// static files Vercel serves without going through the function.
const bundledHeaders = await build({
  entryPoints: [join(root, "server/lib/securityHeaders.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "warning",
});
const headersModule = await import(`data:text/javascript;base64,${Buffer.from(bundledHeaders.outputFiles[0].contents).toString("base64")}`);
const staticSecurityHeaders = headersModule.securityHeaders({
  production: true,
  apiOrigin: headersModule.originOf(process.env.VITE_API_BASE_URL),
});

writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/(.*)$", headers: staticSecurityHeaders, continue: true },
        { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        // The service worker must be revalidated on every load, or an update could sit behind the HTTP cache.
        { src: "^/sw\\.js$", headers: { "cache-control": "no-cache", "service-worker-allowed": "/" }, continue: true },
        { src: "^/manifest\\.webmanifest$", headers: { "content-type": "application/manifest+json" }, continue: true },
        { handle: "filesystem" },
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
      // Daily jobs: the watch run and anything registered with registerDailyJob (ADR 0016).
      // Needs CRON_SECRET: its own value (accepted for this route only) or the same value as
      // MERIDIAN_TOKEN.
      crons: [{ path: "/api/jobs/daily", schedule: "17 6 * * *" }],
    },
    null,
    2
  )
);

console.log("[build-vercel] wrote .vercel/output");
