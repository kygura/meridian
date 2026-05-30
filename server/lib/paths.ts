import { mkdirSync } from "fs";
import { join } from "path";

const dataRoot = process.env.DATA_DIR ?? join(process.cwd(), "data");

export function getDataPath(...parts: string[]): string {
  return join(dataRoot, ...parts);
}

export function ensureDataDir(...parts: string[]): string {
  const dir = getDataPath(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
