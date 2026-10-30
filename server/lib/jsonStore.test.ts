import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createJsonStore } from "./jsonStore";

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-jsonstore-"));
  process.env.DATA_DIR = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("createJsonStore", () => {
  it("reads the default when the file is missing", async () => {
    const store = createJsonStore("x.json", () => ({ n: 0 }));
    expect(await store.read()).toEqual({ n: 0 });
  });

  it("resolves DATA_DIR lazily and creates nested dirs on write", async () => {
    const store = createJsonStore("cache/deep/x.json", () => ({ n: 0 }));
    await store.write({ n: 7 });
    expect(store.path()).toBe(join(TMP, "cache/deep/x.json"));
    expect(JSON.parse(readFileSync(store.path(), "utf-8"))).toEqual({ n: 7 });
  });

  it("leaves no temp files behind", async () => {
    const store = createJsonStore("x.json", () => ({ n: 0 }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.write({ n: i })));
    expect(readdirSync(TMP)).toEqual(["x.json"]);
  });

  it("serializes concurrent updates so none are lost", async () => {
    const store = createJsonStore<{ items: number[] }>("x.json", () => ({ items: [] }));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.update(async (cur) => {
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          cur.items.push(i);
        }),
      ),
    );
    const { items } = await store.read();
    expect(items).toHaveLength(50);
    expect([...items].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("runs updates in call order and passes the return value through", async () => {
    const store = createJsonStore<{ log: string[] }>("x.json", () => ({ log: [] }));
    const results = await Promise.all(
      ["a", "b", "c"].map((s) =>
        store.update((cur) => {
          cur.log.push(s);
          return cur.log.length;
        }),
      ),
    );
    expect(results).toEqual([1, 2, 3]);
    expect((await store.read()).log).toEqual(["a", "b", "c"]);
  });

  it("a failing update does not write and does not break the chain", async () => {
    const store = createJsonStore<{ n: number }>("x.json", () => ({ n: 0 }));
    await store.write({ n: 1 });
    const bad = store.update((cur) => {
      cur.n = 99;
      throw new Error("boom");
    });
    const good = store.update((cur) => {
      cur.n += 1;
    });
    await expect(bad).rejects.toThrow("boom");
    await good;
    expect((await store.read()).n).toBe(2);
  });

  it("throws on a corrupt file instead of reading it as the default", async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "x.json"), "{not json");
    const store = createJsonStore("x.json", () => ({ n: 0 }));
    await expect(store.read()).rejects.toThrow();
  });
});
