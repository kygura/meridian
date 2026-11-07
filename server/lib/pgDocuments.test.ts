import { describe, it, expect, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { connect, createServer } from "net";
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

  it("recovers on the same URL after the database was unreachable at first use", async () => {
    // A TCP proxy that isn't listening yet stands in for a database that is down.
    const target = new URL(PG_URL!);
    const proxy = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      client.pipe(upstream).pipe(client);
      const close = () => (client.destroy(), upstream.destroy());
      client.on("error", close);
      upstream.on("error", close);
    });
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const viaProxy = new URL(PG_URL!);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String(port);
    process.env.DATABASE_URL = viaProxy.toString();
    await closeDatabase();

    await expect(pgRead("x.json", () => 0)).rejects.toThrow();
    await new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));
    try {
      await expect(pgRead("x.json", () => 0)).resolves.toBe(0);
    } finally {
      await closeDatabase();
      await new Promise((r) => proxy.close(r));
      process.env.DATABASE_URL = PG_URL;
    }
  });

  it("backs createJsonStore when DATABASE_URL is set", async () => {
    const store = createJsonStore("journal.json", () => ({ journeys: [] as string[] }));
    expect(store.path()).toBe("postgres:journal.json");
    await store.update((f) => void f.journeys.push("j1"));
    expect(await pgRead("journal.json", () => null)).toEqual({ journeys: ["j1"] });
  });
});
