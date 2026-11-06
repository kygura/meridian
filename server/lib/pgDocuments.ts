// Postgres backend for createJsonStore: one row per document in `meridian_documents`,
// keyed by the store's relative path ("journal.json", "cache/fx.json"). Used when
// DATABASE_URL is set, so Meridian can run on hosts without a persistent disk.
//
// - The table is created on first use; there is nothing else to migrate.
// - `update` runs in a transaction holding a row lock (SELECT … FOR UPDATE), so
//   read-modify-write is serialized across processes, not just within one.
// - Any Postgres works: Neon, Supabase, Railway, RDS, a local server.

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: { url: string; sql: Sql; ready: Promise<unknown> } | null = null;

export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : undefined;
}

function db(): { sql: Sql; ready: Promise<unknown> } {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (client?.url !== url) {
    if (client) void client.sql.end({ timeout: 1 });
    const sql = postgres(url, { max: 5, onnotice: () => {}, idle_timeout: 30 });
    const ready = sql`
      create table if not exists meridian_documents (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )`.catch((err: { code?: string }) => {
      // Two processes creating it at once: the loser sees a duplicate; the table exists either way.
      if (err.code !== "23505" && err.code !== "42P07") throw err;
    });
    client = { url, sql, ready };
  }
  return client;
}

// postgres.js types json params narrowly; documents are plain JSON values by contract.
type Json = Parameters<Sql["json"]>[0];

export async function pgRead<T>(key: string, fallback: () => T): Promise<T> {
  const { sql, ready } = db();
  await ready;
  const rows = await sql<{ value: T }[]>`select value from meridian_documents where key = ${key}`;
  return rows.length ? rows[0].value : fallback();
}

export async function pgWrite(key: string, value: unknown): Promise<void> {
  const { sql, ready } = db();
  await ready;
  await sql`
    insert into meridian_documents (key, value) values (${key}, ${sql.json(value as Json)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export async function pgUpdate<T, R>(key: string, fallback: () => T, fn: (current: T) => R | Promise<R>): Promise<R> {
  const { sql, ready } = db();
  await ready;
  return (await sql.begin(async (tx) => {
    await tx`
      insert into meridian_documents (key, value) values (${key}, ${tx.json(fallback() as Json)})
      on conflict (key) do nothing`;
    const [row] = await tx<{ value: T }[]>`select value from meridian_documents where key = ${key} for update`;
    const current = row.value;
    const result = await fn(current);
    await tx`update meridian_documents set value = ${tx.json(current as Json)}, updated_at = now() where key = ${key}`;
    return result;
  })) as R;
}

/** Close the pool (tests, scripts). The next call reconnects. */
export async function closeDatabase(): Promise<void> {
  const c = client;
  client = null;
  if (c) await c.sql.end({ timeout: 5 });
}
