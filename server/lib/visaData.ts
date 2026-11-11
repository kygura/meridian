// Entry requirements per passport and destination (data/visa-requirements.json, built by
// scripts/build-visa-data.ts; ADR 0012). The curated rules (data/visa-curated.json) are
// imported by the pure module itself, src/lib/visa/data.ts.

import { readFileSync } from "fs";
import { join } from "path";
import type { VisaData } from "../../src/lib/visa/data.js";

let loaded: VisaData | null | undefined;

/** The requirements file, or null when it is missing (the app then says "no data"). */
export function getVisaData(): VisaData | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = JSON.parse(readFileSync(join(process.cwd(), "data", "visa-requirements.json"), "utf-8")) as VisaData;
  } catch {
    console.warn("[visa] data/visa-requirements.json missing: run npm run build:visa");
    loaded = null;
  }
  return loaded;
}

/** Test seam. */
export function setVisaData(d: VisaData | null | undefined): void {
  loaded = d;
}
