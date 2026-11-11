import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import postgres from "postgres";
import { closeDatabase } from "../lib/pgDocuments";
import { currentLocation, rotationRemindersDue } from "../lib/rotation";
import rotation from "./rotation";

// File backend always; Postgres too when TEST_DATABASE_URL points at a scratch database.
const TOKEN = "test-token";
const PG_URL = process.env.TEST_DATABASE_URL;
const backends = [{ name: "file", url: undefined }, ...(PG_URL ? [{ name: "postgres", url: PG_URL }] : [])];

const app = new Hono();
app.route("/api/rotation", rotation);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const lisbon = { cityId: "lisbon-portugal", name: "Lisbon", country: "Portugal", iata: "LIS", lat: 38.72, lng: -9.14 };
const bangkok = { cityId: "bangkok-thailand", name: "Bangkok", country: "Thailand", iata: "BKK", lat: 13.75, lng: 100.5 };
const stay = (over: Record<string, unknown> = {}) => ({ place: lisbon, kind: "base", status: "planned", start: "2026-10-01", end: "2026-12-01", ...over });

afterAll(() => closeDatabase());

describe.each(backends)("rotation routes ($name backend)", ({ url }) => {
  let TMP: string;
  beforeEach(async () => {
    TMP = mkdtempSync(join(tmpdir(), "meridian-rotation-route-"));
    process.env.DATA_DIR = TMP;
    process.env.MERIDIAN_TOKEN = TOKEN;
    if (url) {
      process.env.DATABASE_URL = url;
      const sql = postgres(url, { max: 1, onnotice: () => {} });
      await sql`create table if not exists meridian_documents (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`.catch(() => {});
      await sql`delete from meridian_documents where key in ${sql(["rotation.json"])}`;
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

  it("401s without the owner", async () => {
    expect((await req("GET", "/api/rotation", undefined, null)).status).toBe(401);
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay() }, "wrong")).status).toBe(401);
    expect((await req("GET", "/api/rotation/reminders", undefined, null)).status).toBe(401);
  });

  it("starts empty with default settings", async () => {
    const body = await (await req("GET", "/api/rotation?today=2026-11-10")).json();
    expect(body).toMatchObject({ stays: [], places: [], currentStayId: null, today: "2026-11-10" });
    expect(body.settings.horizonMonths).toBe(18);
  });

  it("creates stays, reports the current one, gaps, and the next move", async () => {
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay() })).status).toBe(200);
    const b = stay({ place: bangkok, kind: "pass-through", start: "2026-12-05", end: "2026-12-08" });
    expect((await req("PUT", "/api/rotation/stays/b", { stay: b })).status).toBe(200);
    const body = await (await req("GET", "/api/rotation?today=2026-11-10")).json();
    expect(body.currentStayId).toBe("a");
    expect(body.issues).toEqual([expect.objectContaining({ kind: "gap", days: 4 })]);
    const cur = await (await req("GET", "/api/rotation/current?today=2026-11-10")).json();
    expect(cur).toMatchObject({ daysLeft: 21, nextMoveDate: "2026-12-01" });
    expect(cur.next.id).toBe("b");
    expect((await currentLocation("2026-12-06"))?.id).toBe("b");
  });

  it("rejects contradictions and bad ids", async () => {
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay({ end: "2026-09-01" }) })).status).toBe(400);
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay({ minNights: 90, maxNights: 30 }) })).status).toBe(400);
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay({ window: { from: "2027-13", to: "2027-14" } }) })).status).toBe(400);
    expect((await req("PUT", "/api/rotation/stays/a%20b", { stay: stay() })).status).toBe(400);
    expect((await req("PUT", "/api/rotation/settings", { name: "x", horizonMonths: 30 })).status).toBe(400);
  });

  it("refuses a stale write from a second browser instead of overwriting", async () => {
    const first = await (await req("PUT", "/api/rotation/stays/a", { stay: stay() })).json();
    const v1 = first.stay.updatedAt;
    // Browser 1 saves an edit from v1.
    await new Promise((r) => setTimeout(r, 5));
    const ok = await req("PUT", "/api/rotation/stays/a", { stay: stay({ notes: "browser 1" }), baseUpdatedAt: v1 });
    expect(ok.status).toBe(200);
    // Browser 2 still edits from v1.
    const stale = await req("PUT", "/api/rotation/stays/a", { stay: stay({ notes: "browser 2" }), baseUpdatedAt: v1 });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error).toBe("conflict");
    expect(body.current.notes).toBe("browser 1");
    // Creating over an existing id without a base is a conflict too.
    expect((await req("PUT", "/api/rotation/stays/a", { stay: stay() })).status).toBe(409);
  });

  it("deletes with a tombstone that other browsers see, and refuses edits to a deleted stay", async () => {
    const v = (await (await req("PUT", "/api/rotation/stays/a", { stay: stay() })).json()).stay.updatedAt;
    expect((await (await req("DELETE", "/api/rotation/stays/a")).json()).existed).toBe(true);
    const body = await (await req("GET", "/api/rotation")).json();
    expect(body.stays).toEqual([]);
    expect(body.deleted).toEqual([{ kind: "stay", id: "a" }]);
    const r = await req("PUT", "/api/rotation/stays/a", { stay: stay(), baseUpdatedAt: v });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("deleted");
  });

  it("stores personal windows and lead times per place, which drive deadlines and reminders", async () => {
    const place = {
      name: "Lisbon",
      windows: [{ id: "w1", kind: "avoid", months: { start: 8, end: 8 }, reason: "too hot and crowded" }],
      leadTime: { min: 8, max: 10 },
    };
    expect((await req("PUT", "/api/rotation/places/lisbon-portugal", { place })).status).toBe(200);
    await req("PUT", "/api/rotation/stays/a", { stay: stay({ start: "2027-01-10", end: "2027-03-10" }) });
    const d = await (await req("GET", "/api/rotation/deadlines?today=2026-11-10")).json();
    // 10 weeks before 10 Jan 2027.
    expect(d.deadlines).toEqual([expect.objectContaining({ stayId: "a", bookBy: "2026-11-01", basis: "place", daysLeft: -9 })]);
    const r = await (await req("GET", "/api/rotation/reminders?today=2026-11-10")).json();
    expect(r.reminders).toEqual([expect.objectContaining({ stayId: "a", kind: "overdue" })]);
    expect((await rotationRemindersDue("2026-10-01", 14)).length).toBe(0);
    expect((await req("PUT", "/api/rotation/places/lisbon-portugal", { place: { ...place, leadTime: { min: 5, max: 2 } } })).status).toBe(400);
  });

  it("saves settings with an optional home airport", async () => {
    const r = await req("PUT", "/api/rotation/settings", { name: "Slow year", horizonMonths: 12, home: lisbon });
    expect(r.status).toBe(200);
    const body = await (await req("GET", "/api/rotation")).json();
    expect(body.settings).toMatchObject({ name: "Slow year", horizonMonths: 12, home: { iata: "LIS" } });
    // A second browser without the new base is told it changed.
    expect((await req("PUT", "/api/rotation/settings", { name: "Other", horizonMonths: 18 })).status).toBe(409);
  });
});
