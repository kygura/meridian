// Tiny generic JSON file store (spec-journal §4: "written atomically").
//
// - Path resolves lazily through getDataPath on every call, so tests can point
//   DATA_DIR at a temp dir after import.
// - Writes go to a temp file in the same directory, then rename(2) over the
//   target: readers see the old file or the new one, never a torn write.
// - Writes (and read-modify-write `update`s) are serialized per absolute path
//   through a promise chain, so concurrent updates never interleave or lose
//   each other's changes within this process.
// - A missing file reads as the default. A corrupt file THROWS rather than
//   reading as the default — silently "recovering" would let the next write
//   wipe the user's history.

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { getDataPath } from "./paths.js";

export interface JsonStore<T> {
  /** Absolute path of the backing file (resolved now). */
  path(): string;
  /** Current value, or a fresh default when the file does not exist. */
  read(): Promise<T>;
  /** Replace the whole value atomically. */
  write(value: T): Promise<void>;
  /** Serialized read-modify-write: `fn` mutates `current` in place (it is then
   *  written back); its return value is passed through to the caller. */
  update<R = void>(fn: (current: T) => R | Promise<R>): Promise<R>;
}

const chains = new Map<string, Promise<unknown>>();

function enqueue<R>(file: string, task: () => Promise<R>): Promise<R> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Keep the chain alive regardless of this task's outcome.
  const settled = next.catch(() => undefined);
  chains.set(file, settled);
  void settled.then(() => {
    if (chains.get(file) === settled) chains.delete(file);
  });
  return next;
}

async function readJson<T>(file: string, fallback: () => T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw err;
  }
  return JSON.parse(raw) as T;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** `relPath` is relative to the data root, e.g. "journal.json" or "cache/fx.json". */
export function createJsonStore<T>(relPath: string, defaultValue: () => T): JsonStore<T> {
  const path = () => getDataPath(relPath);
  return {
    path,
    read: () => readJson(path(), defaultValue),
    write: (value) => {
      const file = path();
      return enqueue(file, () => writeJsonAtomic(file, value));
    },
    update: (fn) => {
      const file = path();
      return enqueue(file, async () => {
        const current = await readJson(file, defaultValue);
        const result = await fn(current);
        await writeJsonAtomic(file, current);
        return result;
      });
    },
  };
}
