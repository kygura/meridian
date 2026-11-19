import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// The Vercel function only has the data files scripts/build-vercel.mjs copies into it. Twice a
// file the server reads was left out (place data, then climate normals), and production quietly
// showed "no data". This keeps the copy list in step with what the server code reads.

function serverSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__fixtures__" ? [] : serverSources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe("Vercel bundle", () => {
  it("copies every dataset the server reads from data/", () => {
    const build = readFileSync(join(process.cwd(), "scripts", "build-vercel.mjs"), "utf-8");
    const list = /const DATASETS = \[([^\]]*)\]/.exec(build)?.[1] ?? "";
    const shipped = new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

    const read = new Set<string>();
    for (const file of serverSources(join(process.cwd(), "server"))) {
      const src = readFileSync(file, "utf-8");
      for (const m of src.matchAll(/"data\/([a-z-]+\.(?:json|csv))"/g)) read.add(m[1]);
      for (const m of src.matchAll(/join\((?:process\.cwd\(\), "data"|dir), "([a-z-]+\.(?:json|csv))"/g)) read.add(m[1]);
      for (const m of src.matchAll(/COMMITTED_CLIMATE_FILE = "([a-z-]+\.json)"/g)) read.add(m[1]);
    }

    expect(read.size).toBeGreaterThan(5);
    expect([...read].filter((f) => !shipped.has(f))).toEqual([]);
    expect(shipped.has("climate-normals.json")).toBe(true);
  });
});
