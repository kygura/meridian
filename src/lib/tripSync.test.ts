import { describe, expect, it } from "vitest";
import type { Trip } from "../types";
import { mergeRemote, pendingChanges, tripFingerprint, type SyncBase } from "./tripSync";

const node = (cityId: string) => ({ cityId, name: cityId, lat: 0, lng: 0 });
const t = (id: string, name = id, extra: Partial<Trip> = {}): Trip => ({
  id,
  name,
  color: "#0f766e",
  status: "draft",
  nodes: [node("lima-peru")],
  origin: "manual",
  ...extra,
});
const baseOf = (...trips: Trip[]): SyncBase => Object.fromEntries(trips.map((x) => [x.id, tripFingerprint(x)]));
const names = (trips: Trip[]) => trips.map((x) => `${x.id}:${x.name}`);

describe("mergeRemote", () => {
  it("first sync: uploads local-only trips and adds remote-only ones", () => {
    const { trips, base } = mergeRemote([t("a")], [{ ...t("b"), updatedAt: "2026-01-01" }], [], {});
    expect(names(trips)).toEqual(["a:a", "b:b"]);
    expect(trips[1]).not.toHaveProperty("updatedAt");
    expect(pendingChanges(trips, base)).toEqual({ put: [trips[0]], del: [] });
  });

  it("takes the server copy unless this browser edited it since the last sync", () => {
    const synced = t("a", "old");
    const remote = [t("a", "theirs"), t("b", "theirs")];
    const local = [t("a", "old"), t("b", "mine")];
    const { trips, base } = mergeRemote(local, remote, [], baseOf(synced, t("b", "old")));
    expect(names(trips)).toEqual(["a:theirs", "b:mine"]);
    expect(pendingChanges(trips, base).put.map((x) => x.id)).toEqual(["b"]);
  });

  it("on a first sync with no base, the server wins on same-id trips", () => {
    const { trips } = mergeRemote([t("a", "mine")], [t("a", "theirs")], [], {});
    expect(names(trips)).toEqual(["a:theirs"]);
  });

  it("drops trips deleted on another device", () => {
    const { trips, base } = mergeRemote([t("a"), t("b")], [t("b")], ["a"], baseOf(t("a"), t("b")));
    expect(names(trips)).toEqual(["b:b"]);
    expect(pendingChanges(trips, base)).toEqual({ put: [], del: [] });
  });

  it("keeps a delete made here while offline and pushes it", () => {
    const { trips, base } = mergeRemote([t("b")], [t("a"), t("b")], [], baseOf(t("a"), t("b")));
    expect(names(trips)).toEqual(["b:b"]);
    expect(pendingChanges(trips, base)).toEqual({ put: [], del: ["a"] });
  });
});

describe("pendingChanges", () => {
  it("pushes season, year and stop-month edits", () => {
    const a = t("a");
    const placed = { ...a, nodes: [{ ...a.nodes[0], months: { start: 2, end: 3 } }] };
    expect(pendingChanges([placed], baseOf(a)).put).toEqual([placed]);
    expect(pendingChanges([{ ...a, year: 2027 }], baseOf(a)).put).toHaveLength(1);
    expect(pendingChanges([{ ...a, season: { start: 7, end: 8 } }], baseOf(a)).put).toHaveLength(1);
  });

  it("ignores fields the server doesn't store", () => {
    const a = t("a");
    expect(pendingChanges([{ ...a, estimate: { priceEstimate: 1, currency: "USD", dateRange: { start: "", end: "" } } }], baseOf(a))).toEqual({ put: [], del: [] });
  });
});
