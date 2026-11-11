// Distance to the sea coast per city (data/city-coast.json, scripts/build-city-coast.ts),
// for the solver's "by the sea" preference. From Natural Earth's 1:10m coastline.

import { readFileSync } from "fs";
import { join } from "path";
import type { Sourced } from "../../src/lib/solver/types.js";

interface CoastFile {
  builtAt: string;
  source: string;
  maxKm: number;
  cities: Record<string, number>;
}

let loaded: CoastFile | null | undefined;

function load(): CoastFile | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = JSON.parse(readFileSync(join(process.cwd(), "data", "city-coast.json"), "utf-8")) as CoastFile;
  } catch {
    console.warn("[coast] data/city-coast.json missing: run scripts/build-city-coast.ts");
    loaded = null;
  }
  return loaded;
}

/** km to the coast; a city not in the file is further than the file's limit. Null without the file. */
export function coastKmFor(cityId: string): Sourced | null {
  const f = load();
  if (!f) return null;
  const km = f.cities[cityId];
  if (km === undefined) return { value: f.maxKm + 1, source: `${f.source}: more than ${f.maxKm} km` };
  return { value: km, source: f.source };
}

/** Test seam. */
export function resetCoast(): void {
  loaded = undefined;
}
