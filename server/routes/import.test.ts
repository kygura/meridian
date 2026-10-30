import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { loadCities } from "../lib/cities";
import { setFxFetch } from "../lib/fx";
import { createJourney } from "../lib/journal";
import { gateRoutes } from "../middleware/auth";
import importRoutes from "./import";

const TOKEN = "test-token";
let TMP: string;

// Same wiring as server/index.ts (index.ts starts a listener on import).
const app = new Hono();
gateRoutes(app);
app.route("/api/import", importRoutes);

function req(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const exp = (ref: string, date = "2024-05-03", cityHint = "Lisbon") => ({
  kind: "experience",
  provenance: { source: "calendar", sourceRef: ref, confidence: "high" },
  payload: { title: "Tour", cityHint, date },
});

beforeAll(() => loadCities());

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "meridian-import-route-"));
  process.env.DATA_DIR = TMP;
  process.env.MERIDIAN_TOKEN = TOKEN;
  setFxFetch(async () => ({ ok: true, status: 200, json: async () => ({ date: "2024-05-02", rates: { EUR: 0.9 } }) }));
});

afterEach(() => {
  setFxFetch();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.MERIDIAN_TOKEN;
});

describe("auth", () => {
  it("401 without a valid token on every import route", async () => {
    const routes: [string, string][] = [
      ["POST", "/api/import"], ["GET", "/api/import/queue"], ["POST", "/api/import/x/accept"],
      ["POST", "/api/import/x/merge"], ["POST", "/api/import/x/discard"], ["POST", "/api/import/cluster/x/accept"],
    ];
    for (const [m, p] of routes) {
      expect((await req(m, p, m === "GET" ? undefined : [], null)).status, `${m} ${p}`).toBe(401);
      expect((await req(m, p, m === "GET" ? undefined : [], "wrong")).status, `${m} ${p}`).toBe(401);
    }
  });

  it("401 journal_locked when MERIDIAN_TOKEN is unset; the module gates itself when mounted bare", async () => {
    delete process.env.MERIDIAN_TOKEN;
    const res = await req("GET", "/api/import/queue");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "journal_locked", reason: "token_not_configured" });
    expect((await importRoutes.request("/queue")).status).toBe(401);
  });
});

describe("POST /api/import", () => {
  it("413 too_large for a body over the size limit, before it is parsed", async () => {
    const res = await req("POST", "/api/import", [{ ...exp("a"), payload: { ...exp("a").payload, notes: "x".repeat(3 * 1024 * 1024) } }]);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large" });
  });

  it("400 for a non-array body, 413 above 500, a report otherwise", async () => {
    expect((await req("POST", "/api/import", { kind: "stop" })).status).toBe(400);
    expect((await req("POST", "/api/import", "x")).status).toBe(400);
    const big = await req("POST", "/api/import", new Array(501).fill(exp("a")));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_many", max: 500 });

    const res = await req("POST", "/api/import", [exp("a"), exp("a"), { kind: "bogus" }]);
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report).toMatchObject({ received: 3, added: 1, duplicates: 1 });
    expect(report.errors).toHaveLength(1);
  });
});

describe("review flow", () => {
  it("queue → accept → 409 on repeat", async () => {
    await req("POST", "/api/import", [exp("a")]);
    const queue = await (await req("GET", "/api/import/queue")).json();
    expect(queue.candidates).toHaveLength(1);
    expect(queue.clusters).toHaveLength(1);

    const res = await req("POST", "/api/import/calendar:a/accept");
    expect(res.status).toBe(201);
    const { journey } = await res.json();
    expect(journey).toMatchObject({ status: "confirmed", experiences: [{ title: "Tour" }] });
    expect((await req("POST", "/api/import/calendar:a/accept")).status).toBe(409);
    expect((await req("POST", "/api/import/nope/accept")).status).toBe(404);
    expect((await (await req("GET", "/api/import/queue")).json()).candidates).toEqual([]);
  });

  it("merge requires journeyId; merges into the journey", async () => {
    await req("POST", "/api/import", [exp("a", "2024-05-04")]);
    expect((await req("POST", "/api/import/calendar:a/merge", {})).status).toBe(400);
    expect((await req("POST", "/api/import/calendar:a/merge", { journeyId: "nope" })).status).toBe(404);
    const j = await createJourney({ title: "L", startDate: "2024-05-02", endDate: "2024-05-06", stops: [{ cityId: "lisbon-portugal", arrive: "2024-05-02", depart: "2024-05-06" }] });
    const res = await req("POST", "/api/import/calendar:a/merge", { journeyId: j.id });
    expect(res.status).toBe(200);
    expect((await res.json()).journey.experiences).toHaveLength(1);
  });

  it("discard", async () => {
    await req("POST", "/api/import", [exp("a")]);
    const res = await req("POST", "/api/import/calendar:a/discard");
    expect((await res.json()).candidate.state).toBe("discarded");
    expect((await req("POST", "/api/import/calendar:a/discard")).status).toBe(409);
  });

  it("cluster accept: 201 journey, 404 for an unknown cluster, 409 unresolved", async () => {
    await req("POST", "/api/import", [exp("a"), exp("b", "2024-05-04", "Xyzzyville")]);
    const { clusters } = await (await req("GET", "/api/import/queue")).json();
    const blocked = await req("POST", `/api/import/cluster/${clusters[0].id}/accept`);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "unresolved", candidateIds: ["calendar:b"] });

    await req("POST", "/api/import/calendar:b/discard");
    const { clusters: next } = await (await req("GET", "/api/import/queue")).json();
    const ok = await req("POST", `/api/import/cluster/${next[0].id}/accept`);
    expect(ok.status).toBe(201);
    expect((await ok.json()).journey.status).toBe("confirmed");
    expect((await req("POST", "/api/import/cluster/cl_missing/accept")).status).toBe(404);
  });

  it("422 when no FX rate is available (and the candidate stays pending)", async () => {
    setFxFetch(async () => { throw new Error("offline"); });
    await req("POST", "/api/import", [{ ...exp("a"), payload: { title: "T", cityHint: "Lisbon", date: "2024-05-03", cost: { amount: 5, currency: "USD" } } }]);
    expect((await req("POST", "/api/import/calendar:a/accept")).status).toBe(422);
    expect((await (await req("GET", "/api/import/queue")).json()).candidates).toHaveLength(1);
  });
});
