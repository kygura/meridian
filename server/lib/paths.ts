import { mkdirSync } from "fs";
import { join } from "path";

// Resolve the data root lazily on every call so DATA_DIR can be overridden at
// runtime (notably in tests, which point it at a throwaway temp dir before
// touching persistence). Reading it at import time would freeze whatever value
// happened to be set when this module was first loaded.
function getDataRoot(): string {
  return process.env.DATA_DIR ?? join(process.cwd(), "data");
}

export function getDataPath(...parts: string[]): string {
  return join(getDataRoot(), ...parts);
}

export function ensureDataDir(...parts: string[]): string {
  const dir = getDataPath(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
