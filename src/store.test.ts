import { describe, expect, it } from "vitest";
import { migratePersisted, modernTripName, useMeridianStore } from "./store";

describe("modernTripName", () => {
  it("rewords the old upper-case defaults", () => {
    expect(modernTripName("TRIP 3")).toBe("Trip 3");
    expect(modernTripName("TRIP 3 COPY")).toBe("Trip 3 (copy)");
    expect(modernTripName("TRIP")).toBe("Trip");
  });
  it("leaves names people typed alone", () => {
    expect(modernTripName("Lisbon weekend")).toBe("Lisbon weekend");
    expect(modernTripName("ROAD TRIP")).toBe("ROAD TRIP");
  });
});

describe("migratePersisted", () => {
  it("keeps trips and the active trip, drops unknown keys", () => {
    const out = migratePersisted(
      {
        trips: [{ id: "t1", name: "TRIP 1", color: "#000", status: "draft", nodes: [] }],
        activeTripId: "t1",
        layers: { trips: true },
        leftDrawerOpen: true,
      },
      0
    );
    expect(Object.keys(out).sort()).toEqual(["activeTripId", "trips"]);
    expect(out.trips[0].name).toBe("Trip 1");
    expect(out.activeTripId).toBe("t1");
  });
  it("drops malformed trips and a dangling active id", () => {
    const out = migratePersisted({ trips: [null, { id: 3 }, { id: "ok", name: "A", nodes: [] }], activeTripId: "gone" }, 0);
    expect(out.trips.map((t) => t.id)).toEqual(["ok"]);
    expect(out.activeTripId).toBeNull();
  });
  it("survives garbage", () => {
    expect(migratePersisted(undefined, 0)).toEqual({ trips: [], activeTripId: null });
    expect(migratePersisted("x", 0)).toEqual({ trips: [], activeTripId: null });
  });
});

describe("trip actions", () => {
  it("names new trips and copies in sentence case", () => {
    const s = useMeridianStore.getState();
    useMeridianStore.setState({ trips: [], activeTripId: null });
    const id = s.createTrip();
    expect(useMeridianStore.getState().trips[0].name).toBe("Trip 1");
    s.duplicateTrip(id);
    expect(useMeridianStore.getState().trips[1].name).toBe("Trip 1 (copy)");
  });
  it("discardCandidate removes one agent suggestion only", () => {
    useMeridianStore.setState({ trips: [], activeTripId: null });
    const s = useMeridianStore.getState();
    const manual = s.createTrip("Mine");
    s.setAgentCandidates([
      { id: "a1", label: "A", nodes: [] },
      { id: "a2", label: "B", nodes: [] },
    ] as never);
    s.discardCandidate("a1");
    s.discardCandidate(manual); // not an agent trip: kept
    expect(useMeridianStore.getState().trips.map((t) => t.id)).toEqual([manual, "a2"]);
  });
});
