import { afterEach, describe, expect, it, vi } from "vitest";
import { JournalApiError, JournalLockedError } from "./journalApi";
import {
  addToWishlist,
  atlasTrips,
  getAtlasConfig,
  getAtlasContext,
  getAtlasRuns,
  getAtlasTrips,
  patchAtlasConfig,
  patchWishlistPlace,
  removeWishlistPlace,
  runAtlas,
} from "./atlasApi";
import type { Trip } from "../types";

const reply = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());

const call = (m: ReturnType<typeof reply>, i = 0) => ({ url: m.mock.calls[i][0], init: m.mock.calls[i][1] });

describe("reads", () => {
  it("GETs the context, with an optional date", async () => {
    const m = reply(200, { today: "2026-11-18" });
    vi.stubGlobal("fetch", m);
    await getAtlasContext();
    await getAtlasContext("2026-11-20");
    expect(call(m, 0).url).toBe("/api/atlas/context");
    expect(call(m, 1).url).toBe("/api/atlas/context?today=2026-11-20");
    expect(call(m, 0).init?.credentials).toBe("same-origin");
  });

  it("GETs runs with a limit and unwraps the list", async () => {
    const m = reply(200, { runs: [{ id: "r1" }] });
    vi.stubGlobal("fetch", m);
    expect(await getAtlasRuns(10)).toEqual([{ id: "r1" }]);
    expect(call(m).url).toBe("/api/atlas/runs?limit=10");
  });

  it("GETs the config", async () => {
    const m = reply(200, { config: { a: 1 }, updatedAt: null });
    vi.stubGlobal("fetch", m);
    expect((await getAtlasConfig()).config).toEqual({ a: 1 });
    expect(call(m).url).toBe("/api/atlas/config");
  });

  it("keeps only the atlas trips from /api/trips", async () => {
    const m = reply(200, { trips: [{ id: "atlas-lisbon-2026-12-01" }, { id: "t1" }, { id: "my-atlas-trip" }], deleted: [] });
    vi.stubGlobal("fetch", m);
    expect((await getAtlasTrips()).map((t) => t.id)).toEqual(["atlas-lisbon-2026-12-01"]);
    expect(call(m).url).toBe("/api/trips");
  });

  it("atlasTrips tolerates an empty list", () => {
    expect(atlasTrips([] as Trip[])).toEqual([]);
  });
});

describe("writes", () => {
  it("POSTs a run with the mode, and the text only when given", async () => {
    const m = reply(201, { run: { id: "fire-1", status: "fired" } });
    vi.stubGlobal("fetch", m);
    const run = await runAtlas("scan");
    await runAtlas("scan", "Plan a trip to Lisbon between 2026-12-01 and 2026-12-20");
    expect(run.status).toBe("fired");
    expect(call(m, 0).url).toBe("/api/atlas/run");
    expect(call(m, 0).init).toMatchObject({ method: "POST", body: '{"mode":"scan"}' });
    expect(JSON.parse(String(call(m, 1).init?.body))).toEqual({ mode: "scan", text: "Plan a trip to Lisbon between 2026-12-01 and 2026-12-20" });
  });

  it("a failed fire run is still a 201 with status failed", async () => {
    vi.stubGlobal("fetch", reply(201, { run: { id: "fire-2", status: "failed", detail: "not set" } }));
    expect(await runAtlas("discover")).toMatchObject({ status: "failed", detail: "not set" });
  });

  it("POSTs wishlist entries as { entries }", async () => {
    const m = reply(201, { entries: [], unresolved: [{ place: { query: "x" }, reason: "No city" }] });
    vi.stubGlobal("fetch", m);
    const res = await addToWishlist([{ place: { cityId: "lisbon-pt" }, source: "wished", priority: 4 }]);
    expect(res.unresolved).toHaveLength(1);
    expect(call(m).url).toBe("/api/atlas/wishlist");
    expect(JSON.parse(String(call(m).init?.body))).toEqual({ entries: [{ place: { cityId: "lisbon-pt" }, source: "wished", priority: 4 }] });
  });

  it("PATCHes one place, encoding the id", async () => {
    const m = reply(200, { entry: { cityId: "a/b", priority: 5 } });
    vi.stubGlobal("fetch", m);
    expect((await patchWishlistPlace("a/b", { priority: 5 })).priority).toBe(5);
    expect(call(m).url).toBe("/api/atlas/wishlist/a%2Fb");
    expect(call(m).init).toMatchObject({ method: "PATCH", body: '{"priority":5}' });
  });

  it("sends a null watch to stop watching", async () => {
    const m = reply(200, { entry: { cityId: "x" } });
    vi.stubGlobal("fetch", m);
    await patchWishlistPlace("x", { watch: null });
    expect(call(m).init?.body).toBe('{"watch":null}');
  });

  it("DELETEs a place and returns whether it existed", async () => {
    const m = reply(200, { removed: true });
    vi.stubGlobal("fetch", m);
    expect(await removeWishlistPlace("lisbon-pt")).toBe(true);
    expect(call(m)).toMatchObject({ url: "/api/atlas/wishlist/lisbon-pt", init: { method: "DELETE" } });
  });

  it("PATCHes the config with the given patch only", async () => {
    const m = reply(200, { config: {}, updatedAt: "now" });
    vi.stubGlobal("fetch", m);
    await patchAtlasConfig({ hardFilters: { maxStops: 1 } });
    expect(call(m)).toMatchObject({ url: "/api/atlas/config", init: { method: "PATCH", body: '{"hardFilters":{"maxStops":1}}' } });
    expect(new Headers(call(m).init?.headers).get("Content-Type")).toBe("application/json");
  });
});

describe("errors", () => {
  it("a 400 keeps its issues", async () => {
    vi.stubGlobal("fetch", reply(400, { error: "invalid_config", message: "bad", issues: [{ path: ["hardFilters", "maxStops"], message: "too big" }] }));
    await expect(patchAtlasConfig({ hardFilters: { maxStops: 9 } })).rejects.toMatchObject({ status: 400, issues: [{ message: "too big" }] });
    await expect(patchAtlasConfig({})).rejects.toBeInstanceOf(JournalApiError);
  });

  it("a 401 is a locked session", async () => {
    vi.stubGlobal("fetch", reply(401, { error: "unauthorized" }));
    await expect(getAtlasContext()).rejects.toBeInstanceOf(JournalLockedError);
  });
});
