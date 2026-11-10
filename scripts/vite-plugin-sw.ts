// Vite plugin: after the app is built, bundle src/sw/sw.ts to <outDir>/sw.js with the
// list of files to precache and a version derived from their contents (ADR 0016).
// Build only: the dev server runs without a service worker.

import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { build } from "esbuild";
import type { Plugin, ResolvedConfig } from "vite";

/** Built files that don't belong in the precache. */
const SKIP = [/^sw\.js(\.map)?$/, /\.map$/, /(^|\/)LICENSE(\.[a-z]+)?$/i, /\.LICENSE\.txt$/, /(^|\/)\./];

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root));
    else out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** The precache list ("/index.html", "/assets/…") and a version that changes when any listed file does. */
export function precacheManifest(outDir: string): { files: string[]; version: string } {
  const files = walk(outDir)
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(join(outDir, f)));
  }
  return { files: files.map((f) => `/${f}`), version: hash.digest("hex").slice(0, 12) };
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "meridian-service-worker",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = join(config.root, config.build.outDir);
      const { files, version } = precacheManifest(outDir);
      let apiOrigin = "";
      try {
        const base = (config.env.VITE_API_BASE_URL as string | undefined) ?? process.env.VITE_API_BASE_URL ?? "";
        apiOrigin = base ? new URL(base).origin : "";
      } catch {
        apiOrigin = "";
      }
      await build({
        entryPoints: [join(config.root, "src/sw/sw.ts")],
        outfile: join(outDir, "sw.js"),
        bundle: true,
        format: "iife",
        target: "es2020",
        minify: true,
        logLevel: "warning",
        define: {
          __PRECACHE__: JSON.stringify(files),
          __SW_VERSION__: JSON.stringify(version),
          __API_ORIGIN__: JSON.stringify(apiOrigin),
        },
      });
      const bytes = files.reduce((n, f) => n + statSync(join(outDir, f)).size, 0);
      config.logger.info(`service worker: ${files.length} files precached (${(bytes / 1024 / 1024).toFixed(1)} MB), version ${version}`);
    },
  };
}
