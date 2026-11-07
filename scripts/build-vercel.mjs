// Writes Vercel's Build Output API v3 (.vercel/output) after `npm run build`:
//   static/          the Vite build (dist/)
//   functions/api.func  the Hono server bundled into one Node function, plus the
//                    read-only datasets it loads at startup
//   config.json      routes (/api/* → function, everything else → the SPA) and the
//                    daily watch run (Vercel Cron)
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
const DATASETS = ["worldcities.csv", "airports.json", "capitals.json", "seasonality.json", "events.json", "phenomena.json"];
mkdirSync(join(fn, "data"), { recursive: true });
for (const f of DATASETS) cpSync(join(root, "data", f), join(fn, "data", f));

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

writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/assets/(.*)$", headers: { "cache-control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
      // Daily watch run (spec-journal §10). Needs CRON_SECRET = MERIDIAN_TOKEN.
      crons: [{ path: "/api/watches/run", schedule: "17 6 * * *" }],
    },
    null,
    2
  )
);

console.log("[build-vercel] wrote .vercel/output");
