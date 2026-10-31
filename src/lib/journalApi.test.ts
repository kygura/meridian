import { afterEach, describe, expect, it, vi } from "vitest";
import { JournalApiError, getFingerprint, getQueue, listAlerts, listWatches, saveJourney, saveSettings } from "./journalApi";
import { useMeridianStore } from "../store";
import type { Journey } from "../types";

const reply = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());

describe("saveJourney", () => {
  it("sends the base version as If-Match on PUT only", async () => {
    const fetchMock = reply(200, { journey: { id: "j1" } });
    vi.stubGlobal("fetch", fetchMock);
    await saveJourney({} as never, "j1", "2024-05-01T00:00:00.000Z");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("If-Match")).toBe("2024-05-01T00:00:00.000Z");
    await saveJourney({} as never);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("If-Match")).toBeNull();
  });
  it("surfaces a stale PUT as a 409", async () => {
    vi.stubGlobal("fetch", reply(409, { error: "conflict" }));
    await expect(saveJourney({} as never, "j1", "old")).rejects.toMatchObject({ status: 409 });
  });
});

describe("404s are real errors", () => {
  it("does not turn a missing route into an empty queue, alert list, watch list or fingerprint", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not_found" }));
    for (const call of [getQueue, listAlerts, listWatches, () => getFingerprint("j1")]) {
      await expect(call()).rejects.toBeInstanceOf(JournalApiError);
    }
  });
});

describe("upsertJourney", () => {
  const j = (id: string) => ({ id }) as Journey;
  it("leaves an unloaded list unloaded", () => {
    useMeridianStore.setState({ journeys: null });
    useMeridianStore.getState().upsertJourney(j("a"));
    expect(useMeridianStore.getState().journeys).toBeNull();
  });
  it("adds and replaces in a loaded list", () => {
    useMeridianStore.setState({ journeys: [j("a")] });
    useMeridianStore.getState().upsertJourney(j("b"));
    useMeridianStore.getState().upsertJourney({ ...j("a"), title: "x" });
    expect(useMeridianStore.getState().journeys?.map((x) => x.id)).toEqual(["a", "b"]);
    expect(useMeridianStore.getState().journeys?.[0].title).toBe("x");
  });
});

describe("saveSettings", () => {
  it("PUTs the home city", async () => {
    const fetchMock = reply(200, { settings: { homeCityId: "lisbon" } });
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveSettings({ homeCityId: "lisbon" })).toEqual({ homeCityId: "lisbon" });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/journal/settings");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT", body: '{"homeCityId":"lisbon"}' });
  });
});
