import { describe, it, expect, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { closeDatabase, pgRead, pgUpdate, pgWrite } from "./pgDocuments";
import { createJsonStore } from "./jsonStore";

// Needs a scratch database: TEST_DATABASE_URL=postgres://… (only the keys these tests use are cleared).
const PG_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!PG_URL)("pgDocuments", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = PG_URL;
    const sql = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    await sql`create table if not exists meridian_documents (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`.catch(() => {});
    await sql`delete from meridian_documents where key in ${sql(["x.json", "list.json", "journal.json"])}`;
    await sql.end();
    await closeDatabase();
  });
  afterAll(async () => {
    delete process.env.DATABASE_URL;
    await closeDatabase();
  });

  it("reads the default, then what was written", async () => {
    expect(await pgRead("x.json", () => ({ n: 0 }))).toEqual({ n: 0 });
    await pgWrite("x.json", { n: 3 });
    await pgWrite("x.json", { n: 4 });
    expect(await pgRead("x.json", () => ({ n: 0 }))).toEqual({ n: 4 });
  });

  it("stores bare arrays", async () => {
    await pgWrite("list.json", [1, 2]);
    expect(await pgRead("list.json", () => [])).toEqual([1, 2]);
  });

  it("serializes updates with the row lock alone (no in-process queue)", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pgUpdate<{ items: number[] }, void>("x.json", () => ({ items: [] }), async (cur) => {
          await new Promise((r) => setTimeout(r, 5));
          cur.items.push(i);
        })
      )
    );
    const { items } = await pgRead("x.json", () => ({ items: [] as number[] }));
    expect([...items].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("rolls back when the update function throws", async () => {
    await pgWrite("x.json", { n: 1 });
    await expect(pgUpdate<{ n: number }, void>("x.json", () => ({ n: 0 }), (cur) => {
      cur.n = 99;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await pgRead("x.json", () => ({ n: 0 }))).toEqual({ n: 1 });
  });

  it("backs createJsonStore when DATABASE_URL is set", async () => {
    const store = createJsonStore("journal.json", () => ({ journeys: [] as string[] }));
    expect(store.path()).toBe("postgres:journal.json");
    await store.update((f) => void f.journeys.push("j1"));
    expect(await pgRead("journal.json", () => null)).toEqual({ journeys: ["j1"] });
  });
});
