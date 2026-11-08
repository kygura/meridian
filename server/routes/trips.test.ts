import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import postgres from "postgres";
import { gateRoutes } from "../middleware/auth";
import { closeDatabase } from "../lib/pgDocuments";
import trips from "./trips";

// Runs against the file backend always, and against Postgres too when
// TEST_DATABASE_URL points at a scratch database (only its trips.json row is cleared).
const TOKEN = "test-token";
const PG_URL = process.env.TEST_DATABASE_URL;
const backends = [{ name: "file", url: undefined }, ...(PG_URL ? [{ name: "postgres", url: PG_URL }] : [])];

const app = new Hono();
gateRoutes(app);
app.route("/api/trips", trips);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const lima = { cityId: "lima-peru", name: "Lima", iata: "LIM", lat: -12.05, lng: -77.05 };
const trip = (name = "South America") => ({ name, color: "#6d28d9", status: "scouting", nodes: [lima] });

afterAll(() => closeDatabase());

describe.each(backends)("trips routes ($name backend)", ({ url }) => {
  let TMP: string;
  beforeEach(async () => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-trips-route-"));
    process.env.DATA_DIR = TMP;
    process.env.MERIDIAN_TOKEN = TOKEN;
    if (url) {
      process.env.DATABASE_URL = url;
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      await sql`create table if not exists meridian_documents (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`.catch(() => {});
      await sql`delete from meridian_documents where key in ${sql(["trips.json"])}`;
      await sql.end();
      await closeDatabase();
    }
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.MERIDIAN_TOKEN;
    delete process.env.DATABASE_URL;
  });

  it("401s without the token", async () => {
    expect((await req("GET", "/api/trips", undefined, null)).status).toBe(401);
    expect((await req("PUT", "/api/trips/a", trip(), "wrong")).status).toBe(401);
    expect((await req("DELETE", "/api/trips/a", undefined, null)).status).toBe(401);
  });

  it("creates, replaces, lists and deletes trips", async () => {
    expect(await (await req("GET", "/api/trips")).json()).toEqual({ trips: [], deleted: [] });

    const created = await req("PUT", "/api/trips/plan-1", trip());
    expect(created.status).toBe(200);
    const { trip: stored } = await created.json();
    expect(stored).toMatchObject({ id: "plan-1", name: "South America", origin: "manual", nodes: [lima] });
    expect(Date.parse(stored.updatedAt)).not.toBeNaN();

    await req("PUT", "/api/trips/plan-1", trip("Renamed"));
    await req("PUT", "/api/trips/plan-2", trip("Other"));
    let list = await (await req("GET", "/api/trips")).json();
    expect(list.trips.map((t: { id: string; name: string }) => `${t.id}:${t.name}`)).toEqual(["plan-1:Renamed", "plan-2:Other"]);

    expect(await (await req("DELETE", "/api/trips/plan-1")).json()).toEqual({ deleted: "plan-1", existed: true });
    list = await (await req("GET", "/api/trips")).json();
    expect(list.trips.map((t: { id: string }) => t.id)).toEqual(["plan-2"]);
    expect(list.deleted).toEqual(["plan-1"]);

    // Re-creating clears the tombstone.
    await req("PUT", "/api/trips/plan-1", trip());
    expect((await (await req("GET", "/api/trips")).json()).deleted).toEqual([]);
  });

  it("stores a trip's season, year and per-stop months", async () => {
    const body = { ...trip(), nodes: [{ ...lima, months: { start: 11, end: 2 } }], season: { start: 11, end: 2 }, year: 2027 };
    const { trip: stored } = await (await req("PUT", "/api/trips/seasonal", body)).json();
    expect(stored).toMatchObject({ season: { start: 11, end: 2 }, year: 2027, nodes: [{ months: { start: 11, end: 2 } }] });
    expect((await req("PUT", "/api/trips/bad-month", { ...trip(), season: { start: 0, end: 13 } })).status).toBe(400);
    expect((await req("PUT", "/api/trips/bad-year", { ...trip(), year: 27 })).status).toBe(400);
  });

  it("rejects bad ids and bodies", async () => {
    expect((await req("PUT", "/api/trips/bad%20id", trip())).status).toBe(400);
    expect((await req("PUT", "/api/trips/ok", { ...trip(), status: "nope" })).status).toBe(400);
    expect((await req("PUT", "/api/trips/ok", { ...trip(), nodes: [{ name: "no city" }] })).status).toBe(400);
  });

  it("keeps every write under concurrent puts", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => req("PUT", `/api/trips/t${i}`, trip(`T${i}`))));
    const list = await (await req("GET", "/api/trips")).json();
    expect(list.trips).toHaveLength(12);
  });
});
